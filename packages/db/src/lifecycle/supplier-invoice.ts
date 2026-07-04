import { and, eq, gt, inArray, sql } from "drizzle-orm";
import { selectJobCost, type SupplierInvoiceLine } from "@savvy/core";
import { withTenant } from "../tenant.js";
import { job, materialOrder, supplierInvoice } from "../schema/index.js";

/** Recompute job.costCents from parsed supplier-invoice actuals, falling back to the material-order estimate. */
export async function recomputeJobActualCost(tenantId: string, jobId: string): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    const [actuals] = await tx
      .select({ total: sql<number>`coalesce(sum(${supplierInvoice.totalCents}), 0)::int` })
      .from(supplierInvoice)
      .where(and(eq(supplierInvoice.jobId, jobId), eq(supplierInvoice.status, "parsed"), gt(supplierInvoice.totalCents, 0)));
    const [estimate] = await tx
      .select({ total: sql<number>`coalesce(sum(${materialOrder.costSubtotalCents}), 0)::int` })
      .from(materialOrder)
      .where(and(eq(materialOrder.jobId, jobId), inArray(materialOrder.status, ["ordered", "delivered"])));
    const costCents = selectJobCost({ actualsCents: actuals?.total ?? 0, estimateCents: estimate?.total ?? 0 });
    await tx.update(job).set({ costCents }).where(eq(job.id, jobId));
  });
}

/** Persist a parsed invoice: fields + lines + matched job + status=parsed. */
export async function saveParsedSupplierInvoice(
  tenantId: string,
  id: string,
  parsed: { supplierName: string | null; invoiceNumber: string | null; invoiceDate: Date | null; totalCents: number; lines: SupplierInvoiceLine[]; confidence: number; jobId: string | null },
): Promise<void> {
  await withTenant(tenantId, (tx) =>
    tx.update(supplierInvoice).set({
      supplierName: parsed.supplierName, invoiceNumber: parsed.invoiceNumber, invoiceDate: parsed.invoiceDate,
      totalCents: parsed.totalCents, lines: parsed.lines, parseConfidence: parsed.confidence,
      jobId: parsed.jobId, status: "parsed", updatedAt: new Date(),
    }).where(eq(supplierInvoice.id, id)),
  );
}
