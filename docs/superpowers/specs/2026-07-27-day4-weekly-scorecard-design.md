# Day 4 — Weekly EOS Scorecard & Rep / Source / Location Dashboards (Design)

**Date:** 2026-07-27
**Status:** Approved (Brett's pasted Day-4 build prompt is the design; formalized here + grounded in the codebase). Extends `packages/command-center` (Day 2). Pure read model — writes no business state, calls no other tool.
**Depends only on frozen contracts:** Day 2's `daily_metrics` + `exception_queue`, and Day 3 Appendix A.1 events. Runs correctly whether Day 3 is fully live or A2P-pending — graceful degradation (§7) is a requirement, not a nicety.

## The mission
Day 2 gave the *daily heartbeat* (what happened today / what needs me now). Day 4 gives the *weekly trend + accountability* (are we on track, who's performing, which source pays, which location slips) — and, as locations multiply, lets Arrington compare markets without visiting them. The hard part is **trust, not computation**: every metric gets one frozen definition, honest denominators, and visible "as of / based on" provenance. A dashboard whose numbers can't be defended is worse than none.

## Codebase grounding (verified)
- **Day 2 already blueprinted this:** `docs/superpowers/specs/2026-07-25-command-center-day2-design.md:144-146` — "Day 4 reads the same `daily_metrics` rolled to a week and the same `exception_queue`. Extend, don't reshape. The weekly scorecard is a fold of daily rows, not a new pipeline."
- **`daily_metrics`** (`packages/db/src/schema/command-center.ts:6-16`): one row per `(tenant, business_date)`, `metrics` jsonb = `DailyMetrics` (`packages/command-center/src/metrics.ts:1-21`: topLine/money/speed/quality/production). Frozen — Day 4 does NOT reshape it.
- **`projectDay`** (`packages/command-center/src/projection.ts:14`): per-day pure fold; **no weekly or dimensional aggregation exists**. Speed-to-lead reads `latencySeconds`/`slaLatencySeconds` from the Day-3 bridge.
- **`exception_queue`** + `QueueItem` lifecycle (`packages/command-center/src/exception-queue.ts`): `isActive`, `needsYouFor`, `openCount` reusable for the accountability panel.
- **⚠️ No `daily_metrics` generation cron exists** — rows are written ONLY by the on-demand `apps/web/src/app/api/flash/route.ts`. A weekly rollup cannot assume daily rows exist. **Resolution:** Day 4 rebuilds the daily (dimensional) rows it needs directly from `orchestrator_event` (`rebuildDay`/`rebuildWeek`), per §4 "replayable / rebuild from the log."
- **Day-3 events carry the dimensions:** `lead.assigned` → `repId`/`territory`/`locationId`; most A.1 events carry `locationId`. `projectDay` ignores comms events (falls through `default`) — they're available raw.
- **Delivery/cron pattern:** `packages/agents/src/functions/ops-digest.ts:11-34` (hourly cron, tenant-local-hour gating) is the template for the Monday push. Flash delivery today is mock-only (`packages/command-center/src/seams.ts`).
- **UI:** no chart library; dashboards = `Card` + `MetricCard` + plain `<table>` + CSS tokens. `apps/web/src/app/(app)/reports/close-rate/page.tsx` is the page template (server component, `force-dynamic`, tenant-scoped `@savvy/db` fetch → pure transform → shadcn). 13-week trend → tiny **inline-SVG sparkline** (no new dep, theme tokens).
- **Week/day helpers:** `businessDateOf`/`denverDayWindow`/`denverMidnightUtc` (`packages/command-center/src/day-window.ts`, DST-robust); civil-date arithmetic `addDays` (`packages/core/src/schedule-view.ts:48`). A `denverWeekWindow` + week-date enumeration is new.

## Architecture
```
orchestrator_event ─► (Day 2 projector) ─► daily_metrics                 ─┐
                   └► (Day 4 projectors) ─► daily_metrics_by_rep          ├─► weekly_scorecard (13-wk) ─► scorecard page + Monday push
                                            daily_metrics_by_source       │
                                            daily_metrics_by_location    ─┘
exception_queue ───────────────────────────────────────────────────────────► accountability panel
```
**New tables (additive, RLS, `packages/db` schema + one migration — LOCAL DEV ONLY, not prod):**
- `daily_metrics_by_rep` `{ date, tenantId, locationId, repId, leads, firstTouches, medianSpeedSeconds, apptsSet, noShows, contracts, contractValueCents, estimatesApproved, avgMarginPct }`
- `daily_metrics_by_source` `{ date, tenantId, locationId, source, leads, apptsSet, contracts, contractValueCents, costCents? }`
- `daily_metrics_by_location` `{ date, tenantId, locationId, …same core measures as daily_metrics }`
- `weekly_scorecard` `{ weekStart, tenantId, locationId|null, metricKey, value, goal, onTrack, priorWeeks jsonb[13] }` — upsert on `(weekStart, tenantId, locationId, metricKey)`
- `scorecard_goal` `{ tenantId, locationId|null, metricKey, target, direction ('gte'|'lte'), isPlaceholder }` — **the configurable goals table; ships with clearly-labeled placeholder defaults until Arrington sets real numbers.**

## Design principles (from the prompt)
- **Extend, never reshape.** `daily_metrics`/`exception_queue` frozen. Day 4 adds sibling tables; no migration of existing contracts.
- **Roll from aggregates, not raw events** — weekly = fold of daily rows; only touch `orchestrator_event` for dimensional facts + medians daily rows don't carry (keeps 13-week × N-location cheap).
- **Honest denominators.** Cohort close rate lags and must not be faked; activity-basis is labeled, never presented as conversion (A.3).
- **One definition per metric, frozen** (Appendix A.2). If a number appears twice it comes from one function.
- **Location-aware from day one.** Every aggregate carries `locationId`; company view = roll-up, drill-down = filter.
- **Replayable.** `rebuildWeek(weekStart)` / `rebuildDay(date)` reconstruct from the log; same input → same output.

## The panels (§6)
- **a. EOS weekly scorecard** — one row per measurable: owner · weekly goal · this week · 13-week sparkline · binary on/off-track. Off-track sorts to top. ~10–15 measurables (90-second read).
- **b. Rep dashboard** — per rep: leads, speed-to-lead (median + % under SLA), appts, no-show rate, contracts, revenue, avg margin, rank. Explicit **"insufficient volume"** state below N leads.
- **c. Source dashboard** — per source: volume, appt rate, **cohort** close rate (A.3), revenue, cost-per-lead/ROI where `costCents` exists; else "no cost data" (never impute).
- **d. Location dashboard (empire view)** — company totals + per-location breakdown + side-by-side. One location today = one row, no rework at #2.
- **e. Crew panel** — built to contract; renders **"awaiting crew app"** until Day 12 supplies `crew.hours.logged`/`job.completed`/`job.cost.actual`. No Day-4 change when Day 12 ships.
- **f. Accountability panel** — open exceptions grouped by owner + age from `exception_queue` ("what's aging on someone else's plate").

## Graceful degradation (§7 — a requirement)
Absence renders **"—" with a reason**, never a silent zero. Zero and unknown are different facts. Specifically: if Day 3 isn't sending real SMS yet, speed-to-lead shows **pending**, not a 0-second median / 100% SLA pass. Reasons: "awaiting crew app", "Twilio pending A2P", "no cost data".

## Weekly delivery
A weekly Inngest cron (mirror `ops-digest.ts`: hourly tick, fire each tenant Monday at its local morning hour) generates the week's rollup and pushes the scorecard via Day 2's existing (mock) delivery path. Real Twilio/email wiring stays behind the Day-2 seam.

## The two real design decisions (resolved, grounded in the prompt)
1. **Daily rows may not exist** → the weekly rollup rebuilds the daily dimensional rows from `orchestrator_event` (idempotent `rebuildDay`), then folds. No dependency on a nightly cron.
2. **Medians/averages don't fold** → `speed.median_seconds`, `margin.avg_pct`, `reviews.avg_stars` are **re-derived from events over the week** (per A.2); pure counts/sums fold from daily rows.
3. **Goals** → `scorecard_goal` table, configurable, ships with placeholder defaults labeled `isPlaceholder=true`. On/off-track renders against whatever's configured; the UI shows "goal: placeholder" until Arrington sets real numbers. (Never fabricate authoritative targets.)

## Acceptance test (§8 — 12 checks, all must pass)
fold correctness · dimensional split sums back to company totals · week boundary (Sun 23:59 vs Mon 00:01 MT; DST 23/25h days) · 13-week window shift · on/off-track sorting · cohort vs activity close rate (labeled) · speed uses `slaLatencySeconds ?? latencySeconds`, quiet-hours-deferred ≠ breach · degradation (no crew → "awaiting crew app", no cost → "no cost data", NOT zeros) · idempotency (one row per `(weekStart, locationId, metricKey)`) · replay (`rebuildWeek` identical) · low-volume guard ("insufficient volume") · multi-location (company total = sum of locations, drill-down filters).

## Scope / out of scope
**Out:** monthly P&L by job type, cash-flow forecasting, per-job margin reconciliation (Day 14), any UI beyond a clean readable page reusing the Day-2 shell.

## Downstream (§9)
Days 6–8 (billing/collections/reviews) need no Day-4 change — their events flow into the same daily projection; measurables already defined in A.2. Day 12 lights up the crew panel with zero Day-4 work. Empire phase extends `daily_metrics_by_location` + `weekly_scorecard.locationId` — the dimension is already there.

## Appendix A — FROZEN DEFINITIONS (additive only; one function per number)
### A.1 Week & timezone
Week = **Monday 00:00:00 → Sunday 23:59:59 `America/Denver`** (stored UTC, bucketed Denver, DST-safe). `weekStart` = the Monday date ISO `YYYY-MM-DD`. Trailing window = **13 weeks including current**.
### A.2 Metric dictionary (`metricKey` → definition → source)
`leads.new` (count `lead.created`/wk) · `leads.by_source` (grouped by `payload.source`) · `speed.median_seconds` (median `slaLatencySeconds ?? latencySeconds` on `lead.first_touch`) · `speed.pct_under_sla` (% first touch inside SLA; quiet-hours-deferred judged from window-open) · `appts.set` · `appts.no_show_rate` (`no_show ÷ set`, same-week activity basis) · `contracts.count` · `contracts.value` (sum `contractValueCents`) · `close_rate.cohort` (A.3) · `close_rate.activity` (contracts÷leads same week — **labeled "activity basis"**) · `revenue.invoiced` (Day 6) · `cash.collected` (Day 6) · `margin.avg_pct` (mean `estimate.approved.marginPct`) · `reviews.count`/`reviews.avg_stars` (Day 8) · `crew.squares_per_day` (Day 12) · `exceptions.open`. Metrics whose source ships later render per §7 until data exists.
### A.3 Cohort vs activity (the honesty rule)
`close_rate.cohort` — for leads created in week W, the share signed **as of now** (correct but lags; always show maturity, e.g. "week of X — 12 days old, still maturing"). `close_rate.activity` — contracts÷leads within the same week (throughput pulse, **must be labeled "activity basis"**, never presented as conversion). Both may show; never conflated or silently swapped.
### A.4 Dimensional table contract
`daily_metrics_by_rep`/`_by_source`/`_by_location` as specced. Additive only. `daily_metrics` + `exception_queue` remain untouched.
