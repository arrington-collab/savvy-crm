import { it, expect } from "vitest";
import { makeEvent, type DomainEvent } from "@savvy/orchestrator";
import { emptyMetrics, type DailyMetrics } from "./metrics";
import { projectWeek, closeRateCohort, closeRateActivity } from "./weekly";

const T = "11111111-1111-1111-1111-111111111111";
const WEEK_START = "2026-07-06"; // Monday

function ev<Tp extends Parameters<typeof makeEvent>[0]["type"]>(
  type: Tp,
  payload: unknown,
  occurredAt: string,
): DomainEvent {
  return makeEvent({
    type,
    source: "savvy",
    tenantId: T,
    correlationId: "c",
    idempotencyKey: `${type}:${Math.random()}`,
    occurredAt,
    payload,
  } as never);
}

function dayAt(offset: number): string {
  // WEEK_START + offset days, ISO date
  const d = new Date(Date.UTC(2026, 6, 6 + offset, 12));
  return d.toISOString().slice(0, 10);
}

function isoAt(offset: number, hour: number): string {
  return new Date(Date.UTC(2026, 6, 6 + offset, hour)).toISOString();
}

function dailyRowFor(offset: number, overrides: Partial<DailyMetrics["topLine"]> = {}): DailyMetrics {
  const m = emptyMetrics(dayAt(offset));
  Object.assign(m.topLine, overrides);
  return m;
}

it("§8.1 fold correctness: weekly sum === sum of the 7 daily rows", () => {
  const dailyRows: DailyMetrics[] = [
    dailyRowFor(0, { leadsTotal: 3, contractsSigned: 1, contractValueCents: 100_000 }),
    dailyRowFor(1, { leadsTotal: 2, contractsSigned: 0, contractValueCents: 0 }),
    dailyRowFor(2, { leadsTotal: 5, contractsSigned: 2, contractValueCents: 250_000 }),
    dailyRowFor(3, { leadsTotal: 0 }),
    dailyRowFor(4, { leadsTotal: 1, appointmentsSet: 1 }),
    dailyRowFor(5, { leadsTotal: 0 }),
    dailyRowFor(6, { leadsTotal: 0 }),
  ];
  const week = projectWeek({ dailyRows, weekEvents: [], weekStart: WEEK_START });

  expect(week.topLine.leadsTotal).toBe(dailyRows.reduce((a, d) => a + d.topLine.leadsTotal, 0));
  expect(week.topLine.contractsSigned).toBe(dailyRows.reduce((a, d) => a + d.topLine.contractsSigned, 0));
  expect(week.topLine.contractValueCents).toBe(
    dailyRows.reduce((a, d) => a + d.topLine.contractValueCents, 0),
  );
  expect(week.topLine.appointmentsSet).toBe(dailyRows.reduce((a, d) => a + d.topLine.appointmentsSet, 0));
});

it("§8.1/A.2 median re-derives from the week's events and is NOT the mean of daily medians", () => {
  // Day 0: two touches -> daily median would be mean(1min, 3min)=2min if folded naively.
  // Day 1: one touch of 60 min.
  // A mean-of-daily-medians would be very different from the true median across
  // all 3 touches pooled: [1min, 3min, 60min] -> median = 3min.
  const dailyRows: DailyMetrics[] = [
    dailyRowFor(0),
    dailyRowFor(1),
  ];
  const weekEvents: DomainEvent[] = [
    ev("lead.first_touch", { leadId: "l1", channel: "sms", latencySeconds: 60 }, isoAt(0, 1)), // 1 min
    ev("lead.first_touch", { leadId: "l2", channel: "sms", latencySeconds: 180 }, isoAt(0, 2)), // 3 min
    ev("lead.first_touch", { leadId: "l3", channel: "sms", latencySeconds: 3600 }, isoAt(1, 1)), // 60 min
  ];
  const week = projectWeek({ dailyRows, weekEvents, weekStart: WEEK_START });

  expect(week.speed.median_seconds).toEqual({ status: "ok", value: 180 }); // true pooled median
  // sanity: this must NOT equal a mean-of-daily-medians value (which would be
  // (mean(60,180) + 3600) / 2 = (120 + 3600) / 2 = 1860, a very different,
  // wrong number).
  expect(week.speed.median_seconds).not.toEqual({ status: "ok", value: 1860 });
});

it("§8.7 speed prefers slaLatencySeconds over latencySeconds, and a quietHoursDeferred touch is NOT a breach", () => {
  const dailyRows: DailyMetrics[] = [dailyRowFor(0)];
  const weekEvents: DomainEvent[] = [
    // slaLatencySeconds should win over latencySeconds (10s vs 10000s) and land under SLA.
    ev(
      "lead.first_touch",
      { leadId: "l1", channel: "sms", latencySeconds: 10_000, slaLatencySeconds: 10 },
      isoAt(0, 1),
    ),
    // A quiet-hours-deferred touch with a long latency must NOT count as a breach.
    ev(
      "lead.first_touch",
      { leadId: "l2", channel: "sms", latencySeconds: 36_000, quietHoursDeferred: true },
      isoAt(0, 2),
    ),
    // A normal touch well over the 5-minute SLA IS a breach.
    ev("lead.first_touch", { leadId: "l3", channel: "sms", latencySeconds: 600 }, isoAt(0, 3)),
  ];
  const week = projectWeek({ dailyRows, weekEvents, weekStart: WEEK_START });

  // 2 of 3 first touches count as "under SLA" (l1 via slaLatencySeconds, l2 via quiet-hours exemption); l3 breaches.
  expect(week.speed.pct_under_sla).toEqual({ status: "ok", value: 2 / 3 });
});

it("§8.7 a quietHoursDeferred touch with latency WELL OVER the SLA is exempt, not a breach", () => {
  // This pins the blanket quiet-hours exemption on its own: a deferred touch
  // whose latency (and slaLatencySeconds copy — see weekly.ts comment on
  // Slice B's lead-intake.ts:202) is 10x the 5-minute SLA must still count as
  // "under SLA" (compliant), because the delay was policy-mandated, not a
  // rep failure. Without this test, the suite only ever exercised
  // quietHoursDeferred alongside other touches, so it never pinned that a
  // deferred touch's `pct_under_sla` contribution is unaffected by how large
  // its latency is.
  const dailyRows: DailyMetrics[] = [dailyRowFor(0)];
  const weekEvents: DomainEvent[] = [
    ev(
      "lead.first_touch",
      {
        leadId: "l1",
        channel: "sms",
        latencySeconds: 36_000, // 10 hours — 120x the 5-minute SLA
        slaLatencySeconds: 36_000,
        quietHoursDeferred: true,
      },
      isoAt(0, 1),
    ),
  ];
  const week = projectWeek({ dailyRows, weekEvents, weekStart: WEEK_START });

  // The lone touch is deferred, so it must NOT reduce pct_under_sla — it's
  // excluded from breach entirely, i.e. treated as compliant.
  expect(week.speed.pct_under_sla).toEqual({ status: "ok", value: 1 });
});

it("§7 degradation: no lead.first_touch data -> speed is pending, not a silent 0", () => {
  const dailyRows: DailyMetrics[] = [dailyRowFor(0)];
  const week = projectWeek({ dailyRows, weekEvents: [], weekStart: WEEK_START });

  expect(week.speed.median_seconds.status).toBe("pending");
  expect(week.speed.pct_under_sla.status).toBe("pending");
  if (week.speed.median_seconds.status === "pending") {
    expect(week.speed.median_seconds.reason).toMatch(/twilio/i);
  }
});

it("§7 degradation: no review.posted -> reviews.avg_stars is pending 'no reviews yet', not 0", () => {
  const dailyRows: DailyMetrics[] = [dailyRowFor(0)];
  const week = projectWeek({ dailyRows, weekEvents: [], weekStart: WEEK_START });

  expect(week.reviews.avg_stars).toEqual({ status: "pending", reason: "no reviews yet" });
});

it("margin.avg_pct and reviews.avg_stars re-derive from the week's events when data exists", () => {
  const dailyRows: DailyMetrics[] = [dailyRowFor(0)];
  const weekEvents: DomainEvent[] = [
    ev("estimate.approved", { estimateId: "e1", jobId: "j1", marginPct: 0.2 }, isoAt(0, 1)),
    ev("estimate.approved", { estimateId: "e2", jobId: "j2", marginPct: 0.4 }, isoAt(1, 1)),
    ev("review.posted", { jobId: "j1", stars: 5 }, isoAt(0, 2)),
    ev("review.posted", { jobId: "j2", stars: 3 }, isoAt(2, 2)),
  ];
  const week = projectWeek({ dailyRows, weekEvents, weekStart: WEEK_START });

  expect(week.margin.avg_pct.status).toBe("ok");
  if (week.margin.avg_pct.status === "ok") expect(week.margin.avg_pct.value).toBeCloseTo(0.3);
  expect(week.reviews.avg_stars).toEqual({ status: "ok", value: 4 });
});

it("§8.6 cohort vs activity close rate produce different numbers on a lagged fixture, and are labeled distinctly", () => {
  // 4 leads created THIS week; only 1 has signed so far (as of "now").
  const leadsCreatedInWeek = [
    { leadId: "l1", createdAt: new Date("2026-07-06T12:00:00Z") },
    { leadId: "l2", createdAt: new Date("2026-07-07T12:00:00Z") },
    { leadId: "l3", createdAt: new Date("2026-07-08T12:00:00Z") },
    { leadId: "l4", createdAt: new Date("2026-07-09T12:00:00Z") },
  ];
  // A contract signed THIS week too, but for a lead created 3 weeks ago (lagged cohort) — l1 also signed.
  const contractsAsOfNow = [
    { leadId: "l1", signedAt: new Date("2026-07-10T12:00:00Z") },
    { leadId: "old-lead-from-3-weeks-ago", signedAt: new Date("2026-07-10T12:00:00Z") },
  ];
  const now = new Date("2026-07-10T12:00:00Z");

  const cohort = closeRateCohort({ leadsCreatedInWeek, contractsAsOfNow, now, weekStart: WEEK_START });
  // activity basis: 2 contracts signed this week ÷ 4 leads created this week (throughput pulse — includes the lagged contract).
  const activity = closeRateActivity(2, 4);

  expect(cohort.rate).toBeCloseTo(1 / 4); // only l1 (created in-week) has signed, as of now
  expect(activity.rate).toBeCloseTo(2 / 4); // 2 contracts signed this week, regardless of when the lead was created
  expect(cohort.rate).not.toBe(activity.rate); // must diverge on a lagged fixture — never conflated
  expect(activity.basis).toBe("activity");
  expect(cohort).toHaveProperty("cohortAgeDays");
  expect(cohort).toHaveProperty("maturing");
});

it("cohort reports maturity based on cohort age", () => {
  const leadsCreatedInWeek = [{ leadId: "l1", createdAt: new Date("2026-07-06T12:00:00Z") }];
  const contractsAsOfNow: { leadId: string; signedAt: Date }[] = [];

  const freshNow = new Date("2026-07-08T12:00:00Z"); // 2 days after weekStart
  const freshCohort = closeRateCohort({ leadsCreatedInWeek, contractsAsOfNow, now: freshNow, weekStart: WEEK_START });
  expect(freshCohort.maturing).toBe(true);
  expect(freshCohort.cohortAgeDays).toBe(2);

  const oldNow = new Date("2026-09-06T12:00:00Z"); // ~62 days later
  const oldCohort = closeRateCohort({ leadsCreatedInWeek, contractsAsOfNow, now: oldNow, weekStart: WEEK_START });
  expect(oldCohort.maturing).toBe(false);
});

it("closeRateActivity is never called conversion and guards divide-by-zero", () => {
  const result = closeRateActivity(0, 0);
  expect(result.basis).toBe("activity");
  expect(result.rate).toBe(0);
});
