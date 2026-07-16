import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { evidenceChecks } from "@savvy/core";
import type { EvidenceCtx } from "@savvy/core";
import { adminDb, adminPool } from "../src/admin-client.js";
import { tenant } from "../src/schema/tenancy.js";
import { customer, property, lead } from "../src/schema/crm.js";
import { job } from "../src/schema/jobs.js";
import { invoice, referralPayment } from "../src/schema/finance.js";
import { inspection, inspectionZone, inspectionFinding, inspectionChecklist } from "../src/schema/inspection.js";
import { partnerLedgerEntry } from "../src/schema/partner.js";
import { makeTenant, makeUser } from "./helpers.js";
import { findOrCreatePartner } from "../src/lifecycle/partner.js";
import { completeInspection } from "../src/lifecycle/inspection.js";
import { applyFriendRule } from "../src/lifecycle/repair-credit.js";
import {
  logPartnerExpense,
  partnerExpenseWeeklySum,
  sweepPartnerLedgerAccruals,
} from "../src/lifecycle/partner-ledger.js";

async function seedPartneredLead(tenantId: string, opts?: { partnered?: boolean }) {
  const partnered = opts?.partnered ?? true;
  const [c] = await adminDb.insert(customer).values({ tenantId, name: "Ledger Cust" }).returning();
  const [p] = await adminDb.insert(property).values({ tenantId, customerId: c!.id, address: "7 Ledger Way" }).returning();
  let partnerId: string | null = null;
  if (partnered) {
    partnerId = (await findOrCreatePartner(tenantId, { name: "Jane Smith", org: "RE/MAX", class: "realtor" })).id;
  }
  const [l] = await adminDb.insert(lead).values({
    tenantId, customerId: c!.id, propertyId: p!.id,
    source: partnered ? "realtor" : "web", partnerId,
  }).returning();
  return { customerId: c!.id, propertyId: p!.id, leadId: l!.id, partnerId };
}

async function seedInspection(tenantId: string, leadId: string, propertyId: string, status = "in_progress") {
  const [i] = await adminDb.insert(inspection).values({
    tenantId, leadId, propertyId, status,
    completedAt: status === "in_progress" ? null : new Date(),
  }).returning();
  return i!.id;
}

const entriesFor = (tenantId: string) =>
  adminDb.select().from(partnerLedgerEntry).where(eq(partnerLedgerEntry.tenantId, tenantId));

describe("inspection standard cost accrual", () => {
  it("completeInspection on a partner-sourced lead accrues the tenant standard cost, once", async () => {
    const { tenantId } = await makeTenant();
    const { leadId, propertyId, partnerId } = await seedPartneredLead(tenantId);
    const inspectionId = await seedInspection(tenantId, leadId, propertyId);

    await completeInspection({ tenantId, inspectionId });
    await completeInspection({ tenantId, inspectionId }); // replay refuses; no double accrual

    const entries = await entriesFor(tenantId);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.partnerId).toBe(partnerId);
    expect(entries[0]!.kind).toBe("inspection_standard");
    expect(entries[0]!.direction).toBe("cost");
    expect(entries[0]!.amountCents).toBe(20000);
    expect(entries[0]!.sourceRef).toBe(`inspection:${inspectionId}`);
  });

  it("honors the tenant-config standard cost", async () => {
    const { tenantId } = await makeTenant();
    await adminDb.update(tenant)
      .set({ settings: { partnerLedger: { inspectionStandardCostCents: 15000 } } })
      .where(eq(tenant.id, tenantId));
    const { leadId, propertyId } = await seedPartneredLead(tenantId);
    const inspectionId = await seedInspection(tenantId, leadId, propertyId);
    await completeInspection({ tenantId, inspectionId });
    const entries = await entriesFor(tenantId);
    expect(entries[0]!.amountCents).toBe(15000);
  });

  it("accrues nothing for a non-partner lead", async () => {
    const { tenantId } = await makeTenant();
    const { leadId, propertyId } = await seedPartneredLead(tenantId, { partnered: false });
    const inspectionId = await seedInspection(tenantId, leadId, propertyId);
    await completeInspection({ tenantId, inspectionId });
    expect(await entriesFor(tenantId)).toHaveLength(0);
  });
});

describe("free-repair accrual (friend rule)", () => {
  it("fixed_free_today on a partner-sourced inspection accrues the repair estimate, idempotently", async () => {
    const { tenantId } = await makeTenant();
    const { leadId, propertyId, partnerId } = await seedPartneredLead(tenantId);
    const inspectionId = await seedInspection(tenantId, leadId, propertyId);
    await adminDb.insert(inspectionChecklist).values({
      tenantId, key: "test-roof", name: "Test roof", zoneKind: "facet",
      items: [{ key: "pipe-boot", prompt: "Pipe boot?", input: "pass_fail", friend_rule_eligible: true }],
    });
    const [z] = await adminDb.insert(inspectionZone).values({
      tenantId, inspectionId, zoneKey: "facet-1", zoneLabel: "Front slope", zoneKind: "facet",
    }).returning();
    const [f] = await adminDb.insert(inspectionFinding).values({
      tenantId, inspectionZoneId: z!.id, checklistItemKey: "pipe-boot",
      whatItIs: "Cracked pipe boot", repairEstimateCents: 8000,
    }).returning();

    const r1 = await applyFriendRule({ tenantId, findingId: f!.id });
    const r2 = await applyFriendRule({ tenantId, findingId: f!.id });
    expect(r1.applied).toBe(true);
    expect(r2.applied).toBe(true);

    const entries = (await entriesFor(tenantId)).filter((e) => e.kind === "free_repair");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.partnerId).toBe(partnerId);
    expect(entries[0]!.amountCents).toBe(8000);
    expect(entries[0]!.sourceRef).toBe(`finding:${f!.id}`);
  });
});

describe("referral fee accrual (sweep)", () => {
  it("an approved referral payment on a partner-attributed lead accrues once", async () => {
    const { tenantId } = await makeTenant();
    const { leadId, customerId, propertyId, partnerId } = await seedPartneredLead(tenantId);
    const [j] = await adminDb.insert(job).values({ tenantId, customerId, propertyId, leadId, type: "retail", stage: "lead" }).returning();
    const [inv] = await adminDb.insert(invoice).values({ tenantId, jobId: j!.id, amountDue: 100000, amountPaid: 100000, status: "paid" }).returning();
    void inv;
    const [rp] = await adminDb.insert(referralPayment).values({
      tenantId, jobId: j!.id, leadId, payeeName: "Jane Smith", amountCents: 25000, status: "approved",
    }).returning();

    const r1 = await sweepPartnerLedgerAccruals(tenantId);
    const r2 = await sweepPartnerLedgerAccruals(tenantId);
    expect(r1.accrued).toBeGreaterThanOrEqual(1);
    expect(r2.accrued).toBe(0);

    const entries = (await entriesFor(tenantId)).filter((e) => e.kind === "referral_fee");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.partnerId).toBe(partnerId);
    expect(entries[0]!.amountCents).toBe(25000);
    expect(entries[0]!.sourceRef).toBe(`referral_payment:${rp!.id}`);
  });

  it("pending payments do not accrue", async () => {
    const { tenantId } = await makeTenant();
    const { leadId, customerId, propertyId } = await seedPartneredLead(tenantId);
    const [j] = await adminDb.insert(job).values({ tenantId, customerId, propertyId, leadId, type: "retail", stage: "lead" }).returning();
    await adminDb.insert(referralPayment).values({
      tenantId, jobId: j!.id, leadId, payeeName: "Jane Smith", amountCents: 25000, status: "pending",
    });
    await sweepPartnerLedgerAccruals(tenantId);
    expect((await entriesFor(tenantId)).filter((e) => e.kind === "referral_fee")).toHaveLength(0);
  });
});

describe("sweep self-heals missed inspection accruals", () => {
  it("a completed partner-sourced inspection without an entry gets one on sweep", async () => {
    const { tenantId } = await makeTenant();
    const { leadId, propertyId } = await seedPartneredLead(tenantId);
    await seedInspection(tenantId, leadId, propertyId, "pending_approval"); // completed_at set, no inline hook ran
    const r = await sweepPartnerLedgerAccruals(tenantId);
    expect(r.accrued).toBe(1);
    const entries = (await entriesFor(tenantId)).filter((e) => e.kind === "inspection_standard");
    expect(entries).toHaveLength(1);
  });
});

describe("manual expense quick-log", () => {
  it("writes an expense entry and sums the trailing week", async () => {
    const { tenantId } = await makeTenant();
    const { userId } = await makeUser(tenantId);
    const partnerId = (await findOrCreatePartner(tenantId, { name: "Acme Insurance", class: "insurance_agent" })).id;

    const r = await logPartnerExpense(tenantId, { partnerId, amountCents: 4500, note: "Lunch — Q3 check-in", createdByUserId: userId });
    expect(r.entryId).toBeTruthy();

    const entries = (await entriesFor(tenantId)).filter((e) => e.kind === "expense");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.note).toBe("Lunch — Q3 check-in");
    expect(entries[0]!.createdByUserId).toBe(userId);

    // Old expense outside the window is excluded from the weekly sum.
    await adminDb.insert(partnerLedgerEntry).values({
      tenantId, partnerId, kind: "expense", direction: "cost", amountCents: 9900,
      sourceRef: `expense:old-${crypto.randomUUID()}`, occurredAt: new Date(Date.now() - 10 * 86_400_000),
    });
    expect(await partnerExpenseWeeklySum(tenantId, new Date())).toBe(4500);
  });

  it("rejects a non-positive amount", async () => {
    const { tenantId } = await makeTenant();
    const partnerId = (await findOrCreatePartner(tenantId, { name: "Acme Insurance", class: "insurance_agent" })).id;
    await expect(logPartnerExpense(tenantId, { partnerId, amountCents: 0, note: "" })).rejects.toThrow();
  });
});

describe("evidence: partner.ledger_complete", () => {
  const run = (tenantId: string) => {
    const ctx: EvidenceCtx = {
      tenantId, db: adminPool, params: {},
      window: { start: new Date(Date.now() - 86_400_000), end: new Date(Date.now() + 86_400_000) },
    };
    return evidenceChecks["partner.ledger_complete"]!(ctx);
  };

  it("fails on a completed partner-sourced inspection with no cost entry; passes once accrued", async () => {
    const { tenantId } = await makeTenant();
    const { leadId, propertyId } = await seedPartneredLead(tenantId);
    await seedInspection(tenantId, leadId, propertyId, "pending_approval");

    const bad = await run(tenantId);
    expect(bad.status).toBe("fail");

    await sweepPartnerLedgerAccruals(tenantId);
    const good = await run(tenantId);
    expect(good.status).toBe("pass");
  });
});
