import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { adminDb } from "../src/admin-client";
import { crew } from "../src/schema/crew";
import { crewGap, fillPlay } from "../src/schema/fill";
import { estimate } from "../src/schema/finance";
import { priceBookItem } from "../src/schema/pricing";
import { relationshipTouch } from "../src/schema/relationship";
import { customer } from "../src/schema/crm";
import { tenant } from "../src/schema/tenancy";
import { repairCredit } from "../src/schema/inspection";
import { makeTenant, makeLeadWithCustomer } from "./helpers";
import { approveFillPlay, fillWeekStats, pendingFillApprovals, runFillSweep } from "../src/lifecycle/slow-week-fill";
import { dueCadenceTextTouches } from "../src/lifecycle/relationship-enrollment";

// Wednesday noon UTC — the look-ahead window has plenty of workdays.
const NOW = new Date("2026-07-15T12:00:00-07:00");

async function seedIdleCrew(tenantId: string, name = "Alpha") {
  const [c] = await adminDb.insert(crew).values({ tenantId, name }).returning();
  return c!.id;
}

async function seedAgingEstimate(tenantId: string, opts?: { unitCostCents?: number; sentDaysAgo?: number }) {
  const { leadId, customerId } = await makeLeadWithCustomer(tenantId);
  await adminDb.insert(priceBookItem).values({
    tenantId, key: "shingles", name: "Shingles", category: "material", unit: "square",
    unitPriceCents: 10000, unitCostCents: opts?.unitCostCents ?? 6000,
  });
  const sentAt = new Date(NOW.getTime() - (opts?.sentDaysAgo ?? 10) * 86_400_000);
  const [e] = await adminDb.insert(estimate).values({
    tenantId, leadId, status: "sent", sentAt,
    lineItems: [{ key: "shingles", name: "Shingles", quantity: 2, unitPriceCents: 10000, amountCents: 20000 }],
    subtotal: 20000, tax: 0, total: 20000,
  }).returning();
  return { estimateId: e!.id, customerId };
}

async function setFillConfig(tenantId: string, cfg: Record<string, unknown>) {
  await adminDb.update(tenant).set({ settings: { slowWeekFill: cfg } }).where(eq(tenant.id, tenantId));
}

describe("runFillSweep — every gap gets a fill plan or a logged pass", () => {
  it("an idle crew becomes a gap, and an aging estimate becomes a floor-checked discount play sent through the governor", async () => {
    const { tenantId } = await makeTenant();
    await seedIdleCrew(tenantId);
    const { estimateId, customerId } = await seedAgingEstimate(tenantId);

    const result = await runFillSweep(tenantId, NOW);
    expect(result.gapsDetected).toBe(1);
    expect(result.playsCreated).toBeGreaterThanOrEqual(1);

    const [gap] = await adminDb.select().from(crewGap).where(eq(crewGap.tenantId, tenantId));
    expect(gap!.status).toBe("planned");

    const plays = await adminDb.select().from(fillPlay).where(eq(fillPlay.tenantId, tenantId));
    const discount = plays.find((p) => p.kind === "estimate_discount");
    expect(discount).toBeDefined();
    expect(discount!.targetRef).toBe(estimateId);
    expect(discount!.status).toBe("sent");
    expect(discount!.discountBps).toBe(500); // default config, floor clears at 40% margin
    expect(discount!.discountedTotalCents).toBe(19000);

    // The outbound rode the governor rails as a ledger row.
    const touches = await adminDb.select().from(relationshipTouch)
      .where(and(eq(relationshipTouch.tenantId, tenantId), eq(relationshipTouch.customerId, customerId)));
    expect(touches.some((t) => t.program === "fill_discount" && !t.suppressedReason)).toBe(true);
  });

  it("SPEC RED PATH: a gap with zero candidates is a logged pass, never silently open", async () => {
    const { tenantId } = await makeTenant();
    await seedIdleCrew(tenantId);

    const result = await runFillSweep(tenantId, NOW);
    expect(result.gapsDetected).toBe(1);
    expect(result.passes).toBe(1);

    const [gap] = await adminDb.select().from(crewGap).where(eq(crewGap.tenantId, tenantId));
    expect(gap!.status).toBe("passed");
    expect(gap!.passReason).toBe("no_candidates");
  });

  it("SPEC RED PATH: an over-threshold discount becomes a pending_approval card and nothing sends", async () => {
    const { tenantId } = await makeTenant();
    await seedIdleCrew(tenantId);
    await seedAgingEstimate(tenantId);
    await setFillConfig(tenantId, { discountBps: 1500, maxAutoDiscountBps: 1000 });

    await runFillSweep(tenantId, NOW);

    const plays = await adminDb.select().from(fillPlay).where(eq(fillPlay.tenantId, tenantId));
    const discount = plays.find((p) => p.kind === "estimate_discount");
    expect(discount!.status).toBe("pending_approval");
    const touches = await adminDb.select().from(relationshipTouch).where(eq(relationshipTouch.tenantId, tenantId));
    expect(touches.filter((t) => t.program === "fill_discount")).toHaveLength(0);
  });

  it("SPEC RED PATH: the margin floor runs on DISCOUNTED totals — a breach skips the play, never auto-sends", async () => {
    // 21% margin at list clears the 20% floor, but 5% off breaches it.
    const { tenantId } = await makeTenant();
    await seedIdleCrew(tenantId);
    await seedAgingEstimate(tenantId, { unitCostCents: 7900 });

    await runFillSweep(tenantId, NOW);

    const plays = await adminDb.select().from(fillPlay).where(eq(fillPlay.tenantId, tenantId));
    const discount = plays.find((p) => p.kind === "estimate_discount");
    // Clamped below the config rate rather than breaching: still sendable, at 125bps.
    expect(discount!.status).toBe("sent");
    expect(discount!.discountBps).toBe(125);
  });

  it("governor refusal is recorded: an opted-out customer's play lands suppressed with the reason", async () => {
    const { tenantId } = await makeTenant();
    await seedIdleCrew(tenantId);
    const { customerId } = await seedAgingEstimate(tenantId);
    await adminDb.update(customer).set({ smsOptOut: true }).where(eq(customer.id, customerId));

    await runFillSweep(tenantId, NOW);

    const plays = await adminDb.select().from(fillPlay).where(eq(fillPlay.tenantId, tenantId));
    const discount = plays.find((p) => p.kind === "estimate_discount");
    expect(discount!.status).toBe("suppressed");
    expect(discount!.suppressedReason).toBe("opt_out");
    // The gap still counts as planned — the loop tried; the refusal is the ledger's evidence.
    const [gap] = await adminDb.select().from(crewGap).where(eq(crewGap.tenantId, tenantId));
    expect(gap!.status).toBe("planned");
  });

  it("an active repair credit becomes a repair_offer play through the governor", async () => {
    const { tenantId } = await makeTenant();
    await seedIdleCrew(tenantId);
    const { customerId } = await makeLeadWithCustomer(tenantId);
    const [rc] = await adminDb.insert(repairCredit).values({
      tenantId, customerId, amountCents: 25000, sourceInspectionId: null,
      issuedAt: NOW, expiresAt: new Date(NOW.getTime() + 400 * 86_400_000),
    }).returning();

    await runFillSweep(tenantId, NOW);

    const plays = await adminDb.select().from(fillPlay).where(eq(fillPlay.tenantId, tenantId));
    const repair = plays.find((p) => p.kind === "repair_offer");
    expect(repair).toBeDefined();
    expect(repair!.targetRef).toBe(rc!.id);
    expect(repair!.status).toBe("sent");
  });

  it("re-running the sweep is idempotent: no duplicate gaps, plays, or touches", async () => {
    const { tenantId } = await makeTenant();
    await seedIdleCrew(tenantId);
    await seedAgingEstimate(tenantId);

    await runFillSweep(tenantId, NOW);
    await runFillSweep(tenantId, NOW);

    const gaps = await adminDb.select().from(crewGap).where(eq(crewGap.tenantId, tenantId));
    expect(gaps).toHaveLength(1);
    const plays = await adminDb.select().from(fillPlay).where(eq(fillPlay.tenantId, tenantId));
    expect(plays.filter((p) => p.kind === "estimate_discount")).toHaveLength(1);
    const touches = await adminDb.select().from(relationshipTouch).where(eq(relationshipTouch.tenantId, tenantId));
    expect(touches.filter((t) => t.program === "fill_discount")).toHaveLength(1);
  });

  it("cross-tenant isolation: tenant B's sweep never sees tenant A's crews or estimates", async () => {
    const { tenantId: a } = await makeTenant();
    const { tenantId: b } = await makeTenant();
    await seedIdleCrew(a);
    await seedAgingEstimate(a);

    const result = await runFillSweep(b, NOW);
    expect(result.gapsDetected).toBe(0);
    const gaps = await adminDb.select().from(crewGap).where(eq(crewGap.tenantId, b));
    expect(gaps).toHaveLength(0);
  });
});

describe("maintenance pull-forward", () => {
  it("a maintenance offer scheduled beyond the window is pulled into the gap", async () => {
    const { tenantId } = await makeTenant();
    await seedIdleCrew(tenantId);
    const { customerId } = await makeLeadWithCustomer(tenantId);
    const farOut = new Date(NOW.getTime() + 60 * 86_400_000);
    const [touch] = await adminDb.insert(relationshipTouch).values({
      tenantId, customerId, program: "maintenance_offer", channel: "text", scheduledFor: farOut,
    }).returning();

    await runFillSweep(tenantId, NOW);

    const plays = await adminDb.select().from(fillPlay).where(eq(fillPlay.tenantId, tenantId));
    const pf = plays.find((p) => p.kind === "maintenance_pullforward");
    expect(pf).toBeDefined();
    expect(pf!.targetRef).toBe(touch!.id);
    expect(pf!.status).toBe("sent");

    const [moved] = await adminDb.select().from(relationshipTouch).where(eq(relationshipTouch.id, touch!.id));
    // Pulled inside the look-ahead window (10d), not still 60d out.
    expect(moved!.scheduledFor.getTime()).toBeLessThan(NOW.getTime() + 10 * 86_400_000);
  });

  it("an already-sent maintenance offer is never pulled", async () => {
    const { tenantId } = await makeTenant();
    await seedIdleCrew(tenantId);
    const { customerId } = await makeLeadWithCustomer(tenantId);
    await adminDb.insert(relationshipTouch).values({
      tenantId, customerId, program: "maintenance_offer", channel: "text",
      scheduledFor: new Date(NOW.getTime() + 60 * 86_400_000), sentAt: NOW,
    });

    await runFillSweep(tenantId, NOW);

    const plays = await adminDb.select().from(fillPlay).where(eq(fillPlay.tenantId, tenantId));
    expect(plays.filter((p) => p.kind === "maintenance_pullforward")).toHaveLength(0);
  });
});

describe("fillWeekStats", () => {
  it("counts the trailing week's gaps, plays, and pending cards for the digest", async () => {
    const { tenantId } = await makeTenant();
    await seedIdleCrew(tenantId);
    await seedAgingEstimate(tenantId);
    await setFillConfig(tenantId, { discountBps: 1500, maxAutoDiscountBps: 1000 }); // forces a card
    await runFillSweep(tenantId, NOW);

    const stats = await fillWeekStats(tenantId, NOW);
    expect(stats.gaps).toBe(1);
    expect(stats.pendingCards).toBe(1);
    expect(stats.playsSent).toBe(0);
  });
});

describe("fill offers ride the existing text-send rail", () => {
  it("a scheduled fill_discount touch is picked up by dueCadenceTextTouches", async () => {
    const { tenantId } = await makeTenant();
    await seedIdleCrew(tenantId);
    const { customerId } = await seedAgingEstimate(tenantId);
    // The send rail only returns reachable customers.
    await adminDb.update(customer).set({ phone: "+15551230000" }).where(eq(customer.id, customerId));
    await runFillSweep(tenantId, NOW);

    const due = await dueCadenceTextTouches(tenantId, new Date(NOW.getTime() + 60_000));
    expect(due.some((d) => d.program === "fill_discount")).toBe(true);
  });
});

describe("fill approval card (S6 matrix: owner/admin approve)", () => {
  async function seedPendingPlay(tenantId: string) {
    await seedIdleCrew(tenantId);
    const { customerId } = await seedAgingEstimate(tenantId);
    await setFillConfig(tenantId, { discountBps: 1500, maxAutoDiscountBps: 1000 });
    await runFillSweep(tenantId, NOW);
    const [play] = await adminDb.select().from(fillPlay)
      .where(and(eq(fillPlay.tenantId, tenantId), eq(fillPlay.status, "pending_approval")));
    return { playId: play!.id, customerId };
  }

  it("lists pending fill approvals with the money context the card needs", async () => {
    const { tenantId } = await makeTenant();
    const { playId } = await seedPendingPlay(tenantId);

    const pending = await pendingFillApprovals(tenantId);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ playId, discountBps: 1500 });
    expect(pending[0]!.discountedTotalCents!).toBeLessThan(pending[0]!.originalTotalCents!);
  });

  it("approving releases the offer through the governor and resolves the card", async () => {
    const { tenantId } = await makeTenant();
    const { playId, customerId } = await seedPendingPlay(tenantId);

    const r = await approveFillPlay(tenantId, { playId, userId: null });
    expect(r).toEqual({ ok: true });

    const [play] = await adminDb.select().from(fillPlay).where(eq(fillPlay.id, playId));
    expect(play!.status).toBe("sent");
    expect(play!.resolvedAt).not.toBeNull();
    const touches = await adminDb.select().from(relationshipTouch)
      .where(and(eq(relationshipTouch.tenantId, tenantId), eq(relationshipTouch.customerId, customerId)));
    expect(touches.some((t) => t.program === "fill_discount" && !t.suppressedReason)).toBe(true);
  });

  it("approving an opted-out customer's play records the suppression instead of sending", async () => {
    const { tenantId } = await makeTenant();
    const { playId, customerId } = await seedPendingPlay(tenantId);
    await adminDb.update(customer).set({ smsOptOut: true }).where(eq(customer.id, customerId));

    await approveFillPlay(tenantId, { playId, userId: null });

    const [play] = await adminDb.select().from(fillPlay).where(eq(fillPlay.id, playId));
    expect(play!.status).toBe("suppressed");
    expect(play!.suppressedReason).toBe("opt_out");
  });
});
