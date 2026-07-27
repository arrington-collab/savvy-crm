import { ok, pending, type MetricValue } from "./degradation";
import type { DailyMetrics } from "./metrics";

// D4-8: folds the D4-4 dimensional daily rows (`daily_metrics_by_rep` /
// `daily_metrics_by_source`, read via `getDailyByRepRange`/
// `getDailyBySourceRange`) over a week into one row per rep/source for the
// reps/sources dashboards (spec Appendix A.4, §8.11 "insufficient volume",
// §8.8 "never impute cost/ROI"). Pure — no DB, mirrors the
// "counts fold, medians re-derive" split `weekly.ts`'s `projectWeek` already
// uses for the company-wide fold:
//
//   - pure counts/sums (leads, appts, contracts, contractValueCents, …) FOLD
//     additively across the week's daily rows — cheap and exact.
//   - `medianSpeedSeconds` is a PER-DAY MEDIAN already (computed once by
//     `projectDayByRep` from that day's raw latencies). Averaging 7 daily
//     medians is NOT the true median over the pooled week — same caveat
//     `weekly.ts`'s header comment makes for the company-wide fold. The
//     textbook-correct fix (re-derive the true per-rep median straight from
//     `orchestrator_event`) would mean re-running attribution + per-rep event
//     scanning a second time, duplicating `dimensional.ts`'s
//     `projectDayByRep` — out of scope for what's meant to be a render-only
//     dashboard task (D4-8 brief: reuse the already-persisted dimensional
//     rows). The chosen weekly approximation is a firstTouches-weighted mean
//     of the days that *have* a median: it at least weights a busy day more
//     than a quiet one, rather than averaging every day equally. This is an
//     approximation, not the true weekly median — documented, not hidden.
//   - `% under SLA` cannot be folded OR approximated from
//     `daily_metrics_by_rep` at all: the table stores only each day's
//     *median* speed, never a per-day under-SLA count (that split only
//     exists at the company-wide `weekly.ts` `projectWeek` level, which
//     re-derives it straight from raw events with the quiet-hours-deferred
//     exemption applied). Guessing a percentage here from a median alone
//     would violate the "never impute" rule (§8.8), so it always renders
//     `pending` on the rep dashboard.

export interface RepWeekRow {
  /** null = the "Unassigned" bucket — unattributed activity, not a real rep. */
  repId: string | null;
  leads: number;
  firstTouches: number;
  speedMedianSeconds: MetricValue;
  pctUnderSla: MetricValue;
  apptsSet: number;
  noShows: number;
  noShowRate: MetricValue;
  contracts: number;
  contractValueCents: number;
  avgMarginPct: MetricValue;
}

export interface DailyRepInput {
  repId: string | null;
  leads: number;
  firstTouches: number;
  medianSpeedSeconds: number | null;
  apptsSet: number;
  noShows: number;
  contracts: number;
  contractValueCents: number;
  avgMarginPct: number | null;
}

const NULL_REP_KEY = "__unassigned__";

/** Folds N days' worth of `daily_metrics_by_rep` rows (any location) into one row per repId. */
export function foldRepWeek(rows: DailyRepInput[]): RepWeekRow[] {
  interface Bucket {
    repId: string | null;
    leads: number; firstTouches: number; apptsSet: number; noShows: number;
    contracts: number; contractValueCents: number;
    weightedSpeedSum: number; speedWeight: number;
    marginSum: number; marginDays: number;
  }
  const buckets = new Map<string, Bucket>();

  for (const r of rows) {
    const key = r.repId ?? NULL_REP_KEY;
    let b = buckets.get(key);
    if (!b) {
      b = {
        repId: r.repId, leads: 0, firstTouches: 0, apptsSet: 0, noShows: 0,
        contracts: 0, contractValueCents: 0, weightedSpeedSum: 0, speedWeight: 0,
        marginSum: 0, marginDays: 0,
      };
      buckets.set(key, b);
    }
    b.leads += r.leads;
    b.firstTouches += r.firstTouches;
    b.apptsSet += r.apptsSet;
    b.noShows += r.noShows;
    b.contracts += r.contracts;
    b.contractValueCents += r.contractValueCents;
    // Weight by that day's firstTouches — a day with more touches should
    // pull the weekly approximation harder than a day with only one or two.
    if (r.medianSpeedSeconds != null && r.firstTouches > 0) {
      b.weightedSpeedSum += r.medianSpeedSeconds * r.firstTouches;
      b.speedWeight += r.firstTouches;
    }
    if (r.avgMarginPct != null) {
      b.marginSum += r.avgMarginPct;
      b.marginDays += 1;
    }
  }

  return [...buckets.values()].map((b) => ({
    repId: b.repId,
    leads: b.leads,
    firstTouches: b.firstTouches,
    speedMedianSeconds: b.speedWeight > 0 ? ok(b.weightedSpeedSum / b.speedWeight) : pending("Twilio pending A2P"),
    pctUnderSla: pending("not tracked at rep granularity"),
    apptsSet: b.apptsSet,
    noShows: b.noShows,
    // Same denominator/formula as scorecard.ts's company-wide noShowRate — kept identical for consistency.
    noShowRate: b.apptsSet > 0 ? ok(b.noShows / b.apptsSet) : pending("no appointments set this week"),
    contracts: b.contracts,
    contractValueCents: b.contractValueCents,
    avgMarginPct: b.marginDays > 0 ? ok(b.marginSum / b.marginDays) : pending("no estimates approved this week"),
  }));
}

export interface RankedRepRow extends RepWeekRow {
  /** null = unranked — either insufficient volume, or the Unassigned bucket. */
  rank: number | null;
  insufficientVolume: boolean;
}

// PLACEHOLDER: 5 leads/week is a sensible stand-in threshold for "enough
// signal to rank a rep on", not a number Brett/Scott have confirmed — no
// recorded history backs this figure (§8.11: don't present noise as signal).
// Revisit once real volume data exists.
export const MIN_LEADS_FOR_RANK = 5;

/**
 * Ranks reps by the week's contract value (revenue), descending — the most
 * common EOS "who's carrying the board" read. The `Unassigned` bucket
 * (`repId === null`) is NEVER ranked (it isn't a rep), and any real rep under
 * `minLeads` for the week is excluded from the ranking and flagged
 * `insufficientVolume` instead of being assigned a misleadingly precise rank.
 */
export function rankReps(rows: RepWeekRow[], minLeads: number = MIN_LEADS_FOR_RANK): RankedRepRow[] {
  const rankable = rows.filter((r) => r.repId !== null && r.leads >= minLeads);
  const sorted = [...rankable].sort((a, b) => b.contractValueCents - a.contractValueCents);
  const rankByRepId = new Map(sorted.map((r, i) => [r.repId as string, i + 1]));

  return rows.map((r) => ({
    ...r,
    rank: r.repId !== null ? rankByRepId.get(r.repId) ?? null : null,
    insufficientVolume: r.repId !== null && r.leads < minLeads,
  }));
}

export interface SourceWeekRow {
  /** The "unknown" sentinel (UNKNOWN_SOURCE) is a real row here, never hidden. */
  source: string;
  leads: number;
  apptsSet: number;
  apptRate: MetricValue;
  contracts: number;
  contractValueCents: number;
  /** null = no source in the week had cost data — render "no cost data", never impute 0 (§8.8). */
  costCents: number | null;
}

export interface DailySourceInput {
  source: string;
  leads: number;
  apptsSet: number;
  contracts: number;
  contractValueCents: number;
  costCents: number | null | undefined;
}

/** Folds N days' worth of `daily_metrics_by_source` rows (any location) into one row per source. */
export function foldSourceWeek(rows: DailySourceInput[]): SourceWeekRow[] {
  interface Bucket {
    source: string; leads: number; apptsSet: number; contracts: number;
    contractValueCents: number; costSum: number; hasCost: boolean;
  }
  const buckets = new Map<string, Bucket>();

  for (const r of rows) {
    let b = buckets.get(r.source);
    if (!b) {
      b = { source: r.source, leads: 0, apptsSet: 0, contracts: 0, contractValueCents: 0, costSum: 0, hasCost: false };
      buckets.set(r.source, b);
    }
    b.leads += r.leads;
    b.apptsSet += r.apptsSet;
    b.contracts += r.contracts;
    b.contractValueCents += r.contractValueCents;
    // Only sum the days that actually carry a cost figure — a day with no
    // cost data contributes nothing (never treated as a real $0 spend day).
    if (r.costCents != null) {
      b.costSum += r.costCents;
      b.hasCost = true;
    }
  }

  return [...buckets.values()].map((b) => ({
    source: b.source,
    leads: b.leads,
    apptsSet: b.apptsSet,
    apptRate: b.leads > 0 ? ok(b.apptsSet / b.leads) : pending("no leads this week"),
    contracts: b.contracts,
    contractValueCents: b.contractValueCents,
    costCents: b.hasCost ? b.costSum : null,
  }));
}

// --- D4-9: location empire view fold ----------------------------------------
//
// Folds the D4-4 dimensional daily rows (`daily_metrics_by_location`, read via
// `getDailyByLocationRange`) over a week into one row per location, for the
// "empire view" (spec §6d/§8.12: company totals + per-location breakdown +
// side-by-side comparison of the same measurables). Each daily row already
// carries a full `DailyMetrics` blob (one location's `projectDay` output for
// that date) — only the pure counts/sums fold additively across the week;
// `speed.median_seconds` / `margin.avg_pct` / `reviews.avg_stars` are averages
// over *events*, not something a per-day-per-location median/mean can be
// re-averaged into honestly (same "medians don't fold" rule `weekly.ts` and
// `foldRepWeek` document above) — re-deriving them per-location from
// `orchestrator_event` is out of scope for a render-only dashboard task, so
// they render `pending` here rather than a misleading average-of-averages.
//
// `locationId: null` is the **unattributed** bucket (events whose location
// couldn't be resolved — `UNKNOWN_LOCATION`, translated to SQL NULL by
// `sqlLocationId`), NOT the company total. It is one row among the
// per-location breakdown like any other, just labeled clearly by the caller.
// The company total is a SEPARATE synthesized row (`sumLocationWeeks`) that
// sums every bucket returned here, unattributed included — the §8.12
// invariant is company total === sum of the per-location rows.

export interface LocationWeekRow {
  /** null = the "unattributed" bucket — events with no resolvable locationId, not a real location. */
  locationId: string | null;
  leads: number;
  appointmentsSet: number;
  appointmentsNoShow: number;
  noShowRate: MetricValue;
  contracts: number;
  contractValueCents: number;
  invoicedCents: number;
  cashCollectedCents: number;
  reviewsPosted: number;
  avgStars: MetricValue;
  estimatesApproved: number;
  avgMarginPct: MetricValue;
  materialOrders: number;
  jobsCompleted: number;
}

export interface DailyLocationInput {
  locationId: string | null;
  metrics: DailyMetrics;
}

const NULL_LOCATION_KEY = "__unattributed__";

const AVG_STARS_PENDING_REASON = "avg stars not derivable from a location fold — needs per-event re-scan";
const AVG_MARGIN_PENDING_REASON = "avg margin not derivable from a location fold — needs per-event re-scan";

/** Folds N days' worth of `daily_metrics_by_location` rows into one row per locationId. */
export function foldLocationWeek(rows: DailyLocationInput[]): LocationWeekRow[] {
  interface Bucket {
    locationId: string | null;
    leads: number; appointmentsSet: number; appointmentsNoShow: number;
    contracts: number; contractValueCents: number;
    invoicedCents: number; cashCollectedCents: number;
    reviewsPosted: number; estimatesApproved: number; materialOrders: number; jobsCompleted: number;
  }
  const buckets = new Map<string, Bucket>();

  for (const r of rows) {
    const key = r.locationId ?? NULL_LOCATION_KEY;
    let b = buckets.get(key);
    if (!b) {
      b = {
        locationId: r.locationId, leads: 0, appointmentsSet: 0, appointmentsNoShow: 0,
        contracts: 0, contractValueCents: 0, invoicedCents: 0, cashCollectedCents: 0,
        reviewsPosted: 0, estimatesApproved: 0, materialOrders: 0, jobsCompleted: 0,
      };
      buckets.set(key, b);
    }
    const d = r.metrics;
    b.leads += d.topLine.leadsTotal;
    b.appointmentsSet += d.topLine.appointmentsSet;
    b.appointmentsNoShow += d.topLine.appointmentsNoShow;
    b.contracts += d.topLine.contractsSigned;
    b.contractValueCents += d.topLine.contractValueCents;
    b.jobsCompleted += d.topLine.jobsCompleted;
    b.invoicedCents += d.money.invoicedCents;
    b.cashCollectedCents += d.money.cashCollectedCents;
    b.reviewsPosted += d.quality.reviewsPosted;
    b.estimatesApproved += d.production.estimatesApproved;
    b.materialOrders += d.production.materialOrders;
  }

  return [...buckets.values()].map((b) => ({
    locationId: b.locationId,
    leads: b.leads,
    appointmentsSet: b.appointmentsSet,
    appointmentsNoShow: b.appointmentsNoShow,
    // Same denominator/formula as scorecard.ts's company-wide noShowRate.
    noShowRate: b.appointmentsSet > 0 ? ok(b.appointmentsNoShow / b.appointmentsSet) : pending("no appointments set this week"),
    contracts: b.contracts,
    contractValueCents: b.contractValueCents,
    invoicedCents: b.invoicedCents,
    cashCollectedCents: b.cashCollectedCents,
    reviewsPosted: b.reviewsPosted,
    avgStars: pending(AVG_STARS_PENDING_REASON),
    estimatesApproved: b.estimatesApproved,
    avgMarginPct: pending(AVG_MARGIN_PENDING_REASON),
    materialOrders: b.materialOrders,
    jobsCompleted: b.jobsCompleted,
  }));
}

/** The company-wide row: every per-location row, unattributed bucket included. */
export type CompanyLocationTotal = Omit<LocationWeekRow, "locationId">;

/**
 * Sums `foldLocationWeek`'s per-location rows into one company-wide total.
 * Since the buckets `foldLocationWeek` produces are a strict partition of the
 * same daily rows (§8.2), this MUST equal what folding all locations' daily
 * rows together (ignoring locationId) would produce — the §8.12 invariant
 * ("company total === sum of locations"). Exposed standalone (not just
 * inlined in the page) so a unit test can assert the invariant directly,
 * and so the empire page never has to hand-roll company arithmetic.
 */
export function sumLocationWeeks(rows: LocationWeekRow[]): CompanyLocationTotal {
  let leads = 0, appointmentsSet = 0, appointmentsNoShow = 0, contracts = 0, contractValueCents = 0;
  let invoicedCents = 0, cashCollectedCents = 0, reviewsPosted = 0, estimatesApproved = 0, materialOrders = 0, jobsCompleted = 0;

  for (const r of rows) {
    leads += r.leads;
    appointmentsSet += r.appointmentsSet;
    appointmentsNoShow += r.appointmentsNoShow;
    contracts += r.contracts;
    contractValueCents += r.contractValueCents;
    invoicedCents += r.invoicedCents;
    cashCollectedCents += r.cashCollectedCents;
    reviewsPosted += r.reviewsPosted;
    estimatesApproved += r.estimatesApproved;
    materialOrders += r.materialOrders;
    jobsCompleted += r.jobsCompleted;
  }

  return {
    leads, appointmentsSet, appointmentsNoShow,
    noShowRate: appointmentsSet > 0 ? ok(appointmentsNoShow / appointmentsSet) : pending("no appointments set this week"),
    contracts, contractValueCents, invoicedCents, cashCollectedCents, reviewsPosted,
    avgStars: pending(AVG_STARS_PENDING_REASON),
    estimatesApproved,
    avgMarginPct: pending(AVG_MARGIN_PENDING_REASON),
    materialOrders, jobsCompleted,
  };
}
