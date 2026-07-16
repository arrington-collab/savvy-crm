import { describe, it, expect } from "vitest";
import { eq, and } from "drizzle-orm";
import { evidenceChecks } from "@savvy/core";
import type { EvidenceCtx } from "@savvy/core";
import { adminDb, adminPool } from "../src/admin-client.js";
import { partner } from "../src/schema/partner.js";
import { customer, property, lead } from "../src/schema/crm.js";
import { job } from "../src/schema/jobs.js";
import { estimate, invoice } from "../src/schema/finance.js";
import { inspection } from "../src/schema/inspection.js";
import { makeTenant } from "./helpers.js";
import { findOrCreatePartner } from "../src/lifecycle/partner.js";
import { accrueLedgerEntryTx } from "../src/lifecycle/partner-ledger.js";
import { withTenant } from "../src/tenant.js";
import {
  partnerValueRows,
  recomputePartnerGrades,
  pendingCDecisions,
  resolveCDecision,
  hasUngradedPartners,
} from "../src/lifecycle/partner-value.js";

const NOW = new Date("2026-07-15T18:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

/** Partner-attributed lead with its own customer/property, created `age` days ago. */
async function seedLead(tenantId: string, partnerId: string, age: number): Promise<{ leadId: string; customerId: string; propertyId: string }> {
  const [c] = await adminDb.insert(customer).values({ tenantId, name: `PV Cust ${crypto.randomUUID().slice(0, 8)}` }).returning();
  const [p] = await adminDb.insert(property).values({ tenantId, customerId: c!.id, address: `${age} Value Way` }).returning();
  const [l] = await adminDb.insert(lead).values({
    tenantId, customerId: c!.id, propertyId: p!.id, source: "realtor", partnerId, createdAt: daysAgo(age),
  }).returning();
  return { leadId: l!.id, customerId: c!.id, propertyId: p!.id };
}

async function accrue(tenantId: string, partnerId: string, amountCents: number, occurredAt: Date, sourceRef: string) {
  await withTenant(tenantId, (tx) =>
    accrueLedgerEntryTx(tx, tenantId, { partnerId, kind: "expense", amountCents, sourceRef, occurredAt }),
  );
}

/** The full scenario: 3 in-window leads (1 won w/ collected GM, 1 open estimate, 1 bare) + 1 stale lead. */
async function seedJanet(tenantId: string): Promise<{ partnerId: string }> {
  const { id: partnerId } = await findOrCreatePartner(tenantId, { name: "Janet Value", org: "RE/MAX", class: "realtor" });

  // L1 — the win: inspected, accepted estimate, complete job w/ known cost + paid invoice.
  const L1 = await seedLead(tenantId, partnerId, 40);
  await adminDb.insert(inspection).values({
    tenantId, leadId: L1.leadId, propertyId: L1.propertyId, status: "published", completedAt: daysAgo(38),
  });
  const [j1] = await adminDb.insert(job).values({
    tenantId, customerId: L1.customerId, propertyId: L1.propertyId, leadId: L1.leadId,
    type: "retail", stage: "complete", valueFinal: 1_000_000, costCents: 600_000, createdAt: daysAgo(30),
  }).returning();
  await adminDb.insert(estimate).values({ tenantId, leadId: L1.leadId, jobId: j1!.id, status: "accepted", total: 1_000_000 });
  await adminDb.insert(invoice).values({ tenantId, jobId: j1!.id, amountDue: 1_000_000, amountPaid: 1_000_000, status: "paid" });

  // L2 — open pipeline: a sent (unaccepted) estimate.
  const L2 = await seedLead(tenantId, partnerId, 20);
  await adminDb.insert(estimate).values({ tenantId, leadId: L2.leadId, status: "sent", total: 300_000 });

  // L3 — sent only.
  await seedLead(tenantId, partnerId, 5);

  // Stale lead outside the trailing-12-month window — excluded everywhere.
  await seedLead(tenantId, partnerId, 400);

  // Costs: two in-window entries + one stale (excluded).
  await accrue(tenantId, partnerId, 20_000, daysAgo(38), "pv:insp");
  await accrue(tenantId, partnerId, 5_000, daysAgo(10), "pv:lunch");
  await accrue(tenantId, partnerId, 99_999, daysAgo(400), "pv:old");

  return { partnerId };
}

describe("partnerValueRows", () => {
  it("funnel, collected GM, open pipeline, trailing-12mo costs, net, median days", async () => {
    const { tenantId } = await makeTenant();
    const { partnerId } = await seedJanet(tenantId);

    const rows = await partnerValueRows(tenantId, NOW);
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r.partnerId).toBe(partnerId);
    expect(r.class).toBe("realtor");
    expect(r.sent).toBe(3); // 400d-old lead excluded
    expect(r.inspected).toBe(1);
    expect(r.estimated).toBe(2);
    expect(r.won).toBe(1);
    expect(r.collectedGmCents).toBe(400_000); // 1,000,000 paid − 600,000 known cost
    expect(r.openPipelineCents).toBe(300_000); // L2's unaccepted estimate; complete job excluded
    expect(r.cost12moCents).toBe(25_000); // stale entry excluded
    expect(r.netCents).toBe(375_000);
    expect(r.medianDaysToConvert).toBe(10); // L1: lead @40d → job @30d
  });
});

describe("recomputePartnerGrades", () => {
  it("stamps A/B/C + gradedAt; A sets scheduling priority; fresh C opens a decision card", async () => {
    const { tenantId } = await makeTenant();
    const { partnerId: janet } = await seedJanet(tenantId); // net 375k < 500k, 1 win → B

    // Ann — A: huge collected GM, no costs.
    const { id: ann } = await findOrCreatePartner(tenantId, { name: "Ann Ace", class: "insurance_agent" });
    const A = await seedLead(tenantId, ann, 15);
    const [ja] = await adminDb.insert(job).values({
      tenantId, customerId: A.customerId, propertyId: A.propertyId, leadId: A.leadId,
      type: "retail", stage: "complete", valueFinal: 2_000_000, costCents: 800_000, createdAt: daysAgo(8),
    }).returning();
    await adminDb.insert(invoice).values({ tenantId, jobId: ja!.id, amountDue: 2_000_000, amountPaid: 2_000_000, status: "paid" });

    // Carl — C: 5 referrals, zero wins.
    const { id: carl } = await findOrCreatePartner(tenantId, { name: "Carl Cold", org: "Cold Realty", class: "realtor" });
    for (let i = 0; i < 5; i++) await seedLead(tenantId, carl, 10 + i);

    await recomputePartnerGrades(tenantId, NOW);

    const byId = new Map((await adminDb.select().from(partner).where(eq(partner.tenantId, tenantId))).map((p) => [p.id, p]));
    expect(byId.get(janet)!.grade).toBe("B");
    expect(byId.get(ann)!.grade).toBe("A");
    expect(byId.get(ann)!.schedulingPriority).toBe(true);
    expect(byId.get(carl)!.grade).toBe("C");
    expect(byId.get(carl)!.cCardStatus).toBe("pending");
    expect(byId.get(janet)!.gradedAt).toBeTruthy();
  });

  it("C decision resolves by a human (slack-capacity-only) and does NOT reopen while still C", async () => {
    const { tenantId } = await makeTenant();
    const { id: carl } = await findOrCreatePartner(tenantId, { name: "Carl Cold", org: "Cold Realty", class: "realtor" });
    for (let i = 0; i < 5; i++) await seedLead(tenantId, carl, 10 + i);

    await recomputePartnerGrades(tenantId, NOW);
    const pending = await pendingCDecisions(tenantId);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.partnerId).toBe(carl);
    expect(pending[0]!.sent).toBe(5);

    await resolveCDecision(tenantId, { partnerId: carl, resolution: "slack_capacity_only" });
    const [after] = await adminDb.select().from(partner).where(eq(partner.id, carl));
    expect(after!.slackCapacityOnly).toBe(true);
    expect(after!.cCardStatus).toBe("resolved");

    await recomputePartnerGrades(tenantId, NOW); // still C — stays resolved, no new card
    const [again] = await adminDb.select().from(partner).where(eq(partner.id, carl));
    expect(again!.cCardStatus).toBe("resolved");
    expect(await pendingCDecisions(tenantId)).toHaveLength(0);
  });
});

describe("hasUngradedPartners (daily catch-up trigger for the monthly cron)", () => {
  it("true while an active partner lacks a grade; false after recompute", async () => {
    const { tenantId } = await makeTenant();
    await findOrCreatePartner(tenantId, { name: "New Kid", class: "other" });
    expect(await hasUngradedPartners(tenantId)).toBe(true);
    await recomputePartnerGrades(tenantId, NOW);
    expect(await hasUngradedPartners(tenantId)).toBe(false);
  });
});

describe("evidence: partner.grades_current", () => {
  const run = (tenantId: string) => {
    const ctx: EvidenceCtx = {
      tenantId, db: adminPool, params: {},
      window: { start: new Date(Date.now() - 86_400_000), end: new Date(Date.now() + 86_400_000) },
    };
    return evidenceChecks["partner.grades_current"]!(ctx);
  };

  it("fails on an active partner ungraded for >35 days; passes once graded", async () => {
    const { tenantId } = await makeTenant();
    const { id } = await findOrCreatePartner(tenantId, { name: "Old Ungraded", class: "other" });
    await adminDb.update(partner).set({ createdAt: daysAgo(40) }).where(eq(partner.id, id));

    const bad = await run(tenantId);
    expect(bad.status).toBe("fail");

    await recomputePartnerGrades(tenantId, NOW);
    const clean = await run(tenantId);
    expect(clean.status).toBe("pass");
  });

  it("gives a brand-new ungraded partner until the next monthly pass", async () => {
    const { tenantId } = await makeTenant();
    await findOrCreatePartner(tenantId, { name: "Fresh Face", class: "other" });
    const r = await run(tenantId);
    expect(r.status).toBe("pass");
  });
});
