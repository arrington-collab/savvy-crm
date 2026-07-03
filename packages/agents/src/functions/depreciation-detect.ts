import { withTenant, invoice, eq, detectDepreciationRecovery } from "@savvy/db";
import { inngest } from "../client";

/**
 * When an invoice is paid, an insurance job reaches completion — kick off the
 * depreciation-recovery workflow (§G): detect recoverable depreciation and generate
 * the office-staff Xactimate/recovery-invoice task. Retail jobs and jobs with no
 * recoverable depreciation are skipped inside detectDepreciationRecovery. Idempotent.
 */
export async function detectDepreciationForPaidInvoice(
  tenantId: string,
  invoiceId: string,
): Promise<{ created: string; depreciationCents: number } | { skipped: string }> {
  const jobId = await withTenant(tenantId, async (tx) => {
    const [inv] = await tx.select({ jobId: invoice.jobId }).from(invoice).where(eq(invoice.id, invoiceId));
    return inv?.jobId ?? null;
  });
  if (!jobId) return { skipped: "no_invoice" };
  return detectDepreciationRecovery({ tenantId, jobId });
}

export const insuranceDepreciationDetect = inngest.createFunction(
  { id: "insurance-depreciation-detect", concurrency: { limit: 5 } },
  { event: "invoice/paid" },
  async ({ event, step }) => step.run("detect", () => detectDepreciationForPaidInvoice(event.data.tenantId, event.data.invoiceId)),
);
