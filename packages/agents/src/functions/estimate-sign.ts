import { withTenant, eq, sql, estimate, job, lead, customer, property, contractTemplate, recordStageChange, convertLeadToJob } from "@savvy/db";
import { httpDocuseal, makeFakeDocuseal, type DocusealGateway } from "@savvy/integrations";
import { resolveOrThrowContractTemplate } from "@savvy/core";
import { inngest } from "../client";

/** Real gateway when DocuSeal is configured; fake (fail-soft) otherwise (dev/e2e). */
function defaultDocuseal(): DocusealGateway {
  return process.env.DOCUSEAL_API_KEY ? httpDocuseal : makeFakeDocuseal();
}

/**
 * Creates a DocuSeal submission for an estimate and flips it to `sent`.
 * Gateway is injectable so tests can pass `makeFakeDocuseal()`.
 */
export async function createEstimateSubmission(
  tenantId: string,
  estimateId: string,
  gateway: DocusealGateway = defaultDocuseal(),
): Promise<{ submissionId: string } | { skipped: true }> {
  return withTenant(tenantId, async (tx) => {
    const [est] = await tx.select().from(estimate).where(eq(estimate.id, estimateId));
    if (!est || est.status === "accepted") return { skipped: true as const };
    // Resolve customer + property from the job (post-acceptance / legacy) or, for a
    // lead-stage estimate, from the lead. property drives the Cell 17b template gate.
    const [j] = est.jobId ? await tx.select().from(job).where(eq(job.id, est.jobId)) : [undefined];
    const [ld] = est.leadId ? await tx.select().from(lead).where(eq(lead.id, est.leadId)) : [undefined];
    const customerId = j?.customerId ?? ld?.customerId ?? null;
    const propertyId = est.propertyId ?? j?.propertyId ?? ld?.propertyId ?? null;
    const cust = customerId
      ? (await tx.select().from(customer).where(eq(customer.id, customerId)))[0]
      : undefined;
    // Cell 17b: block sending a CO (SB38-gated) estimate contract unless it is on
    // a compliant, versioned template; stamp the resolved template id. Escape
    // valve: no property / a blank state resolves ungated (null id, no gate).
    // Throws ContractTemplateRequiredError (fail-closed) BEFORE the DocuSeal call
    // so a non-compliant CO contract is never sent.
    let contractTemplateId: string | null = null;
    if (propertyId) {
      const [prop] = await tx.select({ state: property.state }).from(property).where(eq(property.id, propertyId));
      const templates = await tx
        .select({
          id: contractTemplate.id,
          state: contractTemplate.state,
          version: contractTemplate.version,
          clauses: contractTemplate.clauses,
          status: contractTemplate.status,
        })
        .from(contractTemplate)
        .where(eq(contractTemplate.tenantId, tenantId));
      contractTemplateId = resolveOrThrowContractTemplate(
        templates as { id: string; state: string; version: number; clauses: string[]; status: string }[],
        prop?.state ?? null,
      );
    }
    const { submissionId } = await gateway.createSubmission({
      estimateId,
      signerEmail: cust?.email ?? "",
      total: est.total ?? 0,
    });
    await tx
      .update(estimate)
      .set({ status: "sent", sentAt: sql`now()`, docusealSubmissionId: submissionId, contractTemplateId })
      .where(eq(estimate.id, estimateId));
    return { submissionId };
  });
}

/**
 * Marks an estimate accepted and advances its job to `approved` (idempotent).
 * For a lead-stage estimate (no job yet), acceptance is what CREATES the job —
 * convertLeadToJob carries this now-accepted estimate onto the new job.
 */
export async function advanceJobForAcceptedEstimate(
  tenantId: string,
  estimateId: string,
): Promise<{ jobId: string } | { skipped: string }> {
  // Step 1: mark accepted first, so the convert gate below finds an accepted
  // estimate on the lead.
  const est = await withTenant(tenantId, async (tx) => {
    const [e] = await tx.select().from(estimate).where(eq(estimate.id, estimateId));
    if (!e) return null;
    await tx.update(estimate).set({ status: "accepted", acceptedAt: sql`now()` }).where(eq(estimate.id, estimateId));
    return e;
  });
  if (!est) return { skipped: "no_estimate" };

  // Step 2: resolve the job — a lead-stage estimate creates it on acceptance.
  let jobId = est.jobId;
  if (!jobId) {
    if (!est.leadId) return { skipped: "no_job_or_lead" };
    const conv = await convertLeadToJob({ tenantId, leadId: est.leadId });
    jobId = conv.jobId;
  }

  // Step 3: advance the job to approved + stamp value (idempotent).
  await withTenant(tenantId, async (tx) => {
    const [j] = await tx.select().from(job).where(eq(job.id, jobId!));
    if (j && j.stage !== "approved") {
      await recordStageChange(tx, { tenantId, jobId: j.id, toStage: "approved" });
      await tx.update(job).set({ valueEstimate: est.total ?? null }).where(eq(job.id, j.id));
    }
  });
  return { jobId };
}

export const sendEstimateForSignature = inngest.createFunction(
  { id: "send-estimate-for-signature", concurrency: { limit: 5 }, retries: 3 },
  { event: "estimate/send.requested" },
  async ({ event, step }) =>
    step.run("create-submission", () => createEstimateSubmission(event.data.tenantId, event.data.estimateId)),
);

export const estimateAcceptedAdvanceJob = inngest.createFunction(
  { id: "estimate-accepted-advance-job", concurrency: { limit: 5 } },
  { event: "estimate/accepted" },
  async ({ event, step }) =>
    step.run("advance", () => advanceJobForAcceptedEstimate(event.data.tenantId, event.data.estimateId)),
);
