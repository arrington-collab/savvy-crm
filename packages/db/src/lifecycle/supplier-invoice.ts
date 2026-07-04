import { and, eq, gt, inArray, sql } from "drizzle-orm";
import { selectJobCost, type SupplierInvoiceLine } from "@savvy/core";
import { withTenant } from "../tenant.js";
import { document, job, materialOrder, supplierInvoice } from "../schema/index.js";

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

/** Look up a document's R2 storage key within the tenant. Null when missing/unset. */
export async function getDocumentR2Key(tenantId: string, documentId: string): Promise<string | null> {
  const [row] = await withTenant(tenantId, (tx) =>
    tx.select({ r2Key: document.r2Key }).from(document).where(eq(document.id, documentId)),
  );
  return row?.r2Key ?? null;
}

/** Mark a supplier invoice as parse_failed (fail-soft path — never blocks the queue). */
export async function markSupplierInvoiceParseFailed(tenantId: string, id: string): Promise<void> {
  await withTenant(tenantId, (tx) =>
    tx.update(supplierInvoice).set({ status: "parse_failed", updatedAt: new Date() }).where(eq(supplierInvoice.id, id)),
  );
}

/**
 * Match a parsed supplier invoice to a job. Slice-13b deterministic baseline:
 * if the tenant has exactly ONE job with an open material order (ordered/delivered),
 * that's the bill's job; otherwise return null → "unmatched supplier invoice"
 * (surfaces in Today). Richer PO-ref / property-address / AI-assisted matching
 * (using `parsed`) lands in 13c — the `parsed` arg is accepted now for that.
 */
export async function matchSupplierInvoiceJob(
  tenantId: string,
  _parsed: { supplierName: string | null; [k: string]: unknown },
): Promise<string | null> {
  const rows = await withTenant(tenantId, (tx) =>
    tx.selectDistinct({ jobId: materialOrder.jobId })
      .from(materialOrder)
      .where(inArray(materialOrder.status, ["ordered", "delivered"])),
  );
  return rows.length === 1 ? rows[0]!.jobId : null;
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
