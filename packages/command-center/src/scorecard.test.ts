import { describe, it, expect } from "vitest";
import { ok, pending } from "./degradation";
import type { WeeklyFold } from "./weekly";
import { evaluateOnTrack, buildScorecard, MEASURABLE_KEYS, type GoalConfig } from "./scorecard";

function fakeWeekly(overrides: Partial<WeeklyFold> = {}): WeeklyFold {
  return {
    weekStart: "2026-06-29",
    topLine: {
      leadsTotal: 10, leadsBySource: { web: 6, canvass: 4 },
      appointmentsSet: 8, appointmentsNoShow: 1,
      contractsSigned: 3, contractValueCents: 1_500_000, jobsCompleted: 0,
    },
    money: { invoicedCents: 200_000, cashCollectedCents: 100_000, supplementsApprovedCents: 0, arPastDue: { d30: 0, d60: 0, d90: 0 } },
    quality: { reviewsPosted: 2 },
    production: { estimatesApproved: 4, materialOrders: 1 },
    speed: { median_seconds: ok(180), pct_under_sla: ok(0.9) },
    margin: { avg_pct: ok(28) },
    reviews: { avg_stars: ok(4.6) },
    ...overrides,
  };
}

const gte = (target: number, isPlaceholder = true): GoalConfig => ({ target, direction: "gte", isPlaceholder });
const lte = (target: number, isPlaceholder = true): GoalConfig => ({ target, direction: "lte", isPlaceholder });

describe("evaluateOnTrack", () => {
  it("gte: on-track when value >= target, off-track when below", () => {
    expect(evaluateOnTrack(ok(10), gte(5))).toBe(true);
    expect(evaluateOnTrack(ok(10), gte(10))).toBe(true);
    expect(evaluateOnTrack(ok(3), gte(5))).toBe(false);
  });

  it("lte: on-track when value <= target, off-track when above", () => {
    expect(evaluateOnTrack(ok(2), lte(5))).toBe(true);
    expect(evaluateOnTrack(ok(5), lte(5))).toBe(true);
    expect(evaluateOnTrack(ok(8), lte(5))).toBe(false);
  });

  it("returns null (never false) for a pending value, regardless of the goal", () => {
    expect(evaluateOnTrack(pending("Twilio pending A2P"), gte(5))).toBeNull();
  });

  it("returns null (never false) when no goal is configured", () => {
    expect(evaluateOnTrack(ok(10), null)).toBeNull();
    expect(evaluateOnTrack(ok(10), undefined)).toBeNull();
  });
});

describe("buildScorecard", () => {
  it("produces one row per MEASURABLE_KEYS entry", () => {
    const rows = buildScorecard({ weekly: fakeWeekly(), priorWeeks: {}, goals: {} });
    expect(rows.map((r) => r.metricKey).sort()).toEqual([...MEASURABLE_KEYS].sort());
  });

  it("sorts off-track rows first, then pending/no-goal, then on-track last (§8.5)", () => {
    const weekly = fakeWeekly({
      topLine: {
        leadsTotal: 2, leadsBySource: {}, appointmentsSet: 8, appointmentsNoShow: 1,
        contractsSigned: 0, contractValueCents: 0, jobsCompleted: 0,
      },
    });
    const goals: Record<string, GoalConfig> = {
      "leads.new": gte(20), // off-track: 2 < 20
      "appts.set": gte(1), // on-track: 8 >= 1
      // "contracts.count" deliberately has no goal -> null tier
    };
    const rows = buildScorecard({ weekly, priorWeeks: {}, goals });

    const rank = (mk: string) => rows.findIndex((r) => r.metricKey === mk);
    const offTrackIdx = rank("leads.new");
    const noGoalIdx = rank("contracts.count");
    const onTrackIdx = rank("appts.set");
    expect(offTrackIdx).toBeLessThan(noGoalIdx);
    expect(noGoalIdx).toBeLessThan(onTrackIdx);

    // No false-tier row may appear after any true-tier row anywhere in the array.
    const firstTrueIdx = rows.findIndex((r) => r.onTrack === true);
    const lastFalseIdx = rows.map((r) => r.onTrack).lastIndexOf(false);
    expect(lastFalseIdx).toBeLessThan(firstTrueIdx === -1 ? Infinity : firstTrueIdx);
  });

  it("flags isPlaceholderGoal from the goal's own flag, and true when no goal exists at all", () => {
    const goals: Record<string, GoalConfig> = {
      "leads.new": gte(5, true),
      "appts.set": gte(1, false), // a REAL, non-placeholder target
    };
    const rows = buildScorecard({ weekly: fakeWeekly(), priorWeeks: {}, goals });
    expect(rows.find((r) => r.metricKey === "leads.new")!.isPlaceholderGoal).toBe(true);
    expect(rows.find((r) => r.metricKey === "appts.set")!.isPlaceholderGoal).toBe(false);
    expect(rows.find((r) => r.metricKey === "contracts.count")!.isPlaceholderGoal).toBe(true); // no goal at all
  });

  describe("13-week priorWeeks window (§8.4)", () => {
    it("appends the current week's value as the 13th (last) entry", () => {
      const history = Array.from({ length: 12 }, (_, i) => i); // 0..11
      const rows = buildScorecard({
        weekly: fakeWeekly(),
        priorWeeks: { "leads.new": history },
        goals: {},
      });
      const row = rows.find((r) => r.metricKey === "leads.new")!;
      expect(row.priorWeeks).toHaveLength(13);
      expect(row.priorWeeks.slice(0, 12)).toEqual(history);
      expect(row.priorWeeks[12]).toBe(10); // fakeWeekly's topLine.leadsTotal
    });

    it("left-pads with null when fewer than 12 prior weeks exist yet", () => {
      const rows = buildScorecard({
        weekly: fakeWeekly(),
        priorWeeks: { "leads.new": [5, 6, 7] }, // only 3 weeks of history
        goals: {},
      });
      const row = rows.find((r) => r.metricKey === "leads.new")!;
      expect(row.priorWeeks).toHaveLength(13);
      expect(row.priorWeeks.slice(0, 9)).toEqual(Array(9).fill(null));
      expect(row.priorWeeks.slice(9, 12)).toEqual([5, 6, 7]);
      expect(row.priorWeeks[12]).toBe(10);
    });

    it("keeps only the most recent 12 entries when more than 12 are supplied, shifting older history out", () => {
      const history = Array.from({ length: 14 }, (_, i) => i); // 0..13 (too many)
      const rows = buildScorecard({
        weekly: fakeWeekly(),
        priorWeeks: { "leads.new": history },
        goals: {},
      });
      const row = rows.find((r) => r.metricKey === "leads.new")!;
      expect(row.priorWeeks).toHaveLength(13);
      expect(row.priorWeeks.slice(0, 12)).toEqual(history.slice(-12)); // oldest 2 shifted out
      expect(row.priorWeeks[12]).toBe(10);
    });

    it("defaults to all-null history for a metricKey with no entry in priorWeeks at all", () => {
      const rows = buildScorecard({ weekly: fakeWeekly(), priorWeeks: {}, goals: {} });
      const row = rows.find((r) => r.metricKey === "appts.set")!;
      expect(row.priorWeeks).toHaveLength(13);
      expect(row.priorWeeks.slice(0, 12)).toEqual(Array(12).fill(null));
      expect(row.priorWeeks[12]).toBe(8); // fakeWeekly's topLine.appointmentsSet
    });
  });

  describe("WeeklyFold -> metricKey extraction (spot checks)", () => {
    it("leads.new / appts.set / contracts.count/value come straight off topLine", () => {
      const rows = buildScorecard({ weekly: fakeWeekly(), priorWeeks: {}, goals: {} });
      const val = (mk: string) => rows.find((r) => r.metricKey === mk)!.value;
      expect(val("leads.new")).toEqual(ok(10));
      expect(val("appts.set")).toEqual(ok(8));
      expect(val("contracts.count")).toEqual(ok(3));
      expect(val("contracts.value")).toEqual(ok(1_500_000));
    });

    it("speed.*/margin.avg_pct/reviews.avg_stars pass the WeeklyFold's MetricValue through unchanged, including pending", () => {
      const weekly = fakeWeekly({
        speed: { median_seconds: pending("Twilio pending A2P"), pct_under_sla: pending("Twilio pending A2P") },
        margin: { avg_pct: pending("no estimates approved this week") },
      });
      const rows = buildScorecard({ weekly, priorWeeks: {}, goals: {} });
      const val = (mk: string) => rows.find((r) => r.metricKey === mk)!.value;
      expect(val("speed.median_seconds")).toEqual(pending("Twilio pending A2P"));
      expect(val("speed.pct_under_sla")).toEqual(pending("Twilio pending A2P"));
      expect(val("margin.avg_pct")).toEqual(pending("no estimates approved this week"));
    });

    it("appts.no_show_rate is a computed ratio, pending (not 0) when no appts were set", () => {
      const rows1 = buildScorecard({ weekly: fakeWeekly(), priorWeeks: {}, goals: {} });
      expect(rows1.find((r) => r.metricKey === "appts.no_show_rate")!.value).toEqual(ok(1 / 8));

      const zeroAppts = fakeWeekly({
        topLine: { leadsTotal: 0, leadsBySource: {}, appointmentsSet: 0, appointmentsNoShow: 0, contractsSigned: 0, contractValueCents: 0, jobsCompleted: 0 },
      });
      const rows2 = buildScorecard({ weekly: zeroAppts, priorWeeks: {}, goals: {} });
      const noShow = rows2.find((r) => r.metricKey === "appts.no_show_rate")!.value;
      expect(noShow.status).toBe("pending");
    });

    it("close_rate.cohort / close_rate.activity / exceptions.open default to pending when the DB-computed extras are omitted, and pass through when provided", () => {
      const rowsWithoutExtras = buildScorecard({ weekly: fakeWeekly(), priorWeeks: {}, goals: {} });
      expect(rowsWithoutExtras.find((r) => r.metricKey === "close_rate.cohort")!.value.status).toBe("pending");
      expect(rowsWithoutExtras.find((r) => r.metricKey === "close_rate.activity")!.value.status).toBe("pending");
      expect(rowsWithoutExtras.find((r) => r.metricKey === "exceptions.open")!.value.status).toBe("pending");

      const rowsWithExtras = buildScorecard({
        weekly: fakeWeekly(),
        priorWeeks: {},
        goals: {},
        closeRateCohort: ok(0.4),
        closeRateActivity: ok(0.3),
        exceptionsOpen: ok(2),
      });
      expect(rowsWithExtras.find((r) => r.metricKey === "close_rate.cohort")!.value).toEqual(ok(0.4));
      expect(rowsWithExtras.find((r) => r.metricKey === "close_rate.activity")!.value).toEqual(ok(0.3));
      expect(rowsWithExtras.find((r) => r.metricKey === "exceptions.open")!.value).toEqual(ok(2));
    });
  });
});
