import type { DailyMetrics } from "./metrics";

// Pure types only (spec `docs/superpowers/specs/2026-07-27-day4-weekly-scorecard-design.md`
// Architecture / Appendix A.4 "Dimensional table contract"). The DB tables land in
// D4-2 — field names here are chosen to match those tables exactly so the two
// stay aligned without a translation layer.

/**
 * One `(tenant, date, locationId, repId)` row, folded from `orchestrator_event`.
 * Backs the `daily_metrics_by_rep` table (additive; `daily_metrics` untouched).
 */
export interface DailyMetricsByRep {
  date: string; // YYYY-MM-DD, Denver business date
  tenantId: string;
  locationId: string;
  repId: string;
  leads: number;
  firstTouches: number;
  medianSpeedSeconds: number | null;
  apptsSet: number;
  noShows: number;
  contracts: number;
  contractValueCents: number;
  estimatesApproved: number;
  avgMarginPct: number | null;
}

/**
 * One `(tenant, date, locationId, source)` row. Backs `daily_metrics_by_source`.
 * `costCents` is optional — not every source has known acquisition cost.
 */
export interface DailyMetricsBySource {
  date: string; // YYYY-MM-DD, Denver business date
  tenantId: string;
  locationId: string;
  source: string;
  leads: number;
  apptsSet: number;
  contracts: number;
  contractValueCents: number;
  costCents?: number;
}

/**
 * One `(tenant, date, locationId)` row carrying the same core measures as
 * `daily_metrics` (topLine/money/speed/quality/production), scoped to a single
 * location instead of the tenant-wide rollup. Backs `daily_metrics_by_location`.
 */
export interface DailyMetricsByLocation {
  date: string; // YYYY-MM-DD, Denver business date
  tenantId: string;
  locationId: string;
  metrics: DailyMetrics;
}

/** The three dimensional daily row shapes §5/A.4 introduces alongside `daily_metrics`. */
export type DimensionalDaily = DailyMetricsByRep | DailyMetricsBySource | DailyMetricsByLocation;

/**
 * One `(weekStart, tenantId, locationId, metricKey)` row — a single frozen
 * metric (Appendix A.2) for one week, with its 13-week trailing history for
 * the sparkline. Backs the `weekly_scorecard` table.
 */
export interface WeeklyMetrics {
  weekStart: string; // Monday YYYY-MM-DD, Denver business date
  tenantId: string;
  locationId: string | null; // null = company-wide rollup
  metricKey: string; // Appendix A.2 metric dictionary key, e.g. "leads.new"
  value: number | null;
  goal: number | null;
  onTrack: boolean | null;
  /** Oldest→newest, 13 entries including the current week's `value`. */
  priorWeeks: (number | null)[];
}
