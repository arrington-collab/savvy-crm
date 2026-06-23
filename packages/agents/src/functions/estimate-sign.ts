import { withTenant, eq, sql, estimate, job, customer, recordStageChange } from "@savvy/db";
import { httpDocuseal, makeFakeDocuseal, type DocusealGateway } from "@savvy/integrations";
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
    const { submissionId } = await gateway.createSubmission({
      estimateId,
      signerEmail: cust?.email ?? "",
      total: est.total ?? 0,
    });
    await tx
      .update(estimate)
      .set({ status: "sent", sentAt: sql`now()`, docusealSubmissionId: submissionId })
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
