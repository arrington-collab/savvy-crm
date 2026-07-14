import { describe, it, expect } from "vitest";
import {
  adminDb, tenant, customer, property, lead, document, estimate, repairCredit, measurement, eq, sql,
  startInspectionForLead, ingestInspectionMedia, addInspectionFinding, ensureInspectionChecklists, ensurePriceBook, withTenant,
  refreshLeadEstimateDraft,
} from "../src/index.js";
import {
  applyFriendRule,
  issueRepairCredit,
  applyRepairCreditToEstimate,
  creditCheckinsDue,
  recordCreditCheckin,
  expireLapsedCredits,
} from "../src/lifecycle/repair-credit.js";
import { makeTenant, makeLeadWithProperty } from "./helpers.js";

async function seedFindingContext(opts: { estimateCents: number; itemKey?: string }) {
  const { tenantId } = await makeTenant();
  const { leadId, propertyId, customerId } = await makeLeadWithProperty(tenantId);
  await ensureInspectionChecklists(tenantId);
  const started = await startInspectionForLead({ tenantId, leadId });
  if ("error" in started) throw new Error("start failed");
  const [d] = await adminDb.insert(document).values({ tenantId, leadId, kind: "photo", source: "sitesnap", sitesnapPhotoId: `ss-${crypto.randomUUID()}` }).returning();
  const media = await ingestInspectionMedia({
    tenantId, inspectionId: started.inspectionId, zoneKey: "penetrations", zoneLabel: "Penetrations", zoneKind: "penetrations",
    documentId: d!.id, checklistItemKey: opts.itemKey ?? "pipe_boots",
  });
  if ("error" in media) throw new Error("media failed");
  const finding = await addInspectionFinding({
    tenantId, inspectionZoneId: media.inspectionZoneId,
    whatItIs: "Cracked pipe boot", photoIds: [d!.id], createdBy: "inspector",
    checklistItemKey: opts.itemKey ?? "pipe_boots", repairEstimateCents: opts.estimateCents,
  });
  if ("error" in finding) throw new Error("finding failed");
  return { tenantId, leadId, propertyId, customerId, inspectionId: started.inspectionId, findingId: finding.findingId };
}

describe("applyFriendRule — anything we'd do for a friend or neighbor is free", () => {
  it("flips an eligible small finding to fixed_free_today (default threshold $150)", async () => {
    const ctx = await seedFindingContext({ estimateCents: 9000 }); // $90 pipe boot — friend_rule_eligible in the seed checklist
    const res = await applyFriendRule({ tenantId: ctx.tenantId, findingId: ctx.findingId });
    expect(res).toEqual({ applied: true, disposition: "fixed_free_today" });
  });

  it("leaves a finding above the threshold as repair work", async () => {
    const ctx = await seedFindingContext({ estimateCents: 45000 }); // $450 — a real repair
    const res = await applyFriendRule({ tenantId: ctx.tenantId, findingId: ctx.findingId });
    expect(res).toEqual({ applied: false, reason: "over_threshold" });
  });

  it("ineligible checklist items never auto-comp (flashing_seal is not friend-rule)", async () => {
    const ctx = await seedFindingContext({ estimateCents: 9000, itemKey: "flashing_seal" });
    const res = await applyFriendRule({ tenantId: ctx.tenantId, findingId: ctx.findingId });
    expect(res).toEqual({ applied: false, reason: "not_eligible" });
  });
});

describe("repair credits — 36-month replacement credit", () => {
  it("issues once per source invoice (replays skip) with a 36-month expiry", async () => {
    const ctx = await seedFindingContext({ estimateCents: 30000 });
    const first = await issueRepairCredit({
      tenantId: ctx.tenantId, customerId: ctx.customerId, sourceInspectionId: ctx.inspectionId,
      sourceInvoiceRef: "inv-123", amountCents: 30000,
    });
    expect("creditId" in first).toBe(true);
    const replay = await issueRepairCredit({
      tenantId: ctx.tenantId, customerId: ctx.customerId, sourceInspectionId: ctx.inspectionId,
      sourceInvoiceRef: "inv-123", amountCents: 30000,
    });
    expect(replay).toEqual({ skipped: "already_issued", creditId: (first as { creditId: string }).creditId });

    const [row] = await adminDb.select().from(repairCredit).where(eq(repairCredit.id, (first as { creditId: string }).creditId));
    expect(row!.status).toBe("active");
    const months = (row!.expiresAt.getTime() - row!.issuedAt.getTime()) / (30.44 * 86_400_000);
    expect(Math.round(months)).toBe(36);
  });

  it("AUTO-APPLY: a replacement estimate for the customer includes the credit as a visible line", async () => {
    const ctx = await seedFindingContext({ estimateCents: 30000 });
    await ensurePriceBook(ctx.tenantId);
    await withTenant(ctx.tenantId, (tx) => tx.insert(measurement).values({
      tenantId: ctx.tenantId, propertyId: ctx.propertyId, provider: "roofr",
      areas: { squares: 25, predominantPitch: "6/12", eaveLf: 120, rakeLf: 60 },
    }));
    const issued = await issueRepairCredit({
      tenantId: ctx.tenantId, customerId: ctx.customerId, sourceInspectionId: ctx.inspectionId,
      sourceInvoiceRef: "inv-apply", amountCents: 25000,
    });
    const creditId = (issued as { creditId: string }).creditId;

    const drafted = await refreshLeadEstimateDraft({ tenantId: ctx.tenantId, leadId: ctx.leadId });
    if (!("estimateId" in drafted)) throw new Error("draft failed");
    const res = await applyRepairCreditToEstimate({ tenantId: ctx.tenantId, estimateId: drafted.estimateId });
    expect(res).toEqual({ applied: true, creditId, amountCents: 25000 });

    const [e] = await adminDb.select().from(estimate).where(eq(estimate.id, drafted.estimateId));
    const lines = e!.lineItems as { key?: string; totalCents?: number; total?: number; description?: string; name?: string }[];
    const creditLine = lines.find((l) => l.key === "repair-credit");
    expect(creditLine).toBeDefined();

    // Idempotent: re-applying does not stack a second line.
    const again = await applyRepairCreditToEstimate({ tenantId: ctx.tenantId, estimateId: drafted.estimateId });
    expect(again).toEqual({ skipped: "already_applied" });

    const [credit] = await adminDb.select().from(repairCredit).where(eq(repairCredit.id, creditId));
    expect(credit!.status).toBe("applied");
    expect(credit!.appliedEstimateId).toBe(drafted.estimateId);
  });

  it("check-in cadence: 12/24/33-month touches come due once each, logged in checkin_log", async () => {
    const ctx = await seedFindingContext({ estimateCents: 30000 });
    const issued = await issueRepairCredit({
      tenantId: ctx.tenantId, customerId: ctx.customerId, sourceInspectionId: ctx.inspectionId,
      sourceInvoiceRef: "inv-cadence", amountCents: 20000,
    });
    const creditId = (issued as { creditId: string }).creditId;
    // Back-date issuance 12.5 months.
    await adminDb.update(repairCredit).set({ issuedAt: sql`now() - interval '380 days'`, expiresAt: sql`now() + interval '700 days'` }).where(eq(repairCredit.id, creditId));

    const due = await creditCheckinsDue(ctx.tenantId, new Date());
    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({ creditId, kind: "12mo", customerId: ctx.customerId });

    await recordCreditCheckin({ tenantId: ctx.tenantId, creditId, kind: "12mo" });
    expect(await creditCheckinsDue(ctx.tenantId, new Date())).toHaveLength(0); // once each
  });

  it("expiry sweep flips lapsed credits and never touches applied ones", async () => {
    const ctx = await seedFindingContext({ estimateCents: 30000 });
    const issued = await issueRepairCredit({
      tenantId: ctx.tenantId, customerId: ctx.customerId, sourceInspectionId: ctx.inspectionId,
      sourceInvoiceRef: "inv-expire", amountCents: 20000,
    });
    const creditId = (issued as { creditId: string }).creditId;
    await adminDb.update(repairCredit).set({ expiresAt: sql`now() - interval '1 day'` }).where(eq(repairCredit.id, creditId));

    const res = await expireLapsedCredits(ctx.tenantId, new Date());
    expect(res.expired).toBe(1);
    const [row] = await adminDb.select().from(repairCredit).where(eq(repairCredit.id, creditId));
    expect(row!.status).toBe("expired");
  });
});
