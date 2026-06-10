# Phase 4 — Scheduling Agent (Design Spec)

**Date:** 2026-06-09
**Status:** Approved for planning
**Roadmap goal:** Appointment booking, calendar sync, crew/inspection scheduling, basic route clustering, reminders. **Done when:** appointments created/synced, reminders fire, no double-booking.

## 1. Summary

Phase 4 turns the Phase 1 demo booking stub into a real scheduling agent. Customers are offered genuinely-open appointment slots and self-book via a tokenized link; reps manage the schedule internally. Each booked appointment is pushed one-way to the assignee's Google Calendar, and a configurable, durable reminder workflow fires before the appointment. Double-booking is made provably impossible by a Postgres exclusion constraint.

The defensible work here is the **availability engine + durable workflows + unified UI**, not the calendar integration itself (a commodity, integrated via Nango).

## 2. Scope decisions (locked during brainstorming)

| Dimension | Decision |
|---|---|
| Calendar integration | **One-way push** to Google Calendar (Savvy is source of truth; external edits ignored). Availability computed purely from internal appointments + working hours. |
| Booking model | **Agent-offered + internal UI.** Agent texts a tokenized link → lightweight Savvy slot-picker. Reps book/reschedule/reassign from `/schedule`. Both share one availability engine. |
| Crew/assignee model | **Single assignee per appointment** (`appointment.assignee_user_id`). No crew/team tables. Install-crew rosters deferred to Phase 6. |
| Route clustering | **Geographic awareness on booking** — haversine ranking of open slots near the assignee's same-day appointments. No map, no TSP, no traffic API. |
| Availability config | **Tenant-level** working hours + per-type duration/buffer, stored in `tenant.settings.scheduling` (jsonb). Per-user hours deferred. |
| Reminders | **Fully configurable schedule** — `[{offsetH, channel}]` in `tenant.settings.scheduling.reminders`, with a builder UI. SMS reminders include reschedule link + reply-CANCEL. |
| No-double-booking guarantee | **Hybrid:** pure-function engine offers only open slots (UX) **+** Postgres exclusion constraint as the atomic backstop against races. |

### Explicitly deferred (tracked follow-ups, not in this phase)
- Drag-calendar grid view (this phase ships a day-grouped agenda list).
- Per-user working hours (tenant-level only for now).
- Reply-digit SMS booking ("Reply 1–3"); link-only this phase.
- Two-way Google Calendar sync (read external free/busy).
- TCPA quiet-hours gating (9pm–8am) on reminder sends — **flagged**: reminders go to real numbers. Carried from Phase 3.

## 3. Architecture approach

**Hybrid (approved):**
- A **pure-function availability engine** in `@savvy/core` (`computeOpenSlots`) — no I/O, no clock — used by both booking paths to offer slots. Heavily unit-tested, mirrors the Phase 3 `renderTemplate` pattern.
- A **Postgres exclusion constraint** on the `appointment` table as the hard, race-safe guarantee of no overlap per assignee.
- Booking, calendar push, and reminders are **durable Inngest workflows + server actions** on top, reusing the Phase 3 `sleep` + `cancelOn` idiom.

## 4. Data model changes (migration `0003`)

### 4.1 `appointment` table
- Add `customer_id uuid references customer(id)` (notify/remind without joining through job).
- Convert `type` → **`appointment_type` enum** (`inspection | cm | crew`).
- Convert `status` → **`appointment_status` enum** (`scheduled | done | canceled | no_show`).
- Keep `gcal_event_id text` (now populated by the sync workflow).
- `assignee_user_id` is required in practice for booked appointments (availability is per-assignee); booking is blocked if no assignee can be resolved.
- **Exclusion constraint** (requires `CREATE EXTENSION IF NOT EXISTS btree_gist`):
  ```sql
  ALTER TABLE appointment ADD CONSTRAINT appointment_no_overlap
    EXCLUDE USING gist (
      assignee_user_id WITH =,
      tstzrange(starts_at, ends_at, '[)') WITH &&
    ) WHERE (status = 'scheduled');
  ```
  Canceled/done/no_show appointments do not block. RLS (`tenantIsolation()`) still applies. `ends_at` becomes effectively required for `scheduled` rows (derived from type duration at booking).
- Drizzle note: the exclusion constraint is added via raw SQL in the generated migration (drizzle-kit can't express `EXCLUDE`); the schema file carries a comment pointing to it.

### 4.2 `user` table
- Add `gcal_connection_id text` (nullable) — the Nango connection id for that user's Google Calendar. Null → calendar push is skipped for that assignee.

### 4.3 `tenant.settings.scheduling` (jsonb, no new table)
Parsed by a zod schema in `@savvy/core` with safe defaults so an unconfigured tenant still books:
```jsonc
{
  "hours": { "mon": [8,17], "tue": [8,17], "wed": [8,17], "thu": [8,17], "fri": [8,17], "sat": [], "sun": [] },
  "slotGranularityMin": 30,
  "bookingHorizonDays": 14,
  "types": {
    "inspection": { "durationMin": 60, "bufferMin": 30 },
    "cm":         { "durationMin": 60, "bufferMin": 15 },
    "crew":       { "durationMin": 480, "bufferMin": 0 }
  },
  "reminders": [
    { "offsetH": 24, "channel": "sms" },
    { "offsetH": 2,  "channel": "sms" }
  ]
}
```

### 4.4 Enums (`packages/db/src/schema/enums.ts`)
Add `appointmentTypeEnum`, `appointmentStatusEnum`. (Channel reuses the existing `messageChannelEnum`/comms channels for reminders.)

## 5. The availability engine (`packages/core/src/scheduling/availability.ts`)

Pure function, no DB / no clock (time passed in):
```ts
computeOpenSlots(input: {
  config: SchedulingConfig;        // parsed tenant.settings.scheduling
  type: AppointmentType;           // -> durationMin + bufferMin
  existingAppts: BusyInterval[];   // assignee's scheduled appts in window {startsAt, endsAt, lat?, lng?}
  fromDate: Date;
  now: Date;                       // exclude past slots
  clusterAround?: { lat: number; lng: number }; // property location for proximity scoring
}): Slot[]                         // { startsAt, endsAt, score }  (score: higher = closer to a same-day cluster)
```
Rules:
- Generate candidate slots on `slotGranularityMin` within each day's working hours across `bookingHorizonDays`.
- Remove any slot whose `[startsAt, endsAt)` (plus `bufferMin`) overlaps an existing appointment.
- Remove slots starting before `now`.
- Score remaining slots by haversine proximity to the assignee's same-day appointments (`clusterAround` and/or existing appts with coords); slots near an existing cluster rank higher. No coords → neutral score, chronological order.

Helper: `parseSchedulingConfig(settings): SchedulingConfig` (zod, fills defaults).
Helper: `haversineMeters(a, b)`.

## 6. Booking flow

### 6.1 Shared `bookAppointment` (server-side, transactional)
1. `withTenant(tenantId, …)`.
2. Resolve assignee: lead/job `assigned_user_id`, else tenant default inspector (first `owner`/`rep` user). No assignee → `NoAssigneeError`.
3. Re-run `computeOpenSlots`; assert the requested slot is still open (friendly pre-check).
4. `INSERT appointment` (status `scheduled`, `ends_at` derived). The **exclusion constraint** is the real guard: a `23P01` violation is translated to `SlotTakenError`.
5. Best-effort `inngest.send('appointment/booked')` (wrapped in try/catch + logged). Record `agent_run`.

### 6.2 Path A — agent-offered (customer)
- Booking SMS (extends Phase 1 `buildBookingSms`) links to **`/book/[token]`**. Token = HMAC-signed payload, reusing/generalizing Phase 3's `signToken`/`verifyToken` in `@savvy/core`:
  - **New booking:** `{ tenantId, type, leadId?|jobId? }` → page books a fresh appointment.
  - **Reschedule:** `{ tenantId, type, appointmentId }` → page reschedules the existing appointment in place (updates `starts_at`/`ends_at`, keeps the same row + `gcal_event_id`). This is the token embedded in reminder messages.
- `/book/[token]` is a public, token-gated, `force-dynamic` page (no Clerk). Read action → `computeOpenSlots` → renders top open/clustered slots → confirm → `bookAppointment` (new) or `rescheduleAppointment` (existing).
- On `SlotTakenError`, re-fetch and re-offer.

### 6.3 Path B — internal (`/schedule`)
Server actions: `bookAppointment`, `rescheduleAppointment`, `reassignAppointment`, `cancelAppointment`, `markStatus` (done | no_show). Reschedule/reassign update the row (re-checked by the exclusion constraint) and emit `appointment/changed`.

### 6.4 Events (`packages/agents/src/client.ts`)
| Event | Emitted when | Consumers |
|---|---|---|
| `appointment/booked` | new appointment | calendar-sync (create), reminders (start run) |
| `appointment/changed` | reschedule / reassign / cancel / mark done / no_show | calendar-sync (patch or delete), reminders (cancel in-flight run + restart; restarted run exits if status no longer `scheduled`) |

`appointment/changed` carries `{ appointmentId, tenantId, reason, prevAssigneeUserId?, newStartsAt? }`. It plays the role `drip/stop` did in Phase 3: one signal driving both external re-sync and reminder cancellation.

## 7. Google Calendar push (Nango, one-way, best-effort)

- Wrapper `packages/integrations/src/gcal.ts`: `createEvent / patchEvent / deleteEvent` via Nango (integration id `google-calendar`). Env: `NANGO_SECRET_KEY`, `NANGO_HOST`. Documented in `.env.example`.
- Connection per user: `user.gcal_connection_id`. Settings has a **Connect Google Calendar** button per user (basic OAuth-connect via Nango + status display).
- **Workflow `appointmentCalendarSync`** (`packages/agents`):
  - `appointment/booked` → if assignee has a connection: `createEvent`, store `gcal_event_id`. No connection → no-op (booking already succeeded).
  - `appointment/changed`: `patchEvent` (reschedule) / `deleteEvent` (cancel). Reassign → delete on old user's calendar + create on new user's.
  - Idempotent (keyed on appointment id + event type); Inngest retries transient Nango/Google errors.
- Calendar is always an **enhancement, never a blocker**: every failure is caught, logged to `agent_run`, non-fatal; `gcal_event_id` stays null.

## 8. Reminders

- **Workflow `appointmentReminders`** (one active run per appointment; reuses the drip `sleep` + `cancelOn` idiom):
  - **Triggers on `appointment/booked` OR `appointment/changed`** (both events start a run).
  - **`cancelOn: appointment/changed` matched on `appointmentId`** — an incoming `appointment/changed` cancels the in-flight run *and* starts a fresh one. This is how reschedule restarts cleanly: Inngest sleeps are pinned at run start, so the old run (with the old time) is killed and the new run re-reads the new `starts_at`.
  - **Guard at run start (Phase 3 backstop pattern):** load the appointment; if `status != 'scheduled'` (canceled/done/no_show) → exit immediately. So a `cancel`-flavored `appointment/changed` cancels the old run, starts a new run, which reads `canceled` and exits — no reminders sent. A `reschedule`-flavored one starts a run that reads `scheduled` + the new time and schedules normally.
  - Reads `tenant.settings.scheduling.reminders` at run start. For each `{offsetH, channel}`: `step.sleepUntil(starts_at − offsetH)` → re-check status is still `scheduled` → send via the Phase 3 comms senders (SMS via Twilio, email via Resend) → log to `communication`.
  - SMS reminders include the reschedule link (`/book/[token]` with `{appointmentId}`) + "Reply CANCEL". Email reminders include the reschedule link.
  - Note: `appointment/booked` starts both the calendar-sync (create) and a reminders run; `appointment/changed` drives calendar-sync (patch/delete) and the reminders cancel-and-restart above — so the calendar workflow never double-creates on reschedule.
- **Inbound CANCEL:** extend Phase 3 `inbound-sms` — a customer texting CANCEL with an upcoming `scheduled` appointment cancels it + emits `appointment/changed`. STOP remains comms opt-out; CANCEL is appointment-specific.

## 9. UI surface (shadcn, `force-dynamic`, matches `/comms` + `/jobs`)

- **`/schedule`** — internal day-grouped agenda list, filterable by assignee + type. Rows show customer, property address, time, status; actions: reschedule / reassign / cancel / mark done|no_show. (Drag-calendar grid deferred.)
- **`/book/[token]`** — public token-gated slot-picker (clustered slots first) → booked confirmation. Also the reschedule target.
- **Settings** (`/settings/scheduling` or tab): working-hours + per-type duration/buffer form; **reminder-schedule builder** (add/remove `{offsetH, channel}` rows, mirrors the drip-step builder); per-user **Connect Google Calendar** button + status.

## 10. Error handling

| Case | Behavior |
|---|---|
| Exclusion violation (`23P01`) | `SlotTakenError` → re-offer slots; never a 500. |
| Calendar push failure | Caught, logged to `agent_run`, non-fatal; `gcal_event_id` stays null; Inngest retries. |
| Post-tx `inngest.send` failure | try/catch + log (best-effort) — carries the Phase 3 follow-up forward. |
| No resolvable assignee | Booking blocked with a clear message. |
| Invalid/expired `/book/[token]` | Friendly "link expired" page, not a crash. |

## 11. Testing

- **Unit (vitest, `@savvy/core`):** `computeOpenSlots` — buffers, working-hours boundaries, horizon, past-slot exclusion, overlap removal, proximity scoring, empty-config defaults. `parseSchedulingConfig` defaults. `haversineMeters`.
- **Integration (`@savvy/db`):** exclusion constraint rejects overlaps for the same assignee, allows across assignees/tenants, canceled appts free the slot; RLS isolation extended to new columns/enums.
- **e2e (Playwright):** book via `/book/[token]` → appears on `/schedule` → reschedule → assert old reminder cancelled / new scheduled (against Inngest dev server, like Phase 3 comms e2e). Calendar push **mocked** (fake Nango client asserts create/patch/delete; no real Google in CI).

## 12. Definition of done (per repo CLAUDE.md)
- [ ] Appointments created via both paths; `ends_at` derived from type; exclusion constraint live.
- [ ] No double-booking provable by integration test (concurrent/overlap rejected).
- [ ] Booked appointments pushed to Google Calendar when assignee connected; non-fatal when not.
- [ ] Configurable reminders fire on schedule and self-cancel on change.
- [ ] All features tenant-scoped; RLS verified by test. AI not required here (no model calls beyond existing comms drafting).
- [ ] Durable + idempotent workflows; typecheck + lint + tests green; `.env.example` updated (Nango); small reviewed commits.

## 13. Tracked follow-ups (deferred)
- Drag-calendar grid view.
- Per-user working hours + editor.
- Reply-digit SMS booking.
- Two-way Google Calendar sync (external free/busy → availability).
- TCPA quiet-hours gating on reminder sends + explicit consent capture.
- Twilio webhook signature validation (still outstanding from Phase 3; touches the inbound-sms path this phase extends).
