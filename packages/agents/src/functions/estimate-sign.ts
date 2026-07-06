import { withTenant, eq, sql, estimate, job, customer, property, contractTemplate, recordStageChange } from "@savvy/db";
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
    const [j] = await tx.select().from(job).where(eq(job.id, est.jobId));
    const cust = j?.customerId
      ? (await tx.select().from(customer).where(eq(customer.id, j.customerId)))[0]
      : undefined;
    // Cell 17b: block sending a CO (SB38-gated) estimate contract unless it is on
    // a compliant, versioned template; stamp the resolved template id. Escape
    // valve: a job with no property / a blank state resolves ungated (null id,
    // no gate). Throws ContractTemplateRequiredError (fail-closed) BEFORE the
    // DocuSeal call so a non-compliant CO contract is never sent.
    let contractTemplateId: string | null = null;
    if (j?.propertyId) {
      const [prop] = await tx.select({ state: property.state }).from(property).where(eq(property.id, j.propertyId));
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

/** Marks an estimate accepted and advances its job to `approved` (idempotent). */
export async function advanceJobForAcceptedEstimate(
  tenantId: string,
  estimateId: string,
): Promise<{ jobId: string } | { skipped: string }> {
  return withTenant(tenantId, async (tx) => {
    const [est] = await tx.select().from(estimate).where(eq(estimate.id, estimateId));
    if (!est) return { skipped: "no_estimate" };
    await tx.update(estimate).set({ status: "accepted", acceptedAt: sql`now()` }).where(eq(estimate.id, estimateId));
    const [j] = await tx.select().from(job).where(eq(job.id, est.jobId));
    if (j && j.stage !== "approved") {
      await recordStageChange(tx, { tenantId, jobId: j.id, toStage: "approved" });
      await tx.update(job).set({ valueEstimate: est.total ?? null }).where(eq(job.id, j.id));
    }
    return { jobId: est.jobId };
  });
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
