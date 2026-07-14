import { describe, it, expect } from "vitest";
import { adminDb, customer, property, job, document, eq } from "../src/index.js";
import {
  ensureProductionPhaseTemplates, instantiateProductionPhases, ingestProductionMedia,
} from "../src/lifecycle/production-phase.js";
import {
  setPhotoCustomerSafe, doubleGatedPhotosForPhase,
  recordProductionUpdate, countUpdatesSentToday, hoUpdateGaps, deliveryNoticeGaps,
} from "../src/lifecycle/production-updates.js";
import { makeTenant } from "./helpers.js";

async function seedJob() {
  const { tenantId } = await makeTenant();
  await ensureProductionPhaseTemplates(tenantId);
  const [c] = await adminDb.insert(customer).values({ tenantId, name: "Update Cust", phone: "+16025550999" }).returning();
  const [p] = await adminDb.insert(property).values({ tenantId, customerId: c!.id, address: "8 Update Way" }).returning();
  const [j] = await adminDb.insert(job).values({ tenantId, customerId: c!.id, propertyId: p!.id, type: "repair", stage: "production" }).returning();
  await instantiateProductionPhases({ tenantId, jobId: j!.id });
  return { tenantId, customerId: c!.id, jobId: j!.id };
}

async function seedPhoto(tenantId: string, jobId: string, opts: { qc?: string; safe?: boolean } = {}) {
  const [d] = await adminDb.insert(document).values({
    tenantId, jobId, kind: "photo", source: "sitesnap",
    sitesnapPhotoId: `ss-${crypto.randomUUID()}`, qcStatus: opts.qc ?? "passed",
  }).returning();
  if (opts.safe) await setPhotoCustomerSafe({ tenantId, documentId: d!.id, safe: true });
  return d!.id;
}

describe("the customer-safe flag — sacred, and independent of QC", () => {
  it("set/unset is idempotent inside sharedWith", async () => {
    const { tenantId, jobId } = await seedJob();
    const doc = await seedPhoto(tenantId, jobId);
    await setPhotoCustomerSafe({ tenantId, documentId: doc, safe: true });
    await setPhotoCustomerSafe({ tenantId, documentId: doc, safe: true });
    let [row] = await adminDb.select({ sharedWith: document.sharedWith }).from(document).where(eq(document.id, doc));
    expect(row!.sharedWith).toEqual(["homeowner"]);

    await setPhotoCustomerSafe({ tenantId, documentId: doc, safe: false });
    [row] = await adminDb.select({ sharedWith: document.sharedWith }).from(document).where(eq(document.id, doc));
    expect(row!.sharedWith).toEqual([]);
  });

  it("doubleGatedPhotosForPhase returns ONLY photos that are BOTH QC-passed AND customer-safe", async () => {
    const { tenantId, jobId } = await seedJob();
    const safePassed = await seedPhoto(tenantId, jobId, { qc: "passed", safe: true });
    const unsafePassed = await seedPhoto(tenantId, jobId, { qc: "passed", safe: false });
    const safeFlagged = await seedPhoto(tenantId, jobId, { qc: "flagged", safe: true });
    for (const d of [safePassed, unsafePassed, safeFlagged]) {
      await ingestProductionMedia({ tenantId, jobId, phaseKey: "repair_work", documentId: d, shot: null });
    }
    const gated = await doubleGatedPhotosForPhase({ tenantId, jobId, phaseKey: "repair_work", limit: 3 });
    expect(gated.map((g) => g.documentId)).toEqual([safePassed]);
  });
});

describe("the update ledger — every send or suppression is a row", () => {
  it("records sends + suppressions; the daily throttle counts only SENT updates", async () => {
    const { tenantId, jobId } = await seedJob();
    await recordProductionUpdate({ tenantId, jobId, kind: "phase_complete", phaseKey: "repair_work", body: "done!", photoIds: [], sentAt: new Date() });
    await recordProductionUpdate({ tenantId, jobId, kind: "phase_complete", phaseKey: "cleanup", suppressedReason: "quiet_hours" });

    expect(await countUpdatesSentToday({ tenantId, jobId })).toBe(1);
  });

  it("production.ho_updates evidence: customer-visible DONE phases without a ledger row are the gap set", async () => {
    const { tenantId, jobId } = await seedJob();
    // Complete repair_work (customer-visible) with evidence.
    for (const shot of ["before", null, "after"] as const) {
      await ingestProductionMedia({ tenantId, jobId, phaseKey: "repair_work", documentId: await seedPhoto(tenantId, jobId), shot });
    }
    let gaps = await hoUpdateGaps(tenantId);
    expect(gaps).toEqual([{ jobId, phaseKey: "repair_work" }]);

    await recordProductionUpdate({ tenantId, jobId, kind: "phase_complete", phaseKey: "repair_work", suppressedReason: "no_phone" });
    gaps = await hoUpdateGaps(tenantId);
    expect(gaps).toEqual([]); // a LOGGED suppression satisfies the evidence
  });

  it("production.delivery_notice evidence: a delivered order needs both sends (or suppressions) logged", async () => {
    const { tenantId, jobId } = await seedJob();
    const { materialOrder, estimate, job: jobTbl } = await import("../src/index.js");
    const [j] = await adminDb.select({ propertyId: jobTbl.propertyId }).from(jobTbl).where(eq(jobTbl.id, jobId));
    const [est] = await adminDb.insert(estimate).values({
      tenantId, jobId, propertyId: j!.propertyId, status: "accepted", lineItems: [], subtotal: 0, tax: 0, total: 0,
    }).returning();
    await adminDb.insert(materialOrder).values({
      tenantId, jobId, estimateId: est!.id, status: "ordered", neededByAt: new Date(Date.now() + 2 * 86_400_000),
    });
    let gaps = await deliveryNoticeGaps(tenantId);
    expect(gaps).toEqual([{ jobId, missing: ["delivery_3day", "delivery_eve"] }]);

    await recordProductionUpdate({ tenantId, jobId, kind: "delivery_3day", sentAt: new Date() });
    await recordProductionUpdate({ tenantId, jobId, kind: "delivery_eve", suppressedReason: "opt_out" });
    gaps = await deliveryNoticeGaps(tenantId);
    expect(gaps).toEqual([]);
  });
});
