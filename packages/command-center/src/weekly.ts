import type { DomainEvent, PayloadFor } from "@savvy/orchestrator";
import type { DailyMetrics } from "./metrics";
import { ok, pending, type MetricValue } from "./degradation";

// D4-5 weekly fold + honesty-critical close-rate split (spec Appendix A.2/A.3,
// §8.1/§8.6/§8.7). Pure — no DB/UI.
//
// The two-real-design-decisions rule (§ "Medians/averages don't fold"):
//   - pure counts/sums (leads, appts, contracts, contractValueCents, money, …)
//     FOLD from the 7 `DailyMetrics` daily rows (additive, cheap, correct).
//   - medians/rates (speed.median_seconds, speed.pct_under_sla, margin.avg_pct,
//     reviews.avg_stars) are RE-DERIVED from `weekEvents` directly — averaging
//     7 daily medians is not the same number as the true median over the
//     pooled week, and would be silently wrong.
//
// NOTE for D4-6: this does NOT return the `WeeklyMetrics` type already
// exported from `weekly-metrics.ts` — that type is a single-metric-row shape
// (one row per `(weekStart, locationId, metricKey)`, matching the
// `weekly_scorecard` persisted table for the 13-week sparkline). What
// `projectWeek` needs to produce is a full weekly bundle analogous to
// `DailyMetrics` but for a week, with `MetricValue` on the fields that can be
// "pending". That's a different shape, so it's named `WeeklyFold` here to
// avoid colliding with the existing exported name. D4-6's persistence layer
// will need to explode a `WeeklyFold` into one `WeeklyMetrics` row per
// `metricKey` (and `weekly_scorecard.value` being `jsonb` is exactly what
// makes storing a `MetricValue` there possible).
export interface WeeklyFold {
  weekStart: string; // Monday YYYY-MM-DD, Denver business date
  topLine: {
    leadsTotal: number;
    leadsBySource: Record<string, number>;
    appointmentsSet: number;
    appointmentsNoShow: number;
    contractsSigned: number;
    contractValueCents: number;
    jobsCompleted: number;
  };
  money: {
    invoicedCents: number;
    cashCollectedCents: number;
    supplementsApprovedCents: number;
    /** Point-in-time snapshot (not additive across days) — the most recent
     *  daily row's reading, same convention `projectDay` uses per-invoice. */
    arPastDue: { d30: number; d60: number; d90: number };
  };
  quality: { reviewsPosted: number };
  production: { estimatesApproved: number; materialOrders: number };
  /** Re-derived from `weekEvents`, never folded from daily medians (A.2). */
  speed: { median_seconds: MetricValue; pct_under_sla: MetricValue };
  margin: { avg_pct: MetricValue };
  reviews: { avg_stars: MetricValue };
}

// Same 5-minute SLA threshold `projection.ts` uses for the daily projection
// (kept as its own constant here since projection.ts doesn't export it —
// re-derivation from events must use the identical definition).
const SLA_SECONDS = 5 * 60;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function projectWeek(input: {
  dailyRows: DailyMetrics[];
  weekEvents: DomainEvent[];
  weekStart: string;
}): WeeklyFold {
  const { dailyRows, weekEvents, weekStart } = input;
  const sorted = [...dailyRows].sort((a, b) => a.businessDate.localeCompare(b.businessDate));

  const topLine: WeeklyFold["topLine"] = {
    leadsTotal: 0,
    leadsBySource: {},
    appointmentsSet: 0,
    appointmentsNoShow: 0,
    contractsSigned: 0,
    contractValueCents: 0,
    jobsCompleted: 0,
  };
  const money: WeeklyFold["money"] = {
    invoicedCents: 0,
    cashCollectedCents: 0,
    supplementsApprovedCents: 0,
    arPastDue: { d30: 0, d60: 0, d90: 0 },
  };
  let reviewsPosted = 0;
  let estimatesApproved = 0;
  let materialOrders = 0;

  for (const day of sorted) {
    topLine.leadsTotal += day.topLine.leadsTotal;
    for (const [source, n] of Object.entries(day.topLine.leadsBySource)) {
      topLine.leadsBySource[source] = (topLine.leadsBySource[source] ?? 0) + n;
    }
    topLine.appointmentsSet += day.topLine.appointmentsSet;
    topLine.appointmentsNoShow += day.topLine.appointmentsNoShow;
    topLine.contractsSigned += day.topLine.contractsSigned;
    topLine.contractValueCents += day.topLine.contractValueCents;
    topLine.jobsCompleted += day.topLine.jobsCompleted;

    money.invoicedCents += day.money.invoicedCents;
    money.cashCollectedCents += day.money.cashCollectedCents;
    money.supplementsApprovedCents += day.money.supplementsApprovedCents;

    reviewsPosted += day.quality.reviewsPosted;
    estimatesApproved += day.production.estimatesApproved;
    materialOrders += day.production.materialOrders;
  }
  const lastDay = sorted[sorted.length - 1];
  if (lastDay) money.arPastDue = { ...lastDay.money.arPastDue };

  // --- re-derive medians/rates directly from the week's events (A.2) ---
  const latencies: number[] = [];
  let slaEligible = 0;
  let underSla = 0;
  for (const e of weekEvents) {
    if (e.type !== "lead.first_touch") continue;
    const p = e.payload as PayloadFor<"lead.first_touch">;
    const secs = p.slaLatencySeconds ?? p.latencySeconds;
    if (secs == null) continue;
    latencies.push(secs);
    slaEligible += 1;
    // A quiet-hours-deferred first touch is NEVER counted as a breach,
    // regardless of how large `secs` is — the delay was policy-mandated (the
    // SLA clock was legitimately paused while quiet hours were in effect),
    // not a rep failure, so it would be dishonest to penalize it (§8.7).
    //
    // This is a blanket exemption, not a "judge from window-open" adjustment
    // (spec A.2 language). It would be more precise to compare the touch
    // against the SLA measured from when the quiet-hours window reopened,
    // but `slaLatencySeconds` does not carry that yet: Slice B's
    // `lead-intake.ts:202` currently sets `slaLatencySeconds: a.latencySeconds`
    // — a straight copy of `latencySeconds`, not a window-open-adjusted value.
    // Until Slice B computes a real window-open latency for deferred leads,
    // the blanket exemption is the only honest signal available here, and
    // testing `secs > SLA` for a deferred lead would just wrongly penalize a
    // rep for a system-mandated delay. Revisit this once a true window-open
    // latency exists upstream.
    const breach = !p.quietHoursDeferred && secs > SLA_SECONDS;
    if (!breach) underSla += 1;
  }
  const speedMedian: MetricValue = latencies.length ? ok(median(latencies)) : pending("Twilio pending A2P");
  const speedPctUnderSla: MetricValue = slaEligible === 0 ? pending("Twilio pending A2P") : ok(underSla / slaEligible);

  const margins = weekEvents
    .filter((e) => e.type === "estimate.approved")
    .map((e) => (e.payload as PayloadFor<"estimate.approved">).marginPct);
  const marginAvg: MetricValue = margins.length ? ok(mean(margins)) : pending("no estimates approved this week");

  const stars = weekEvents
    .filter((e) => e.type === "review.posted")
    .map((e) => (e.payload as PayloadFor<"review.posted">).stars);
  const reviewsAvg: MetricValue = stars.length ? ok(mean(stars)) : pending("no reviews yet");

  return {
    weekStart,
    topLine,
    money,
    quality: { reviewsPosted },
    production: { estimatesApproved, materialOrders },
    speed: { median_seconds: speedMedian, pct_under_sla: speedPctUnderSla },
    margin: { avg_pct: marginAvg },
    reviews: { avg_stars: reviewsAvg },
  };
}

// A cohort needs time to mature (leads created late in the week haven't had a
// full sales cycle yet). No exact figure is specified in the design spec
// beyond the illustrative "12 days old, still maturing" example, so 30 days
// (a conservative reading of a typical roofing signing cycle) is used as the
// default maturity threshold. Flagged in the D4-5 report for confirmation —
// D4-6/dashboard copy may want this configurable rather than hard-coded.
//
// PLACEHOLDER: this is an assumed default, not a business figure confirmed by
// Brett/Scott (no recorded history backs "30 days" as the true signing-cycle
// maturity point for this business). Do not treat 30 as spec-pinned — it's a
// reasonable guess standing in until they confirm the real number.
const COHORT_MATURITY_DAYS = 30;

/**
 * `close_rate.cohort` (A.3): for leads CREATED in week W, the share that have
 * signed AS OF NOW. Correct but lags — always reports its own maturity so the
 * dashboard can caveat a young cohort instead of presenting it as final.
 */
export function closeRateCohort(input: {
  leadsCreatedInWeek: { leadId: string; createdAt: Date }[];
  contractsAsOfNow: { leadId: string; signedAt: Date }[];
  now: Date;
  weekStart: string;
}): { rate: number; cohortAgeDays: number; maturing: boolean } {
  const { leadsCreatedInWeek, contractsAsOfNow, now, weekStart } = input;
  const signedLeadIds = new Set(contractsAsOfNow.map((c) => c.leadId));
  const signedCount = leadsCreatedInWeek.filter((l) => signedLeadIds.has(l.leadId)).length;
  const rate = leadsCreatedInWeek.length === 0 ? 0 : signedCount / leadsCreatedInWeek.length;

  const weekStartMs = Date.parse(`${weekStart}T00:00:00.000Z`);
  const cohortAgeDays = Math.floor((now.getTime() - weekStartMs) / 86_400_000);
  const maturing = cohortAgeDays < COHORT_MATURITY_DAYS;

  return { rate, cohortAgeDays, maturing };
}

/**
 * `close_rate.activity` (A.3): contracts ÷ leads WITHIN THE SAME WEEK — a
 * throughput pulse, not a conversion rate (it mixes contracts from leads of
 * any cohort with this week's lead volume). Always labeled `basis: "activity"`
 * so it can never be silently presented as, or swapped for, the cohort rate.
 */
export function closeRateActivity(
  contractsThisWeek: number,
  leadsThisWeek: number,
): { rate: number; basis: "activity" } {
  return { rate: leadsThisWeek === 0 ? 0 : contractsThisWeek / leadsThisWeek, basis: "activity" };
}
