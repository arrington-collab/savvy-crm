# Command Center — Daily Flash & Exception Queue (Day 2) Design

**Date:** 2026-07-25
**Status:** Approved (Brett). Builds on Day-1 Orchestrator (PR #259, merged `4e67d4a`).
**Decisions locked:** (1) **full event re-model** — extend Day-1's vocabulary properly; (2) **core + acceptance now, mock seams** for scheduler/delivery.

## Context
Day 1 shipped a standalone event bus (`packages/orchestrator`): a `DomainEvent` log
(`orchestrator_event`, append-only audit; the `outcome='received'` row is the canonical
one-per-event record) and an escalation sink (`orchestrator_escalation`). Day 2 is
**Arrington's cockpit** — the surface that lets him run the Denver operation from Arizona by
exception in ~20 min/day. Two parts ship: a **Daily Flash** (auto end-of-day summary pushed to
his phone) and an **Exception Queue** (Day-1 escalations turned into a workable, stateful queue).

Day 2 is a **read model** over the Day-1 log — it never writes business state and never calls the
six source tools. It folds events into numbers. See [[savvy-orchestrator-day1]].

## Prerequisite — event vocabulary re-model (`packages/orchestrator/src/events.ts`)
Day-2's metrics need fields/types Day-1 doesn't emit. Brett chose the full re-model over
optional bolt-ons, so these become **required** payload fields (Day-1's tests + publishers are
updated to supply them). Money is **integer cents with explicit `…Cents` suffixes** (unit-safe;
matches Savvy finance convention) — the Flash converts to dollars at render time.

Changed/added payloads:
- `lead.created`: `{ leadId, customerId, source }` — `source` = marketing source
  ("canvass" | "web" | …), distinct from the envelope's `source: Tool`.
- `contract.signed`: `{ jobId, customerId, contractValueCents }`.
- `invoice.created`: `{ invoiceId, jobId, amountCents }`.
- `appointment.set` (**new**): `{ appointmentId, leadId?, jobId?, scheduledAt }`.
- `appointment.no_show` (**new**): `{ appointmentId, jobId? }`.
- Unchanged: `payment.received {invoiceId, amountCents}`, `supplement.approved {supplementId,
  amountCents}`, `estimate.approved {…, marginPct}`, `review.posted {jobId, stars}`,
  `lead.first_touch {leadId, channel}`, `invoice.past_due {invoiceId, daysPastDue}`, the lead
  lifecycle + system events.

**Blast-radius discipline:** the re-model edits `events.ts`, the publishers, and their tests —
**not** `triggers.ts` / `engine.ts` / the db store (the concurrently-running follow-up task
`task_71fda1bc` owns those). Appointment events need **no** trigger subscription — the projection
reads the audit log directly, so unhandled `received` rows still aggregate. `escalations.ts` is
untouched (`supplement-denied` still reads `amountCents`).

## Architecture — new standalone package `packages/command-center`
Mirrors the Day-1 package shape. Depends on `@savvy/orchestrator` (types + store) and `@savvy/db`.

### Core (pure TS, offline-testable — what the acceptance test exercises)
1. **`day-window.ts`** — `denverDayWindow(businessDate) → { startUtc, endUtc }` and
   `businessDateOf(occurredAtUtc) → "YYYY-MM-DD"` in **America/Denver**. Timestamps are stored
   UTC and bucketed in Denver so a job completed 11pm MT lands on the right day. Arizona has no
   DST — the Flash message surfaces the send time in Arrington's local (AZ) time.
2. **`projection.ts`** — `projectDay(events: DomainEvent[], businessDate) → DailyMetrics`: a pure
   reducer folding the log over the Denver window into the Section-4 aggregates. `DailyMetrics`
   is a plain object (top-line, money, speed, quality, production, plus an `openExceptions`
   summary slot). `rebuild(date)` = re-run over the same log → identical output (replayable).
3. **`exception-queue.ts`** — lifecycle over Day-1 escalations. States
   `open → acknowledged → resolved | snoozed`; added fields `state, assignee, acknowledgedAt,
   resolvedAt, resolutionNote, snoozeUntil`. Resolving/snoozing **never deletes** (history stays).
   Idempotent intake dedupes on `(escalation.id, event idempotencyKey)`. Default `assignee` from
   the escalation's `notify`; `arrington` items surface in "Needs you," others roll up as counts.
   High-severity unacknowledged > X hrs = a bold flag on the next Flash (surface only, no paging
   yet). Pure transition fns + an in-memory store.
4. **`flash.ts`** — `renderFlashHtml(metrics, queue, comparison) → string` (self-contained,
   phone-first HTML; "Needs you" pinned to the very top; one screen; "see all" links to depth)
   and `renderFlashHeadline(metrics, queue) → string` (SMS/push text: top line + open-exception
   count + link; **ids/totals only, no customer PII**).
5. **`comparison.ts`** — vs-yesterday / vs-trailing-7-average deltas so a glance conveys
   direction, not just magnitude. Missing history → no delta (not a crash).

### Seams (interfaces now, mock impls; real wiring is the later supervised step)
- **`FlashScheduler`** — fire the Flash at `FLASH_HOUR` (default 18:00 America/Denver) + a
  "flash me now" on-demand trigger. Mock/manual now; real Vercel-cron or Inngest later.
- **`FlashDelivery`** — push/SMS send. Mock records the headline + link; real Twilio later
  (prod Twilio is mock-only today, so this can't be verified in an offline run).

### Store read (new file — no Day-1 store-interface edit)
`loadEventsForDay(tenantId, businessDate)` selects `orchestrator_event` rows where
`outcome='received'` within the Denver window and maps them back to `DomainEvent[]`. Lives as a
**new** module in the db package (e.g. `packages/db/src/command-center/read.ts`) — it does NOT
extend Day-1's `OrchestratorStore` interface (which the follow-up task is editing), so the
branches stay disjoint. Tenant-scoped via `withTenant`.

## Data flow
```
orchestrator_event (received rows) --loadEventsForDay(denver window)--> DomainEvent[]
   --projectDay--> DailyMetrics --upsert--> daily_metrics
                              \--renderFlash--> HTML + headline --FlashDelivery(mock)--> record
orchestrator_escalation --intake--> exception_queue (stateful) --"Needs you"--> Flash top
```

## Persistence (Slice 2) — migration 0119, RLS
- **`daily_metrics`** — one row per `(tenant_id, business_date)`, upsert by date (unique index).
  Stores the projected aggregates (jsonb) + generation timestamp. Rebuildable from the log.
- **`exception_queue`** — the stateful layer over `orchestrator_escalation`: `escalation_id`
  (ref), `state`, `assignee`, `acknowledged_at`, `resolved_at`, `resolution_note`,
  `snooze_until`, timestamps. Unique on `(tenant_id, escalation_id)` for idempotent intake.
- Both carry `tenant_id` + `tenantIsolation()` RLS; app writes via `withTenant`.

## Web (Slice 2)
A phone-first Flash HTML route in `apps/web` behind a **signed link** (viewable from the SMS deep
link but not public PII). Reuses the audit-dashboard styling so it reads as one system.

## Non-functional
- **Read-only** business state; the projection row + queue state are the only new writes.
- **Timezone-correct** (Denver window, UTC storage). **Replayable** + **idempotent generation**
  (one Flash per business date, upserted — never duplicated). **Graceful with gaps** (missing
  optional field → "—", never a crash; a zero-activity day → a valid "quiet day" Flash).
- **Minimal PII / no secrets** — aggregates + job ids only.

## Testing — §8 acceptance (must pass to close Day 2)
Replay a business day of events **through the real Day-1 `Orchestrator`** (the re-model makes
appointment/contract-value events validate), then generate the Flash and assert:
1. Counts: 5 `lead.created` (2 canvass, 3 web) + 3 `appointment.set` + 1 `appointment.no_show`
   + 2 `contract.signed` ($24k + $18k) + 1 `job.completed` → Leads 5 (by source), Appts 3/1,
   Contracts 2 / $42k, Jobs 1.
2. Money: 1 `invoice.created` $24k + 1 `payment.received` $24k → Invoiced $24k, Cash $24k.
3. Speed-to-lead: `lead.created`+`lead.first_touch` pairs → correct median + "% < 5 min"; a lead
   with no first touch is excluded from the median but counted against the SLA %.
4. Needs you: the 4 Day-1 escalations (low-margin, collections-90, negative-review,
   handler-failure) appear as `open` queue items with correct severity; the two `arrington`
   items show in "Needs you."
5. Queue lifecycle: acknowledge one → leaves `open`, keeps history; snooze another until
   tomorrow → drops off today's "Needs you" but is not deleted.
6. Idempotency: generate twice for the same date → one Flash, identical numbers.
7. Replay: `rebuild(date)` reproduces identical metrics.
8. Quiet day: empty day → a valid "quiet day" Flash, no crash, zero exceptions.
Print the rendered Flash (text ok) + the exception queue + pass/fail.
Plus: unit tests per core module; a Drizzle round-trip test in Slice 2.

## Slices
- **Slice 1** — event re-model + `packages/command-center` core (day-window, projection,
  exception-queue, flash, comparison) + in-memory store + the §8 acceptance test. All offline.
- **Slice 2** — Drizzle `daily_metrics` + `exception_queue` (migration 0119, RLS) +
  `loadEventsForDay` db loader + web Flash HTML route + `FlashScheduler`/`FlashDelivery` mock
  seams + round-trip integration test.

## Sequencing & coordination
Execute Slice 1 **after the follow-up task `task_71fda1bc` merges** (clean base), on branch
`command-center-day2`. The re-model is kept out of `triggers.ts`/`engine.ts`/db-store so the two
branches remain disjoint even while both are open. Same subagent-driven TDD flow as Day 1
(per-task implement → task review → fix loop → final whole-branch review → Brett's merge word).

## Handoff to Day 3 / Day 4
- Day 3 (speed-to-lead + missed-call text-back) emits `lead.first_touch` + no-show events — the
  Flash "Speed" panel already consumes them, so Day 3 lights it up automatically.
- Day 4 (weekly EOS scorecard + rep/source dashboards) reads the **same** `daily_metrics`
  projection rolled to a week and the **same** `exception_queue`. Keep both shapes stable —
  extend, don't reshape. The weekly scorecard is a fold of daily rows, not a new pipeline.
