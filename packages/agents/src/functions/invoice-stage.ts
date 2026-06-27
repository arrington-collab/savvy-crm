import { withTenant, invoice, job, eq, recordStageChange } from "@savvy/db";
import { JOB_STAGE, type JobStage } from "@savvy/core";
import { inngest } from "../client";

/**
 * Advance a job's stage from an invoice event. Forward-only (never regress),
 * idempotent (recordStageChange no-ops re-fires), and gate-aware: a move to
 * `complete` that fails the close-out photo gate leaves the job in place.
 */
export async function syncInvoiceStage(
  tenantId: string,
  invoiceId: string,
  toStage: JobStage,
): Promise<{ jobId: string; toStage: JobStage } | { skipped: string }> {
  return withTenant(tenantId, async (tx) => {
    const [inv] = await tx.select().from(invoice).where(eq(invoice.id, invoiceId));
    if (!inv) return { skipped: "no_invoice" };
    const [j] = await tx.select().from(job).where(eq(job.id, inv.jobId));
    if (!j) return { skipped: "no_job" };

    // forward-only: target must be strictly ahead of the current stage
    if (JOB_STAGE.indexOf(toStage) <= JOB_STAGE.indexOf(j.stage as JobStage)) {
      return { skipped: "not_forward" };
    }

    try {
      await recordStageChange(tx, { tenantId, jobId: j.id, toStage, byAgent: "orchestrator" });
    } catch (e) {
      // close-out photo gate unmet on the move to `complete` — leave the job in billing
      if (e instanceof Error && e.name === "IncompletePhotosError") return { skipped: "photo_gate" };
      throw e;
    }
    return { jobId: j.id, toStage };
  });
}

export const invoiceSentToBilling = inngest.createFunction(
  { id: "invoice-sent-to-billing", concurrency: { limit: 5 } },
  { event: "invoice/sent" },
  async ({ event, step }) => step.run("sync", () => syncInvoiceStage(event.data.tenantId, event.data.invoiceId, "billing")),
);

export const invoicePaidToComplete = inngest.createFunction(
  { id: "invoice-paid-to-complete", concurrency: { limit: 5 } },
  { event: "invoice/paid" },
  async ({ event, step }) => step.run("sync", () => syncInvoiceStage(event.data.tenantId, event.data.invoiceId, "complete")),
);
