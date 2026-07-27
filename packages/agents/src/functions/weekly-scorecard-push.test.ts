import { beforeAll, afterAll, describe, expect, it } from "vitest";
import {
  adminDb, adminPool, eq, and,
  tenant, user, agentRun, weeklyScorecard,
} from "@savvy/db";
import { businessDateOf, weekStartOf } from "@savvy/command-center";
import { MockFlashDelivery } from "@savvy/command-center";
import {
  isWeeklyScorecardDue, dueTenantsForWeeklyScorecard, scorecardPushHour,
  renderWeeklyScorecardSummary, sendTenantWeeklyScorecard, runWeeklyScorecardLoop,
} from "./weekly-scorecard-push";

// ---------------------------------------------------------------------------
// Pure gating logic — no DB, fake clock only.
// ---------------------------------------------------------------------------

describe("isWeeklyScorecardDue", () => {
  it("is true only at the configured local hour on a Monday", () => {
    // 2026-07-06 is a Monday. 15:00Z is 08:00 America/Phoenix (UTC-7).
    const mondayAt8Phoenix = new Date("2026-07-06T15:00:00Z");
    expect(isWeeklyScorecardDue(mondayAt8Phoenix, "America/Phoenix", 8)).toBe(true);
  });

  it("is false on the same local hour on a non-Monday", () => {
    // 2026-07-07 is a Tuesday, same 08:00 Phoenix local hour.
    const tuesdayAt8Phoenix = new Date("2026-07-07T15:00:00Z");
    expect(isWeeklyScorecardDue(tuesdayAt8Phoenix, "America/Phoenix", 8)).toBe(false);
  });

  it("is false on Monday at a different local hour", () => {
    const mondayAt9Phoenix = new Date("2026-07-06T16:00:00Z");
    expect(isWeeklyScorecardDue(mondayAt9Phoenix, "America/Phoenix", 8)).toBe(false);
  });

  it("respects the local-day boundary across timezones (one hourly tick, two tenants)", () => {
    // 15:00Z Monday July 6 is 08:00 Phoenix (UTC-7, Monday) AND 09:00 Denver (UTC-6 MDT, Monday).
    const tick = new Date("2026-07-06T15:00:00Z");
    expect(isWeeklyScorecardDue(tick, "America/Phoenix", 8)).toBe(true);
    expect(isWeeklyScorecardDue(tick, "America/Denver", 8)).toBe(false); // Denver local hour is 09:00, not 08:00
    expect(isWeeklyScorecardDue(tick, "America/Denver", 9)).toBe(true);
  });
});

describe("scorecardPushHour", () => {
  it("defaults to 8am local when unconfigured", () => {
    expect(scorecardPushHour(null)).toBe(8);
    expect(scorecardPushHour({})).toBe(8);
  });

  it("reads a configured override from settings.scorecard.pushHourLocal", () => {
    expect(scorecardPushHour({ scorecard: { pushHourLocal: 7 } })).toBe(7);
  });

  it("falls back to the default for an out-of-range or non-numeric override", () => {
    expect(scorecardPushHour({ scorecard: { pushHourLocal: 30 } })).toBe(8);
    expect(scorecardPushHour({ scorecard: { pushHourLocal: "7" } })).toBe(8);
  });
});

describe("dueTenantsForWeeklyScorecard", () => {
  it("fires each tenant once — Monday-local-morning ONLY — and never on other days/hours", () => {
    const tick = new Date("2026-07-06T15:00:00Z"); // Monday, 08:00 Phoenix / 09:00 Denver
    const tenants = [
      { id: "a", timezone: "America/Phoenix", settings: null }, // due (08:00 Mon Phoenix, default hour 8)
      { id: "b", timezone: "America/Denver", settings: null }, // not due (09:00 Mon Denver != default 8)
      { id: "c", timezone: "America/Denver", settings: { scorecard: { pushHourLocal: 9 } } }, // due (configured 9)
    ];
    expect(dueTenantsForWeeklyScorecard(tenants, tick).map((t) => t.id)).toEqual(["a", "c"]);

    const tuesdaySameHour = new Date("2026-07-07T15:00:00Z");
    expect(dueTenantsForWeeklyScorecard(tenants, tuesdaySameHour)).toEqual([]);
  });
});

describe("renderWeeklyScorecardSummary", () => {
  it("puts off-track rows first and includes their values", () => {
    const rows = [
      { metricKey: "leads.new", value: { status: "ok" as const, value: 20 }, onTrack: true },
      { metricKey: "contracts.count", value: { status: "ok" as const, value: 1 }, onTrack: false },
      { metricKey: "exceptions.open", value: { status: "pending" as const, reason: "not loaded" }, onTrack: null },
    ];
    const summary = renderWeeklyScorecardSummary(rows);
    expect(summary).toContain("1 off-track");
    expect(summary).toContain("contracts.count");
    expect(summary).not.toContain("leads.new");
  });

  it("orders multiple off-track rows by the same stable sort buildScorecard/onTrackRank uses — input order preserved within the off-track tier, not alphabetical", () => {
    // Two off-track rows (both onTrackRank 0, so a correct implementation
    // keeps them in *input* order — a stable sort's tie-breaking behavior),
    // plus an on-track row that must be excluded from the summary entirely.
    // Deliberately ordered so "alphabetical" or "reverse input" would produce
    // a DIFFERENT relative order than what's asserted below — this fails if
    // the sort isn't the real stable off-track-first sort.
    const rows = [
      { metricKey: "appts.no_show_rate", value: { status: "ok" as const, value: 0.4 }, onTrack: false },
      { metricKey: "leads.new", value: { status: "ok" as const, value: 20 }, onTrack: true },
      { metricKey: "contracts.count", value: { status: "ok" as const, value: 1 }, onTrack: false },
    ];
    const summary = renderWeeklyScorecardSummary(rows);
    expect(summary).toContain("2 off-track");
    expect(summary).not.toContain("leads.new");

    const idxNoShow = summary.indexOf("appts.no_show_rate");
    const idxContracts = summary.indexOf("contracts.count");
    expect(idxNoShow).toBeGreaterThanOrEqual(0);
    expect(idxContracts).toBeGreaterThanOrEqual(0);
    // Real ordering assertion: appts.no_show_rate (listed first in the input)
    // must render before contracts.count — alphabetical order would reverse
    // this, so this only passes on genuine input-order-preserving stability.
    expect(idxNoShow).toBeLessThan(idxContracts);
  });

  it("says everything is on track when there are no off-track rows", () => {
    const rows = [{ metricKey: "leads.new", value: { status: "ok" as const, value: 20 }, onTrack: true }];
    expect(renderWeeklyScorecardSummary(rows)).toContain("on track");
  });
});

describe("runWeeklyScorecardLoop", () => {
  // step.run stub: just invoke the work function (no Inngest runtime needed) —
  // mirrors photo-qc.test.ts's stubStep.
  const stubStep = { run: async <T>(_name: string, fn: () => T | Promise<T>) => fn() };

  it("isolates a failing tenant: a later tenant still gets sent, and the failure is counted, not swallowed silently", async () => {
    const calls: string[] = [];
    const send = async (tenantId: string) => {
      calls.push(tenantId);
      if (tenantId === "tenant-a") throw new Error("rebuildWeek boom (simulated compute failure)");
      return { sent: true, offTrack: 0 };
    };

    const result = await runWeeklyScorecardLoop(["tenant-a", "tenant-b"], stubStep, send);

    // Tenant A's throw must not stop the loop — tenant B is still reached and sent.
    expect(calls).toEqual(["tenant-a", "tenant-b"]);
    expect(result.sent).toBe(1);
    expect(result.failed).toBe(1);
  });

  it("keeps counting sends/failures correctly across more than one failure", async () => {
    const send = async (tenantId: string) => {
      if (tenantId === "tenant-a" || tenantId === "tenant-c") throw new Error("boom");
      return { sent: true, offTrack: 0 };
    };

    const result = await runWeeklyScorecardLoop(["tenant-a", "tenant-b", "tenant-c", "tenant-d"], stubStep, send);

    expect(result.sent).toBe(2); // b, d
    expect(result.failed).toBe(2); // a, c
  });

  it("does not count a tenant that ran but chose not to send (no owner phone) as a failure", async () => {
    const send = async () => ({ sent: false, offTrack: 0 });
    const result = await runWeeklyScorecardLoop(["tenant-a"], stubStep, send);
    expect(result.sent).toBe(0);
    expect(result.failed).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Per-tenant push — real DB (rebuildWeek + persisted weekly_scorecard rows),
// mock delivery. Mirrors ops-digest.test.ts's fixture shape.
// ---------------------------------------------------------------------------

let tenantId: string;

beforeAll(async () => {
  const [t] = await adminDb.insert(tenant).values({
    name: "WSP-test", publicKey: `wsp-${Date.now()}`, clerkOrgId: `org_wsp_${Date.now()}`, timezone: "America/Phoenix",
  }).returning();
  tenantId = t!.id;
  await adminDb.insert(user).values({ tenantId, role: "owner", name: "Owner WSP", email: `owner-wsp-${Date.now()}@x.com`, phone: "+16025553333" });
});

afterAll(async () => {
  await adminDb.delete(agentRun).where(eq(agentRun.tenantId, tenantId));
  await adminDb.delete(weeklyScorecard).where(eq(weeklyScorecard.tenantId, tenantId));
  await adminDb.delete(user).where(eq(user.tenantId, tenantId));
  await adminDb.delete(tenant).where(eq(tenant.id, tenantId));
  await adminPool.end();
});

describe("sendTenantWeeklyScorecard", () => {
  it("rebuilds the week, persists scorecard rows, and pushes a mock delivery to the owner", async () => {
    const now = new Date("2026-07-06T15:00:00Z"); // Monday 08:00 Phoenix
    const delivery = new MockFlashDelivery();

    const r = await sendTenantWeeklyScorecard(tenantId, { delivery, now });

    expect(r.sent).toBe(true);
    expect(delivery.sent).toHaveLength(1);
    expect(delivery.sent[0]!.to).toBe("+16025553333");
    expect(delivery.sent[0]!.headline.length).toBeGreaterThan(0);

    const weekStart = weekStartOf(businessDateOf(now));
    const rows = await adminDb.select().from(weeklyScorecard).where(and(eq(weeklyScorecard.tenantId, tenantId), eq(weeklyScorecard.weekStart, weekStart)));
    expect(rows.length).toBeGreaterThan(0);

    const runs = await adminDb.select().from(agentRun).where(and(eq(agentRun.tenantId, tenantId), eq(agentRun.taskKey, "scorecard.weekly_push")));
    expect(runs.length).toBe(1);
  });

  it("is safe to re-run for the same tenant/week (rebuildWeek idempotent, mock delivery just resends)", async () => {
    const now = new Date("2026-07-06T15:00:00Z");
    const delivery = new MockFlashDelivery();
    await sendTenantWeeklyScorecard(tenantId, { delivery, now });
    await sendTenantWeeklyScorecard(tenantId, { delivery, now });
    // Both sends succeed against the same idempotently-rebuilt week — no throw, no duplicate scorecard rows.
    expect(delivery.sent).toHaveLength(2);
    const weekStart = weekStartOf(businessDateOf(now));
    const rows = await adminDb.select().from(weeklyScorecard).where(and(eq(weeklyScorecard.tenantId, tenantId), eq(weeklyScorecard.weekStart, weekStart)));
    const byMetric = new Map(rows.map((r) => [r.metricKey, r]));
    expect(byMetric.size).toBe(rows.length); // no duplicate (tenant, weekStart, locationId, metricKey) rows
  });
});
