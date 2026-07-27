import { ok, pending, type MetricValue } from "./degradation";
import type { WeeklyFold } from "./weekly";

// D4-6: the EOS weekly scorecard (spec §6a, Appendix A.2). Pure — no DB. This
// is the "one function per number" WeeklyFold -> per-metricKey explosion the
// design doc calls for: every measurable on the scorecard traces to exactly
// one entry in METRIC_EXTRACTORS below, never re-derived ad hoc on a page.
//
// Two things this file deliberately does NOT do (kept pure/DB-free):
//   - `close_rate.cohort` needs "as of now" leads/contracts joins, and
//     `exceptions.open` needs the exception_queue table. Neither is
//     derivable from `WeeklyFold` alone, so both are computed by
//     `rebuildWeek` (real DB access, packages/db) and handed in as
//     already-resolved `MetricValue`s via `ScorecardExtras`. Omitting them
//     (e.g. in a unit test) degrades honestly to "pending", never a fake 0.
//   - Goals: `buildScorecard` only CONSUMES a resolved goal map — reading
//     `scorecard_goal` / falling back to placeholder defaults lives in
//     `packages/db/src/command-center/scorecard-goals.ts` (`getGoals`),
//     which is the only place allowed to define real target numbers.

/** A configured (or placeholder-default) target for one metricKey. */
export interface GoalConfig {
  target: number;
  direction: "gte" | "lte";
  isPlaceholder: boolean;
}

/** One EOS scorecard line: measurable · owner · this week · goal · on/off-track · 13-week sparkline. */
export interface ScorecardRow {
  metricKey: string;
  owner: string;
  value: MetricValue;
  goal: GoalConfig | null;
  onTrack: boolean | null;
  /** Oldest→newest, always exactly 13 entries including this week's own numeric value (null if pending). */
  priorWeeks: (number | null)[];
  isPlaceholderGoal: boolean;
}

/**
 * Extra inputs `buildScorecard` needs beyond the pure `WeeklyFold` bundle —
 * real-DB reads only `rebuildWeek` can do (cohort close rate, exception
 * queue). Each is optional so pure unit tests can omit them; an omitted
 * extra renders "pending" for its metric rather than silently defaulting to 0.
 */
export interface ScorecardExtras {
  closeRateCohort?: MetricValue;
  closeRateActivity?: MetricValue;
  exceptionsOpen?: MetricValue;
}

/**
 * On/off-track (spec §6a): **null** — not false — when the value can't be
 * judged yet, either because it's still `pending` (graceful degradation, §7)
 * or because no goal is configured for it. Never fabricates a verdict.
 */
export function evaluateOnTrack(value: MetricValue, goal: GoalConfig | null | undefined): boolean | null {
  if (value.status === "pending") return null;
  if (!goal) return null;
  return goal.direction === "gte" ? value.value >= goal.target : value.value <= goal.target;
}

// Owner defaults — role labels, NOT specific people. Brett/Scott haven't
// assigned a named accountable owner per EOS measurable yet; these are
// sensible role-based stand-ins so the scorecard renders something
// meaningful, flagged in the D4-6 report as needing a real roster.
export const OWNER_DEFAULTS: Record<string, string> = {
  "leads.new": "Marketing",
  "speed.median_seconds": "Sales Manager",
  "speed.pct_under_sla": "Sales Manager",
  "appts.set": "Sales Manager",
  "appts.no_show_rate": "Sales Manager",
  "contracts.count": "Sales Manager",
  "contracts.value": "Sales Manager",
  "close_rate.cohort": "Sales Manager",
  "close_rate.activity": "Sales Manager",
  "revenue.invoiced": "Office Manager",
  "cash.collected": "Office Manager",
  "margin.avg_pct": "Estimator",
  "reviews.count": "Customer Experience",
  "reviews.avg_stars": "Customer Experience",
  "exceptions.open": "Ops",
};

function noShowRate(w: WeeklyFold): MetricValue {
  const { appointmentsSet, appointmentsNoShow } = w.topLine;
  return appointmentsSet === 0 ? pending("no appointments set this week") : ok(appointmentsNoShow / appointmentsSet);
}

// The WeeklyFold -> per-metricKey mapping (spec Appendix A.2). Key order here
// is also the scorecard's definition order (buildScorecard's stable sort only
// reorders across onTrack tiers, so ties within a tier keep this order).
const METRIC_EXTRACTORS: Record<string, (w: WeeklyFold, extra: ScorecardExtras) => MetricValue> = {
  "leads.new": (w) => ok(w.topLine.leadsTotal),
  "speed.median_seconds": (w) => w.speed.median_seconds,
  "speed.pct_under_sla": (w) => w.speed.pct_under_sla,
  "appts.set": (w) => ok(w.topLine.appointmentsSet),
  "appts.no_show_rate": (w) => noShowRate(w),
  "contracts.count": (w) => ok(w.topLine.contractsSigned),
  "contracts.value": (w) => ok(w.topLine.contractValueCents),
  "close_rate.cohort": (_w, extra) => extra.closeRateCohort ?? pending("cohort close rate not computed"),
  "close_rate.activity": (_w, extra) => extra.closeRateActivity ?? pending("activity close rate not computed"),
  "revenue.invoiced": (w) => ok(w.money.invoicedCents),
  "cash.collected": (w) => ok(w.money.cashCollectedCents),
  "margin.avg_pct": (w) => w.margin.avg_pct,
  "reviews.count": (w) => ok(w.quality.reviewsPosted),
  "reviews.avg_stars": (w) => w.reviews.avg_stars,
  "exceptions.open": (_w, extra) => extra.exceptionsOpen ?? pending("exception queue not loaded"),
};

/** The ~10-15 A.2 measurables this scorecard renders, in definition order. */
export const MEASURABLE_KEYS: readonly string[] = Object.keys(METRIC_EXTRACTORS);

function onTrackRank(onTrack: boolean | null): number {
  // Off-track first (needs attention now) · pending/no-goal second (can't
  // judge yet, but don't bury it behind confirmed-good rows) · on-track last
  // (confirmed fine — lowest reading priority). Spec §8.5 only mandates
  // off-track-first; the null tier's placement is this file's own call.
  if (onTrack === false) return 0;
  if (onTrack === null) return 1;
  return 2;
}

/**
 * Left-pads/truncates `history` (oldest→newest, NOT including the current
 * week) to exactly 12 entries, then appends `current` — always exactly 13
 * (§8.4). Missing history (a metric's first week, or the metric simply
 * having no row yet) pads with null, never a fabricated 0.
 */
function padPriorWeeks(history: (number | null)[] | undefined, current: number | null): (number | null)[] {
  const h = history ?? [];
  const last12 = h.length >= 12 ? h.slice(-12) : [...Array(12 - h.length).fill(null), ...h];
  return [...last12, current];
}

export interface BuildScorecardInput extends ScorecardExtras {
  weekly: WeeklyFold;
  /**
   * Per-metricKey trailing history, oldest→newest, NOT including the current
   * week (this function appends the current week's own value) — typically
   * 12 entries. A metricKey missing from this map, or with a shorter/longer
   * array, is padded/truncated by `padPriorWeeks` so every row still comes
   * out to exactly 13 entries.
   */
  priorWeeks: Record<string, (number | null)[]>;
  goals: Record<string, GoalConfig>;
}

/**
 * Assembles the EOS scorecard: one `ScorecardRow` per `MEASURABLE_KEYS`
 * entry, off-track rows sorted first (§8.5). Pure — everything it needs is
 * already resolved and handed in.
 */
export function buildScorecard(input: BuildScorecardInput): ScorecardRow[] {
  const { weekly, priorWeeks, goals } = input;

  const rows: ScorecardRow[] = MEASURABLE_KEYS.map((metricKey) => {
    const value = METRIC_EXTRACTORS[metricKey]!(weekly, input);
    const goal = goals[metricKey] ?? null;
    const onTrack = evaluateOnTrack(value, goal);
    const current = value.status === "ok" ? value.value : null;
    return {
      metricKey,
      owner: OWNER_DEFAULTS[metricKey] ?? "Unassigned",
      value,
      goal,
      onTrack,
      priorWeeks: padPriorWeeks(priorWeeks[metricKey], current),
      // No goal at all is treated the same as a placeholder for this flag's
      // purpose: either way, the number on screen isn't a real Brett/Scott
      // target yet and the UI should say so.
      isPlaceholderGoal: goal?.isPlaceholder ?? true,
    };
  });

  return rows.sort((a, b) => onTrackRank(a.onTrack) - onTrackRank(b.onTrack));
}
