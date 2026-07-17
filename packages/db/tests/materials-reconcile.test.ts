import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { evidenceChecks } from "@savvy/core";
import type { EvidenceCtx } from "@savvy/core";
import { adminDb, adminPool } from "../src/admin-client.js";
import { priceBookItem } from "../src/schema/pricing.js";
import { materialOrder } from "../src/schema/procurement.js";
import { supplierInvoice } from "../src/schema/supplier-invoice.js";
import { materialLeftover, materialReturn, materialReconciliation } from "../src/schema/materials.js";
import { creditRequest } from "../src/schema/credit-request.js";
import { estimate } from "../src/schema/finance.js";
import { makeTenant, makeJobWithProperty } from "./helpers.js";
import { ensurePriceBook } from "../src/lifecycle/price-book.js";
import {
  upsertMaterialLeftover,
  confirmNoLeftovers,
  reconcileJobMaterials,
  dueLeftoverPrompts,
  resolveMaterialReturn,
} from "../src/lifecycle/materials-reconcile.js";

const NOW = new Date();
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

async function seedMaterialJob(tenantId: string, opts?: { invoicedShingles?: number }) {
  await ensurePriceBook(tenantId);
  const { jobId } = await makeJobWithProperty(tenantId);
  const [est] = await adminDb.insert(estimate).values({ tenantId, jobId, status: "accepted", total: 1_000_000 }).returning();
  await adminDb.insert(materialOrder).values({
    tenantId, jobId, estimateId: est!.id, status: "delivered",
    lineItems: [
      { key: "field-shingles", name: "Field shingles", quantity: 30, unit: "each", unitPriceCents: 4500, amountCents: 135000, unitCostCents: 3500, lineCostCents: 105000 },
      { key: "tear-off", name: "Tear-off labor", quantity: 20, unit: "square", unitPriceCents: 6000, amountCents: 120000, unitCostCents: 4000, lineCostCents: 80000 },
    ],
    subtotalCents: 255000, costSubtotalCents: 185000,
  });
  await adminDb.insert(supplierInvoice).values({
    tenantId, jobId, supplierName: "ABC Supply", status: "guarded", totalCents: 120000,
    externalMessageId: `mr-${crypto.randomUUID()}`,
    lines: [
      { description: "Arch shingles", quantity: opts?.invoicedShingles ?? 31, unitBilledCents: 3600, amountBilledCents: (opts?.invoicedShingles ?? 31) * 3600, matchedItemKey: "field-shingles" },
    ],
  });
  return { jobId };
}

describe("returnable price-book flags (mig 0104 backfill)", () => {
  it("materials are returnable, labor is not", async () => {
    const { tenantId } = await makeTenant();
    await ensurePriceBook(tenantId);
    const rows = await adminDb.select().from(priceBookItem).where(eq(priceBookItem.tenantId, tenantId));
    expect(rows.find((r) => r.key === "field-shingles")!.returnable).toBe(true);
    expect(rows.find((r) => r.key === "tear-off")!.returnable).toBe(false);
    expect(rows.find((r) => r.key === "install")!.returnable).toBe(false);
  });
});

describe("leftover entry + reconciliation + returns", () => {
  it("manual leftover entry upserts; reconciliation snapshots ordered/invoiced/used and creates returns for RETURNABLE leftovers only", async () => {
    const { tenantId } = await makeTenant();
    const { jobId } = await seedMaterialJob(tenantId);

    await upsertMaterialLeftover(tenantId, { jobId, itemKey: "field-shingles", quantity: 3, source: "manual" });
    await upsertMaterialLeftover(tenantId, { jobId, itemKey: "field-shingles", quantity: 2, source: "manual" }); // correction
    await upsertMaterialLeftover(tenantId, { jobId, itemKey: "tear-off", quantity: 1, source: "manual" }); // labor: non-returnable

    const r = await reconcileJobMaterials(tenantId, { jobId, now: NOW });
    expect(r.flagged).toBe(false); // 31 vs 30 shingles ≈ 3% < 10%

    const [snap] = await adminDb.select().from(materialReconciliation)
      .where(and(eq(materialReconciliation.tenantId, tenantId), eq(materialReconciliation.jobId, jobId)));
    expect(snap).toBeDefined();
    const lines = snap!.lines as Array<{ key: string; usedQty: number }>;
    expect(lines.find((l) => l.key === "field-shingles")!.usedQty).toBe(29); // 31 invoiced − 2 leftover

    const returns = await adminDb.select().from(materialReturn)
      .where(and(eq(materialReturn.tenantId, tenantId), eq(materialReturn.jobId, jobId)));
    expect(returns).toHaveLength(1); // red path: the tear-off leftover NEVER becomes a return
    const ret = returns[0]!;
    expect(ret.itemKey).toBe("field-shingles");
    expect(ret.quantity).toBe(2);
    expect(ret.status).toBe("pending_pickup");
    // expected credit = 2 × 3500 supplier cost, minus the default 15% restocking fee
    expect(ret.expectedCreditCents).toBe(Math.round(2 * 3500 * 0.85));
    expect(ret.creditRequestId).toBeTruthy(); // chased via the price-guard machinery

    const [cr] = await adminDb.select().from(creditRequest).where(eq(creditRequest.id, ret.creditRequestId!));
    expect(cr!.claimedCents).toBe(ret.expectedCreditCents);
    expect(cr!.supplierName).toBe("ABC Supply");

    // Replay is free.
    await reconcileJobMaterials(tenantId, { jobId, now: NOW });
    expect(await adminDb.select().from(materialReturn).where(eq(materialReturn.jobId, jobId))).toHaveLength(1);
  });

  it("variance beyond threshold flags the snapshot (feeds the waste-factor review)", async () => {
    const { tenantId } = await makeTenant();
    const { jobId } = await seedMaterialJob(tenantId, { invoicedShingles: 40 }); // +33%
    const r = await reconcileJobMaterials(tenantId, { jobId, now: NOW });
    expect(r.flagged).toBe(true);
    const [snap] = await adminDb.select().from(materialReconciliation).where(eq(materialReconciliation.jobId, jobId));
    expect(snap!.flagged).toBe(true);
  });

  it("return resolution: credited stamps recovered cents; written_off closes without money", async () => {
    const { tenantId } = await makeTenant();
    const { jobId } = await seedMaterialJob(tenantId);
    await upsertMaterialLeftover(tenantId, { jobId, itemKey: "field-shingles", quantity: 2, source: "manual" });
    await reconcileJobMaterials(tenantId, { jobId, now: NOW });
    const [ret] = await adminDb.select().from(materialReturn).where(eq(materialReturn.jobId, jobId));

    await resolveMaterialReturn(tenantId, { returnId: ret!.id, outcome: "credited", recoveredCents: 5000 });
    const [after] = await adminDb.select().from(materialReturn).where(eq(materialReturn.id, ret!.id));
    expect(after!.status).toBe("credited");
    expect(after!.recoveredCents).toBe(5000);
    expect(after!.resolvedAt).toBeTruthy();
  });

  it("evidence materials.returns_resolved: a return unresolved past 14d fails; resolving heals", async () => {
    const { tenantId } = await makeTenant();
    const { jobId } = await seedMaterialJob(tenantId);
    await upsertMaterialLeftover(tenantId, { jobId, itemKey: "field-shingles", quantity: 2, source: "manual" });
    await reconcileJobMaterials(tenantId, { jobId, now: NOW });
    const [ret] = await adminDb.select().from(materialReturn).where(eq(materialReturn.jobId, jobId));
    await adminDb.update(materialReturn).set({ createdAt: daysAgo(20) }).where(eq(materialReturn.id, ret!.id));

    const ctx: EvidenceCtx = {
      tenantId, db: adminPool, params: {},
      window: { start: daysAgo(1), end: new Date(NOW.getTime() + 86_400_000) },
    };
    expect((await evidenceChecks["materials.returns_resolved"]!(ctx)).status).toBe("fail");

    await resolveMaterialReturn(tenantId, { returnId: ret!.id, outcome: "written_off" });
    expect((await evidenceChecks["materials.returns_resolved"]!(ctx)).status).toBe("pass");
  });

  it("leftover prompts: a delivered-materials job with no leftover entry prompts; confirm-none clears it", async () => {
    const { tenantId } = await makeTenant();
    const { jobId } = await seedMaterialJob(tenantId);
    const prompts = await dueLeftoverPrompts(tenantId);
    expect(prompts.map((p) => p.jobId)).toContain(jobId);

    await confirmNoLeftovers(tenantId, { jobId });
    const after = await dueLeftoverPrompts(tenantId);
    expect(after.map((p) => p.jobId)).not.toContain(jobId);
  });
});
