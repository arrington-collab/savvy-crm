# Day 4 — Weekly EOS Scorecard & Dashboards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A pure read-model weekly layer over Day-2's `daily_metrics` + `exception_queue` + Day-3 events: dimensional daily aggregates (rep/source/location), a 13-week weekly rollup, an EOS scorecard, rep/source/location/crew/accountability dashboards, and a Monday delivery — all additive, replayable, and honest about missing data.

**Architecture:** New sibling tables in `packages/db` (never reshape `daily_metrics`). Pure projectors in `packages/command-center` (dimensional daily + weekly fold; medians/rates re-derived from events, sums folded from daily rows). `rebuildDay`/`rebuildWeek` reconstruct from `orchestrator_event` (no dependency on a daily cron that doesn't exist). UI pages in `apps/web` mirror `reports/close-rate/page.tsx`. A weekly Inngest cron mirrors `ops-digest.ts`.

**Tech Stack:** TypeScript, Drizzle + Postgres (RLS via `tenantIsolation()`), Vitest, Next.js App Router server components + shadcn, Inngest cron.

## Global Constraints

- **Extend, never reshape.** `daily_metrics` + `exception_queue` (Day 2 / Day 3 A.3) are FROZEN — no column changes. Day 4 adds sibling tables only.
- **One migration, LOCAL DEV ONLY** (like 0118–0121) — the 5 new tables. NOT applied to prod.
- **Every aggregate carries `locationId`** (nullable until locations modeled). Company view = roll-up; drill-down = filter.
- **Honest denominators + honest absence.** Cohort close rate lags and is labeled with maturity; activity-basis is labeled "activity basis", never presented as conversion. A metric with no source renders `{status:"pending", reason}` — NEVER a silent 0. Zero ≠ unknown.
- **Roll from aggregates; re-derive only what daily rows can't carry.** Weekly sums fold from daily rows; `speed.median_seconds`/`margin.avg_pct`/`reviews.avg_stars` re-derive from events over the week.
- **Replayable.** `rebuildDay(tenantId, date)` and `rebuildWeek(tenantId, weekStart)` reconstruct from the log; same input → same output. Idempotent upserts.
- **Frozen metric dictionary = spec Appendix A.2.** One function per number. **Never fabricate goal targets** — `scorecard_goal` ships placeholder defaults labeled `isPlaceholder=true`.
- **Tenant isolation** via `tenantIsolation()` on every new table + `withTenant` on every read/write.
- Co-author trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. Each task green (typecheck + task tests) before commit.

---

## File Structure
**New (packages/command-center):** `week-window.ts` (+ test), `weekly-metrics.ts` (types), `dimensional.ts` (dimensional daily projectors + test), `weekly.ts` (projectWeek + close-rate + test), `scorecard.ts` (goals eval + scorecard assembly + test), `degradation.ts` (the `MetricValue` pending/ok model).
**New (packages/db):** `schema/scorecard.ts` (5 tables), migration `0122_day4_scorecard.sql`, `command-center/scorecard-store.ts` (dimensional + weekly upserts/reads, `rebuildDay`/`rebuildWeek`), `command-center/scorecard-goals.ts` (goal defaults + read).
**New (apps/web):** `app/(app)/reports/scorecard/page.tsx`, `reports/reps/page.tsx`, `reports/sources/page.tsx`, `reports/locations/page.tsx`, `components/scorecard/Sparkline.tsx`.
**New (packages/agents):** `functions/weekly-scorecard-push.ts` (cron) + registration in `index.ts`.
**Modified:** `packages/command-center/src/index.ts`, `packages/db/src/index.ts` (exports); `packages/agents/src/client.ts` (cron event if needed).

---

## Task D4-1: Week-window + WeeklyMetrics types (pure foundation)
**Files:** Create `packages/command-center/src/week-window.ts` (+ `.test.ts`), `packages/command-center/src/weekly-metrics.ts`. Modify `index.ts`.
**Interfaces produced:**
- `weekStartOf(businessDate: string): string` — the Monday `YYYY-MM-DD` for a given Denver business-date string (A.1). Uses `addDays` (`@savvy/core` `schedule-view.ts:48`) + a Denver-aware day-of-week (compute via `denverMidnightUtc`/`Intl` — mirror `day-window.ts`'s DST-robust approach; do NOT use naive `new Date().getDay()`).
- `weekDates(weekStart: string): string[]` — the 7 business-date strings Mon→Sun.
- `trailingWeekStarts(currentWeekStart: string, n = 13): string[]` — 13 Monday strings including current, oldest→newest.
- `denverWeekWindow(weekStart: string): { startUtc: Date; endUtc: Date }` — Mon 00:00 → Sun 23:59:59.999 Denver, DST-safe (reuse `denverDayWindow` for the two ends).
- `type WeeklyMetrics` + `type DimensionalDaily` (rep/source/location row shapes per spec §5) in `weekly-metrics.ts`.
- **Consumes:** `day-window.ts` (`businessDateOf`, `denverDayWindow`, `denverMidnightUtc`), `@savvy/core` `addDays`.
- [ ] Step 1 (RED): test `weekStartOf("2026-07-27")` (a Monday) === `"2026-07-27"`; `weekStartOf("2026-08-02")` (Sunday) === `"2026-07-27"`; `weekDates` returns 7 consecutive dates Mon→Sun; `trailingWeekStarts` returns 13 Mondays 7 days apart; **DST week**: a `weekStart` spanning the Nov DST change still yields Mon 00:00→Sun 23:59:59 Denver (assert `denverWeekWindow` endUtc − startUtc reflects the 169-hour week, not 168). Run → FAIL.
- [ ] Step 2: Implement using the DST-robust Denver helpers (never naive local-time). Run → PASS. `pnpm --filter @savvy/command-center typecheck && lint`.
- [ ] Step 3: Commit `feat(command-center): Denver week-window + weekly-metrics types`.

## Task D4-2: Migration + 5 sibling tables (db, RLS)
**Files:** Create `packages/db/src/schema/scorecard.ts`; migration `packages/db/migrations/0122_day4_scorecard.sql` (via `pnpm db:generate`); modify `packages/db/src/schema/index.ts` + `packages/db/src/index.ts`.
**Tables (all with `id`, `tenantId`, `tenantIsolation()`, `createdAt`; match `command-center.ts` style):**
- `daily_metrics_by_rep` `{ businessDate text, locationId uuid?, repId uuid, leads int, firstTouches int, medianSpeedSeconds int?, apptsSet int, noShows int, contracts int, contractValueCents bigint, estimatesApproved int, avgMarginPct real? }` — unique `(tenantId, businessDate, locationId, repId)`.
- `daily_metrics_by_source` `{ businessDate, locationId?, source text, leads, apptsSet, contracts, contractValueCents, costCents bigint? }` — unique `(tenantId, businessDate, locationId, source)`.
- `daily_metrics_by_location` `{ businessDate, locationId?, metrics jsonb }` (same `DailyMetrics` blob shape, per-location) — unique `(tenantId, businessDate, locationId)`.
- `weekly_scorecard` `{ weekStart text, locationId uuid?, metricKey text, value jsonb (the MetricValue), goal jsonb?, onTrack boolean?, priorWeeks jsonb (number|null[13]) }` — unique `(tenantId, weekStart, locationId, metricKey)`.
- `scorecard_goal` `{ locationId uuid?, metricKey text, target real, direction text ('gte'|'lte'), isPlaceholder boolean default true }` — unique `(tenantId, locationId, metricKey)`.
- [ ] Step 1: Write schema, `pnpm db:generate` → migration `0122`. Verify the SQL creates tables + RLS policies matching the existing command-center pattern (read `0119`/`0121` for the RLS policy shape).
- [ ] Step 2: Apply locally (`pnpm db:migrate` against `savvy_db`); a small schema test asserts the tables exist + a round-trip insert/select under `withTenant`. Export the tables from `db/src/index.ts`.
- [ ] Step 3: Commit `feat(db): Day 4 scorecard sibling tables + migration 0122 (LOCAL only)`.

## Task D4-3: Dimensional daily projectors (pure)
**Files:** Create `packages/command-center/src/dimensional.ts` (+ `.test.ts`), `packages/command-center/src/degradation.ts`. Modify `index.ts`.
**Interfaces:**
- `type MetricValue = { status: "ok"; value: number } | { status: "pending"; reason: string }` (degradation.ts) + helpers `ok(n)`/`pending(reason)`.
- `projectDayByRep(events: DomainEvent[], businessDate): DimensionalDaily["rep"][]` — group by `repId` (from `lead.assigned.repId`; attribute first_touch/appt/contract/etc. to the lead's assigned rep). Carry `locationId`. `medianSpeedSeconds` = median of `slaLatencySeconds ?? latencySeconds` per rep.
- `projectDayBySource(events, businessDate): ...bySource[]` — group by `payload.source` (from `lead.created`), fold leads/appts/contracts/value; `costCents` left undefined (no event carries it — source dashboard renders "no cost data").
- `projectDayByLocation(events, businessDate): ...byLocation[]` — reuse `projectDay` per `locationId` bucket (group events by `locationId`, run the existing fold), producing a `DailyMetrics` blob per location.
- **Consumes:** `@savvy/orchestrator` `DomainEvent`; the existing `projectDay` (`projection.ts:14`) for the location split; `weekly-metrics.ts` types.
- [ ] Step 1 (RED): tests with `makeEvent` fixtures — 2 reps' `lead.assigned` + `lead.first_touch` → correct per-rep leads + medianSpeedSeconds; source split sums back to the flat `lead.created` count; **dimensional split sums to company totals** (the §8.2 invariant — assert `sum(byRep.leads) === projectDay(events).topLine.leadsTotal` for the same window, no double-count/drop). Run → FAIL.
- [ ] Step 2: Implement. Run → PASS. typecheck + lint.
- [ ] Step 3: Commit `feat(command-center): dimensional daily projectors (rep/source/location)`.

## Task D4-4: Dimensional persistence + rebuildDay (db)
**Files:** Create `packages/db/src/command-center/scorecard-store.ts` (+ test). Modify `db/src/index.ts`.
**Interfaces (all `withTenant`, idempotent upserts on the unique keys from D4-2):**
- `upsertDailyByRep/BySource/ByLocation(tenantId, rows)`.
- `getDailyByRepRange(tenantId, startDate, endDate)` (+ bySource/byLocation) — for the weekly fold.
- `rebuildDay(tenantId, businessDate): Promise<void>` — `loadEventsForDay` → `projectDayByRep/BySource/ByLocation` → upsert all three. Idempotent (re-run → same rows).
- **Consumes:** `loadEventsForDay` (`db/command-center/read.ts:12`), the D4-3 projectors, D4-2 tables, `adminDb`/`withTenant`.
- [ ] Step 1 (RED): real-DB test (mirror `bridge-e2e.test.ts` seed/teardown) — seed events, `rebuildDay`, assert the three dimensional tables have the expected rows; re-run `rebuildDay` → same row counts (idempotent). Run → FAIL.
- [ ] Step 2: Implement. Run → PASS (real `savvy_db`). typecheck.
- [ ] Step 3: Commit `feat(db): dimensional persistence + rebuildDay`.

## Task D4-5: Weekly fold + cohort/activity close rate (pure)
**Files:** Create `packages/command-center/src/weekly.ts` (+ test). Modify `index.ts`.
**Interfaces:**
- `projectWeek(input: { dailyRows: DailyMetrics[]; weekEvents: DomainEvent[]; weekStart: string }): WeeklyMetrics` — **sums fold from `dailyRows`; `speed.median_seconds`/`margin.avg_pct`/`reviews.avg_stars` re-derive from `weekEvents`** (median over the week's `lead.first_touch`, not a median of daily medians). Each field is a `MetricValue` (pending when no source data — e.g. no `lead.first_touch` with real latency ⇒ speed `pending("Twilio pending A2P")`).
- `closeRateCohort(input: { leadsCreatedInWeek: {leadId,createdAt}[]; contractsAsOfNow: {leadId,signedAt}[]; now: Date }): { rate: number; cohortAgeDays: number; maturing: boolean }` — share of week-W leads signed as-of-now (A.3); label maturity.
- `closeRateActivity(contractsThisWeek: number, leadsThisWeek: number): { rate: number; basis: "activity" }` — labeled, never called "conversion".
- **Consumes:** `DailyMetrics`, `DomainEvent`, `MetricValue`, week-window.
- [ ] Step 1 (RED): fold correctness (weekly count === sum of daily counts); median re-derivation (weekly median from events ≠ mean of daily medians — pin with a fixture where they differ); **speed uses `slaLatencySeconds ?? latencySeconds`; a `quietHoursDeferred` first-touch is NOT an SLA breach** (§8.7); cohort vs activity produce different numbers on a lagged fixture and are labeled distinctly (§8.6). Run → FAIL.
- [ ] Step 2: Implement. Run → PASS. typecheck + lint.
- [ ] Step 3: Commit `feat(command-center): weekly fold + cohort/activity close rate`.

## Task D4-6: Goals + scorecard assembly + rebuildWeek (command-center + db)
**Files:** Create `packages/command-center/src/scorecard.ts` (+ test), `packages/db/src/command-center/scorecard-goals.ts`. Extend `scorecard-store.ts` with `rebuildWeek`.
**Interfaces:**
- `DEFAULT_GOALS: Record<metricKey, {target, direction, isPlaceholder:true}>` (scorecard-goals.ts) — **placeholder defaults, all `isPlaceholder:true`**; `getGoals(tenantId, locationId?)` reads `scorecard_goal` falling back to defaults; a `seedPlaceholderGoals(tenantId)` idempotent seeder.
- `evaluateOnTrack(value: MetricValue, goal): boolean | null` — null when value is pending or no goal.
- `buildScorecard(input: { weekly: WeeklyMetrics; priorWeeks: (number|null)[13]; goals }): ScorecardRow[]` — one row per measurable `{ metricKey, owner, value, goal, onTrack, priorWeeks, isPlaceholderGoal }`, **off-track rows sorted first**; ~10–15 measurables (A.2).
- `rebuildWeek(tenantId, weekStart): Promise<void>` (scorecard-store) — ensure the 7 `rebuildDay`s, load daily + week events, `projectWeek`, assemble `priorWeeks[13]` from prior `weekly_scorecard` rows, `buildScorecard`, upsert `weekly_scorecard` (idempotent on `(tenantId, weekStart, locationId, metricKey)`).
- [ ] Step 1 (RED): on/off-track evaluates against configured goal + off-track sorts first (§8.5); 13-week window holds the trailing 13 values, a new week shifts without corrupting history (§8.4); `rebuildWeek` twice → one row per key, identical (§8.9 idempotency); `rebuildWeek` on unchanged input reproduces identical output (§8.10 replay). Placeholder goals flagged. Run → FAIL.
- [ ] Step 2: Implement (real-DB for rebuildWeek). Run → PASS.
- [ ] Step 3: Commit `feat: goals + EOS scorecard assembly + rebuildWeek`.

## Task D4-7: Scorecard page + sparkline (web)
**Files:** Create `apps/web/src/app/(app)/reports/scorecard/page.tsx`, `apps/web/src/components/scorecard/Sparkline.tsx`.
**Interfaces/behavior:** Server component, `export const dynamic = "force-dynamic"`, `getTenantId()`, read `weekly_scorecard` for the current week (or `rebuildWeek` on-demand if absent) → render EOS table (measurable · owner · goal · this week · 13-week `<Sparkline>` · on/off-track badge), off-track pinned top, **provenance line** ("as of / based on", placeholder-goal note). `Sparkline` = tiny inline SVG (no dep, `var(--…)` tokens), renders "—" with reason for `pending` values. Mirror `reports/close-rate/page.tsx` (Card/PageHeader/table/CSS tokens); degradation renders reason, never 0.
- [ ] Step 1: Build the page + Sparkline. A component test for `Sparkline` (13 values incl. nulls → valid SVG path; empty/pending → "—"). Verify in the preview if practical.
- [ ] Step 2: `pnpm --filter @savvy/web typecheck && lint`; the page must handle the no-data tenant (renders pending reasons, not a crash/zeros).
- [ ] Step 3: Commit `feat(web): weekly EOS scorecard page + sparkline`.

## Task D4-8: Rep + Source dashboards (web)
**Files:** Create `reports/reps/page.tsx`, `reports/sources/page.tsx`.
**Behavior:** Rep page — per-rep table from `daily_metrics_by_rep` folded to the week (leads, speed median + % under SLA, appts, no-show rate, contracts, revenue, avg margin, rank); **"insufficient volume"** below N leads instead of a rank (§8.11). Source page — per-source volume, appt rate, **cohort** close rate (labeled + maturity), revenue, cost-per-lead/ROI where `costCents` exists else **"no cost data"** (§8.8). Mirror the close-rate page. Reuse the weekly fold + close-rate functions (D4-5).
- [ ] Step 1: Build both pages. typecheck + lint. Low-volume + no-cost states render correctly.
- [ ] Step 2: Commit `feat(web): rep + source dashboards`.

## Task D4-9: Location + Crew + Accountability panels (web)
**Files:** Create `reports/locations/page.tsx`; add Crew + Accountability panels (either on the scorecard page or their own routes).
**Behavior:** Location — company totals + per-location breakdown + side-by-side (one location = one row, no rework at #2, §8.12). Crew — built to the `crew.squares_per_day` contract but renders **"awaiting crew app"** (no crew events today, §8.8) — NOT zeros. Accountability — open `exception_queue` grouped by owner + age (reuse `needsYouFor`/`isActive`/`openCount`).
- [ ] Step 1: Build. typecheck + lint. Crew degradation + empire roll-up verified.
- [ ] Step 2: Commit `feat(web): location empire view + crew (degraded) + accountability panels`.

## Task D4-10: Weekly delivery cron (agents)
**Files:** Create `packages/agents/src/functions/weekly-scorecard-push.ts`; register in `index.ts`.
**Behavior:** Inngest cron (mirror `ops-digest.ts:11-34` — hourly tick, fire each tenant Monday at its local morning hour via `hourInTimeZone`/`packages/core/src/tz.ts`), `step.run` per due tenant → `rebuildWeek(tenantId, currentWeekStart)` → render a scorecard summary → push via Day-2's existing delivery seam (`FlashDelivery`, mock on prod). Idempotent (rebuildWeek is).
- [ ] Step 1 (RED): unit-test the due-tenant gating (Monday-local-morning only) + that it calls rebuildWeek; mock the delivery seam. Run → FAIL → implement → PASS.
- [ ] Step 2: Register + typecheck + lint. Commit `feat(agents): Monday weekly scorecard push (mock delivery)`.

## Task D4-11: §8 acceptance (12 checks) + gate + PR
**Files:** Create `packages/db/src/command-center/acceptance-day4.test.ts` (real Postgres) — the 12 §8 checks composed end-to-end. Pure checks may also live in a `packages/command-center` acceptance file.
- [ ] Step 1: Write the 12-check acceptance (fold correctness; dimensional split sums to company; week boundary incl. DST; 13-week window; on/off-track sorting; cohort vs activity labeled; speed `slaLatencySeconds ?? latencySeconds` + quiet-hours≠breach; degradation renders reasons not zeros; idempotency; replay; low-volume guard; multi-location roll-up). Drive real functions × real Postgres where DB-backed (mirror Slice-D `acceptance-day3-real-db` learnings — put agent/command-center-driving checks where the imports are legal). Print the rendered scorecard + rep/source tables + pass/fail. All 12 green.
- [ ] Step 2: Clean local `task_registry` fixtures; full gate mirroring CI — `pnpm typecheck` + `pnpm lint` green, `pnpm test` (packages/*) green, `pnpm --filter @savvy/web test` green. Prove any non-Day-4 failure pre-existing.
- [ ] Step 3: Push + `gh pr create` (note: 5 additive tables + migration 0122 LOCAL-only; pure read model; graceful degradation; goals ship as labeled placeholders needing Arrington's real targets). STOP for Brett's merge word.

---

## Self-Review (completed during authoring)
- **Spec coverage:** every §3 DoD + §8 check + §6 panel + Appendix A.2/A.3/A.4 maps to a task (table above). Crew degradation, cohort/activity honesty, low-volume guard, multi-location, replay, idempotency all have explicit tasks/checks.
- **Extend-not-reshape:** `daily_metrics`/`exception_queue` untouched; only additive tables + one LOCAL migration.
- **The two design decisions** (rebuild-from-log for missing daily rows; re-derive medians vs fold sums) are baked into D4-4/D4-5, grounded in the spec.
- **No fabricated numbers:** goals are placeholder-flagged + configurable (D4-6), on/off-track honest until Arrington sets targets.
- **Degradation is a first-class type** (`MetricValue` pending/ok, D4-3) threaded through logic + UI — no silent zeros.
- **Signatures** pinned to exploration `path:line`; each task verifies real shapes before finalizing.
- **Placeholder goals need Brett's real EOS targets** — surfaced at D4-6 and in the PR.
