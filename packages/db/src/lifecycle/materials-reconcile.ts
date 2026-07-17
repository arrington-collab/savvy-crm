import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  parseProcurementConfig,
  reconcileMaterialLines,
  type MaterialOrderLine,
  type SupplierInvoiceLine,
  type ReconcileResult,
} from "@savvy/core";
import { withTenant } from "../tenant";
import { adminDb } from "../admin-client";
import { materialLeftover, materialReconciliation, materialReturn } from "../schema/materials";
import { materialOrder } from "../schema/procurement";
import { supplierInvoice } from "../schema/supplier-invoice";
import { priceBookItem } from "../schema/pricing";
import { job } from "../schema/jobs";
import { tenant as tenantTbl } from "../schema/tenancy";
import { createCreditRequest } from "./credit-request";

/** Manual leftover entry (the card) or the photo-parse upgrade path. Corrections overwrite. */
export async function upsertMaterialLeftover(
  tenantId: string,
  input: { jobId: string; itemKey: string; quantity: number; source: "manual" | "photo_parse"; name?: string; unit?: string; documentId?: string; createdByUserId?: string | null },
): Promise<void> {
  await withTenant(tenantId, (tx) =>
    tx.insert(materialLeftover).values({
      tenantId, jobId: input.jobId, itemKey: input.itemKey, quantity: input.quantity,
      source: input.source, name: input.name ?? null, unit: input.unit ?? null,
      documentId: input.documentId ?? null, createdByUserId: input.createdByUserId ?? null,
    }).onConflictDoUpdate({
      target: [materialLeftover.tenantId, materialLeftover.jobId, materialLeftover.itemKey],
      set: { quantity: input.quantity, source: input.source, documentId: input.documentId ?? null },
    }),
  );
}

/** The crew's explicit "nothing left over" — clears the prompt without inventing rows. */
export async function confirmNoLeftovers(tenantId: string, input: { jobId: string }): Promise<void> {
  await withTenant(tenantId, (tx) =>
    tx.insert(materialReconciliation)
      .values({ tenantId, jobId: input.jobId, lines: [], leftoversConfirmedAt: new Date() })
      .onConflictDoUpdate({
        target: [materialReconciliation.tenantId, materialReconciliation.jobId],
        set: { leftoversConfirmedAt: new Date() },
      }),
  );
}

/**
 * Ordered (PO) vs invoiced (parsed actuals) vs used (invoiced − leftover),
 * snapshotted per job. Variance beyond the config threshold flags the job
 * (feeds the waste-factor review). RETURNABLE leftovers become return tasks
 * with an expected credit (supplier cost minus restocking) chased through the
 * price-guard credit machinery; non-returnable leftovers NEVER do (red path).
 * Idempotent — replays update the snapshot and skip existing returns.
 */
export async function reconcileJobMaterials(
  tenantId: string,
  input: { jobId: string; now?: Date },
): Promise<ReconcileResult> {
  const now = input.now ?? new Date();
  const [t] = await adminDb.select({ settings: tenantTbl.settings }).from(tenantTbl).where(eq(tenantTbl.id, tenantId));
  const cfg = parseProcurementConfig((t?.settings as { procurement?: unknown } | null)?.procurement);

  return withTenant(tenantId, async (tx) => {
    const orders = await tx.select({ lineItems: materialOrder.lineItems }).from(materialOrder)
      .where(and(
        eq(materialOrder.tenantId, tenantId), eq(materialOrder.jobId, input.jobId),
        inArray(materialOrder.status, ["ordered", "delivered"]),
      ));
    const ordered = orders.flatMap((o) => (o.lineItems as MaterialOrderLine[]) ?? []);

    const invoices = await tx.select({ id: supplierInvoice.id, supplierName: supplierInvoice.supplierName, lines: supplierInvoice.lines })
      .from(supplierInvoice)
      .where(and(
        eq(supplierInvoice.tenantId, tenantId), eq(supplierInvoice.jobId, input.jobId),
        inArray(supplierInvoice.status, ["parsed", "guarded"]),
      ))
      .orderBy(desc(supplierInvoice.createdAt));
    const invoiced = invoices.flatMap((i) =>
      ((i.lines as SupplierInvoiceLine[]) ?? [])
        .filter((l) => l.matchedItemKey)
        .map((l) => ({ key: l.matchedItemKey!, quantity: l.quantity })),
    );

    const leftovers = await tx.select().from(materialLeftover)
      .where(and(eq(materialLeftover.tenantId, tenantId), eq(materialLeftover.jobId, input.jobId)));

    const result = reconcileMaterialLines(
      {
        ordered: ordered.map((l) => ({ key: l.key, name: l.name, quantity: l.quantity, unitCostCents: l.unitCostCents ?? null })),
        invoiced,
        leftover: leftovers.map((l) => ({ key: l.itemKey, quantity: l.quantity })),
      },
      cfg.varianceThresholdPct,
    );

    await tx.insert(materialReconciliation)
      .values({ tenantId, jobId: input.jobId, lines: result.lines, flagged: result.flagged, computedAt: now })
      .onConflictDoUpdate({
        target: [materialReconciliation.tenantId, materialReconciliation.jobId],
        set: { lines: result.lines, flagged: result.flagged, computedAt: now },
      });

    // Returns for RETURNABLE leftovers only.
    if (leftovers.length > 0) {
      const keys = leftovers.map((l) => l.itemKey);
      const bookRows = await tx.select({ key: priceBookItem.key, returnable: priceBookItem.returnable, restockingFeePct: priceBookItem.restockingFeePct, unitCostCents: priceBookItem.unitCostCents, name: priceBookItem.name })
        .from(priceBookItem)
        .where(and(eq(priceBookItem.tenantId, tenantId), inArray(priceBookItem.key, keys)));
      const book = new Map(bookRows.map((b) => [b.key, b]));

      for (const l of leftovers) {
        const item = book.get(l.itemKey);
        if (!item?.returnable || l.quantity <= 0) continue; // red path: non-returnable never returns
        const orderedLine = ordered.find((o) => o.key === l.itemKey);
        const unitCost = orderedLine?.unitCostCents ?? item.unitCostCents;
        const feePct = item.restockingFeePct ?? cfg.restockingFeePct;
        const expectedCreditCents = Math.round(l.quantity * unitCost * (1 - feePct / 100));

        const inserted = await tx.insert(materialReturn).values({
          tenantId, jobId: input.jobId, itemKey: l.itemKey, name: l.name ?? item.name,
          quantity: l.quantity, expectedCreditCents,
        }).onConflictDoNothing().returning({ id: materialReturn.id });
        const returnId = inserted[0]?.id;
        if (!returnId) continue; // replay — return already exists

        // Chase through the price-guard machinery when a supplier invoice anchors it.
        const anchor = invoices[0];
        if (anchor) {
          const { id: creditRequestId } = await createCreditRequest(tenantId, {
            supplierInvoiceId: anchor.id, jobId: input.jobId, supplierName: anchor.supplierName,
            claimedCents: expectedCreditCents, status: "drafted",
            evidence: { kind: "material_return", itemKey: l.itemKey, quantity: l.quantity, expectedCreditCents },
          });
          await tx.update(materialReturn).set({ creditRequestId }).where(eq(materialReturn.id, returnId));
        }
      }
    }

    return result;
  });
}

/** Jobs with delivered materials and neither a leftover entry nor an explicit "none" — the prompt card list. */
export async function dueLeftoverPrompts(tenantId: string): Promise<Array<{ jobId: string }>> {
  return withTenant(tenantId, (tx) =>
    tx.selectDistinct({ jobId: materialOrder.jobId }).from(materialOrder)
      .where(and(
        eq(materialOrder.tenantId, tenantId),
        eq(materialOrder.status, "delivered"),
        sql`not exists (select 1 from ${materialLeftover} ml where ml.job_id = ${materialOrder.jobId})`,
        sql`not exists (select 1 from ${materialReconciliation} mr where mr.job_id = ${materialOrder.jobId} and mr.leftovers_confirmed_at is not null)`,
      )),
  );
}

/** Human resolution: credited (with the real recovered amount) or written off. */
export async function resolveMaterialReturn(
  tenantId: string,
  input: { returnId: string; outcome: "credited" | "written_off"; recoveredCents?: number },
): Promise<{ resolved: boolean }> {
  return withTenant(tenantId, async (tx) => {
    const [row] = await tx.update(materialReturn)
      .set({
        status: input.outcome,
        recoveredCents: input.outcome === "credited" ? (input.recoveredCents ?? 0) : 0,
        resolvedAt: new Date(),
      })
      .where(and(
        eq(materialReturn.tenantId, tenantId), eq(materialReturn.id, input.returnId),
        eq(materialReturn.status, "pending_pickup"),
      )).returning({ id: materialReturn.id });
    return { resolved: !!row };
  });
}
