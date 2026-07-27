import { describe, it, expect } from "vitest";
import {
  foldRepWeek, rankReps, foldSourceWeek, MIN_LEADS_FOR_RANK,
  foldLocationWeek, sumLocationWeeks,
  type DailyRepInput, type DailySourceInput, type RepWeekRow,
  type DailyLocationInput,
} from "./dimensional-fold";
import { emptyMetrics, type DailyMetrics } from "./metrics";

describe("foldRepWeek", () => {
  it("sums counts additively across days for the same rep", () => {
    const rows: DailyRepInput[] = [
      { repId: "rep-a", leads: 3, firstTouches: 3, medianSpeedSeconds: 100, apptsSet: 2, noShows: 1, contracts: 1, contractValueCents: 500_00, avgMarginPct: 20 },
      { repId: "rep-a", leads: 2, firstTouches: 2, medianSpeedSeconds: 200, apptsSet: 1, noShows: 0, contracts: 0, contractValueCents: 0, avgMarginPct: null },
    ];
    const [row] = foldRepWeek(rows);
    expect(row!.repId).toBe("rep-a");
    expect(row!.leads).toBe(5);
    expect(row!.firstTouches).toBe(5);
    expect(row!.apptsSet).toBe(3);
    expect(row!.noShows).toBe(1);
    expect(row!.contracts).toBe(1);
    expect(row!.contractValueCents).toBe(500_00);
  });

  it("approximates the weekly speed median as a firstTouches-weighted mean of daily medians", () => {
    const rows: DailyRepInput[] = [
      { repId: "rep-a", leads: 1, firstTouches: 1, medianSpeedSeconds: 100, apptsSet: 0, noShows: 0, contracts: 0, contractValueCents: 0, avgMarginPct: null },
      { repId: "rep-a", leads: 3, firstTouches: 3, medianSpeedSeconds: 300, apptsSet: 0, noShows: 0, contracts: 0, contractValueCents: 0, avgMarginPct: null },
    ];
    const [row] = foldRepWeek(rows);
    // (100*1 + 300*3) / (1+3) = 1000/4 = 250
    expect(row!.speedMedianSeconds).toEqual({ status: "ok", value: 250 });
  });

  it("degrades speed median to pending when no day has a median", () => {
    const rows: DailyRepInput[] = [
      { repId: "rep-a", leads: 1, firstTouches: 0, medianSpeedSeconds: null, apptsSet: 0, noShows: 0, contracts: 0, contractValueCents: 0, avgMarginPct: null },
    ];
    const [row] = foldRepWeek(rows);
    expect(row!.speedMedianSeconds.status).toBe("pending");
  });

  it("always degrades pct-under-SLA to pending — not derivable from the dimensional table", () => {
    const rows: DailyRepInput[] = [
      { repId: "rep-a", leads: 5, firstTouches: 5, medianSpeedSeconds: 100, apptsSet: 0, noShows: 0, contracts: 0, contractValueCents: 0, avgMarginPct: null },
    ];
    const [row] = foldRepWeek(rows);
    expect(row!.pctUnderSla).toEqual({ status: "pending", reason: "not tracked at rep granularity" });
  });

  it("computes no-show rate from apptsSet/noShows, pending when no appointments set", () => {
    const rows: DailyRepInput[] = [
      { repId: "rep-a", leads: 1, firstTouches: 1, medianSpeedSeconds: null, apptsSet: 4, noShows: 1, contracts: 0, contractValueCents: 0, avgMarginPct: null },
    ];
    const [row] = foldRepWeek(rows);
    expect(row!.noShowRate).toEqual({ status: "ok", value: 0.25 });

    const [pendingRow] = foldRepWeek([
      { repId: "rep-b", leads: 1, firstTouches: 1, medianSpeedSeconds: null, apptsSet: 0, noShows: 0, contracts: 0, contractValueCents: 0, avgMarginPct: null },
    ]);
    expect(pendingRow!.noShowRate.status).toBe("pending");
  });

  it("keeps the null-repId (Unassigned) bucket separate from real reps", () => {
    const rows: DailyRepInput[] = [
      { repId: "rep-a", leads: 1, firstTouches: 0, medianSpeedSeconds: null, apptsSet: 0, noShows: 0, contracts: 0, contractValueCents: 0, avgMarginPct: null },
      { repId: null, leads: 2, firstTouches: 0, medianSpeedSeconds: null, apptsSet: 0, noShows: 0, contracts: 0, contractValueCents: 0, avgMarginPct: null },
    ];
    const rowsOut = foldRepWeek(rows);
    expect(rowsOut).toHaveLength(2);
    const unassigned = rowsOut.find((r) => r.repId === null);
    expect(unassigned).toBeDefined();
    expect(unassigned!.leads).toBe(2);
  });
});

describe("rankReps", () => {
  function rep(repId: string | null, leads: number, contractValueCents: number): RepWeekRow {
    return {
      repId, leads, firstTouches: leads, contracts: 0, contractValueCents,
      apptsSet: 0, noShows: 0,
      speedMedianSeconds: { status: "pending", reason: "x" },
      pctUnderSla: { status: "pending", reason: "x" },
      noShowRate: { status: "pending", reason: "x" },
      avgMarginPct: { status: "pending", reason: "x" },
    };
  }

  it("ranks eligible reps by contract value descending", () => {
    const rows = [rep("a", 10, 100_00), rep("b", 10, 500_00), rep("c", 10, 200_00)];
    const ranked = rankReps(rows);
    expect(ranked.find((r) => r.repId === "b")!.rank).toBe(1);
    expect(ranked.find((r) => r.repId === "c")!.rank).toBe(2);
    expect(ranked.find((r) => r.repId === "a")!.rank).toBe(3);
  });

  it("marks reps below the leads threshold as insufficient volume, unranked", () => {
    const rows = [rep("a", MIN_LEADS_FOR_RANK - 1, 999_999_00), rep("b", MIN_LEADS_FOR_RANK, 1_00)];
    const ranked = rankReps(rows);
    const low = ranked.find((r) => r.repId === "a")!;
    expect(low.insufficientVolume).toBe(true);
    expect(low.rank).toBeNull();
    const ok = ranked.find((r) => r.repId === "b")!;
    expect(ok.insufficientVolume).toBe(false);
    expect(ok.rank).toBe(1);
  });

  it("never ranks the Unassigned (null repId) bucket, regardless of volume", () => {
    const rows = [rep(null, 500, 999_999_00), rep("a", MIN_LEADS_FOR_RANK, 1_00)];
    const ranked = rankReps(rows);
    const unassigned = ranked.find((r) => r.repId === null)!;
    expect(unassigned.rank).toBeNull();
    expect(unassigned.insufficientVolume).toBe(false); // not "insufficient volume" — it's just not a rep
  });
});

describe("foldSourceWeek", () => {
  it("sums counts additively across days for the same source", () => {
    const rows: DailySourceInput[] = [
      { source: "web", leads: 3, apptsSet: 1, contracts: 1, contractValueCents: 500_00, costCents: null },
      { source: "web", leads: 2, apptsSet: 1, contracts: 0, contractValueCents: 0, costCents: null },
    ];
    const [row] = foldSourceWeek(rows);
    expect(row!.leads).toBe(5);
    expect(row!.apptsSet).toBe(2);
    expect(row!.contracts).toBe(1);
    expect(row!.contractValueCents).toBe(500_00);
  });

  it("computes appointment rate, pending when no leads", () => {
    const [row] = foldSourceWeek([{ source: "web", leads: 4, apptsSet: 2, contracts: 0, contractValueCents: 0, costCents: null }]);
    expect(row!.apptRate).toEqual({ status: "ok", value: 0.5 });

    const [pendingRow] = foldSourceWeek([{ source: "referral", leads: 0, apptsSet: 0, contracts: 0, contractValueCents: 0, costCents: null }]);
    expect(pendingRow!.apptRate.status).toBe("pending");
  });

  it("renders costCents null (\"no cost data\") when no day for that source carries a cost figure", () => {
    const [row] = foldSourceWeek([
      { source: "web", leads: 1, apptsSet: 0, contracts: 0, contractValueCents: 0, costCents: null },
      { source: "web", leads: 1, apptsSet: 0, contracts: 0, contractValueCents: 0, costCents: undefined },
    ]);
    expect(row!.costCents).toBeNull();
  });

  it("sums only the days that carry cost data when at least one does", () => {
    const [row] = foldSourceWeek([
      { source: "web", leads: 1, apptsSet: 0, contracts: 0, contractValueCents: 0, costCents: 1000 },
      { source: "web", leads: 1, apptsSet: 0, contracts: 0, contractValueCents: 0, costCents: null },
    ]);
    expect(row!.costCents).toBe(1000);
  });

  it("keeps the unknown-source bucket as a labeled row, not hidden", () => {
    const rows = foldSourceWeek([{ source: "unknown", leads: 1, apptsSet: 0, contracts: 0, contractValueCents: 0, costCents: null }]);
    expect(rows.find((r) => r.source === "unknown")).toBeDefined();
  });
});

describe("foldLocationWeek / sumLocationWeeks (§8.12 empire view)", () => {
  // Builds a DailyMetrics fixture whose additive fields are cheap to assert on.
  function day(businessDate: string, opts: {
    leads?: number; apptsSet?: number; noShows?: number; contracts?: number; contractValueCents?: number;
    invoicedCents?: number; cashCollectedCents?: number; reviewsPosted?: number; estimatesApproved?: number;
    materialOrders?: number; jobsCompleted?: number;
  }): DailyMetrics {
    const m = emptyMetrics(businessDate);
    m.topLine.leadsTotal = opts.leads ?? 0;
    m.topLine.appointmentsSet = opts.apptsSet ?? 0;
    m.topLine.appointmentsNoShow = opts.noShows ?? 0;
    m.topLine.contractsSigned = opts.contracts ?? 0;
    m.topLine.contractValueCents = opts.contractValueCents ?? 0;
    m.topLine.jobsCompleted = opts.jobsCompleted ?? 0;
    m.money.invoicedCents = opts.invoicedCents ?? 0;
    m.money.cashCollectedCents = opts.cashCollectedCents ?? 0;
    m.quality.reviewsPosted = opts.reviewsPosted ?? 0;
    m.production.estimatesApproved = opts.estimatesApproved ?? 0;
    m.production.materialOrders = opts.materialOrders ?? 0;
    return m;
  }

  it("sums counts additively across days for the same location", () => {
    const rows: DailyLocationInput[] = [
      { locationId: "loc-a", metrics: day("2026-07-27", { leads: 3, apptsSet: 2, noShows: 1, contracts: 1, contractValueCents: 500_00 }) },
      { locationId: "loc-a", metrics: day("2026-07-28", { leads: 2, apptsSet: 1, contracts: 0 }) },
    ];
    const [row] = foldLocationWeek(rows);
    expect(row!.locationId).toBe("loc-a");
    expect(row!.leads).toBe(5);
    expect(row!.appointmentsSet).toBe(3);
    expect(row!.appointmentsNoShow).toBe(1);
    expect(row!.contracts).toBe(1);
    expect(row!.contractValueCents).toBe(500_00);
    expect(row!.noShowRate).toEqual({ status: "ok", value: 1 / 3 });
  });

  it("degrades no-show rate to pending when no appointments were set", () => {
    const [row] = foldLocationWeek([{ locationId: "loc-a", metrics: day("2026-07-27", {}) }]);
    expect(row!.noShowRate.status).toBe("pending");
  });

  it("never folds avgStars/avgMarginPct into a fake average — always pending (medians don't fold)", () => {
    const [row] = foldLocationWeek([{ locationId: "loc-a", metrics: day("2026-07-27", { leads: 1 }) }]);
    expect(row!.avgStars.status).toBe("pending");
    expect(row!.avgMarginPct.status).toBe("pending");
  });

  it("keeps the unattributed (null locationId) bucket separate from real locations, not hidden", () => {
    const rows: DailyLocationInput[] = [
      { locationId: "loc-a", metrics: day("2026-07-27", { leads: 3 }) },
      { locationId: null, metrics: day("2026-07-27", { leads: 2 }) },
    ];
    const folded = foldLocationWeek(rows);
    expect(folded).toHaveLength(2);
    const unattributed = folded.find((r) => r.locationId === null);
    expect(unattributed).toBeDefined();
    expect(unattributed!.leads).toBe(2);
  });

  it("§8.12 invariant: company total === sum of per-location rows, across multiple locations + the unattributed bucket", () => {
    const rows: DailyLocationInput[] = [
      { locationId: "loc-a", metrics: day("2026-07-27", { leads: 3, apptsSet: 2, noShows: 1, contracts: 1, contractValueCents: 500_00, invoicedCents: 100_00, reviewsPosted: 2, estimatesApproved: 1, materialOrders: 1, jobsCompleted: 1 }) },
      { locationId: "loc-a", metrics: day("2026-07-28", { leads: 1, apptsSet: 1 }) },
      { locationId: "loc-b", metrics: day("2026-07-27", { leads: 4, apptsSet: 3, contracts: 2, contractValueCents: 900_00, cashCollectedCents: 50_00 }) },
      { locationId: null, metrics: day("2026-07-27", { leads: 1 }) },
    ];
    const folded = foldLocationWeek(rows);
    const total = sumLocationWeeks(folded);

    const expectedLeads = rows.reduce((sum, r) => sum + r.metrics.topLine.leadsTotal, 0);
    const expectedApptsSet = rows.reduce((sum, r) => sum + r.metrics.topLine.appointmentsSet, 0);
    const expectedContracts = rows.reduce((sum, r) => sum + r.metrics.topLine.contractsSigned, 0);
    const expectedContractValue = rows.reduce((sum, r) => sum + r.metrics.topLine.contractValueCents, 0);
    const expectedInvoiced = rows.reduce((sum, r) => sum + r.metrics.money.invoicedCents, 0);
    const expectedCash = rows.reduce((sum, r) => sum + r.metrics.money.cashCollectedCents, 0);

    expect(total.leads).toBe(expectedLeads);
    expect(total.appointmentsSet).toBe(expectedApptsSet);
    expect(total.contracts).toBe(expectedContracts);
    expect(total.contractValueCents).toBe(expectedContractValue);
    expect(total.invoicedCents).toBe(expectedInvoiced);
    expect(total.cashCollectedCents).toBe(expectedCash);

    // Also the literal §8.12 phrasing: field-by-field sum of the per-location rows.
    expect(total.leads).toBe(folded.reduce((sum, r) => sum + r.leads, 0));
    expect(total.contractValueCents).toBe(folded.reduce((sum, r) => sum + r.contractValueCents, 0));
  });

  it("single-location tenant: company total equals the one location's row exactly (no rework needed at location #2)", () => {
    const rows: DailyLocationInput[] = [
      { locationId: "only-loc", metrics: day("2026-07-27", { leads: 5, apptsSet: 4, noShows: 1, contracts: 2, contractValueCents: 700_00, invoicedCents: 200_00, cashCollectedCents: 150_00, reviewsPosted: 3, estimatesApproved: 2, materialOrders: 1, jobsCompleted: 1 }) },
    ];
    const folded = foldLocationWeek(rows);
    expect(folded).toHaveLength(1);
    const total = sumLocationWeeks(folded);
    const [only] = folded;

    expect(total.leads).toBe(only!.leads);
    expect(total.appointmentsSet).toBe(only!.appointmentsSet);
    expect(total.contracts).toBe(only!.contracts);
    expect(total.contractValueCents).toBe(only!.contractValueCents);
    expect(total.invoicedCents).toBe(only!.invoicedCents);
    expect(total.cashCollectedCents).toBe(only!.cashCollectedCents);
    expect(total.noShowRate).toEqual(only!.noShowRate);
  });
});
