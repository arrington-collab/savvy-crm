# Schedule Slice C — click-empty-slot → create appointment inline

**Date:** 2026-06-19
**Status:** Approved (design)
**Depends on:** Slice A (calendar views, PR #31) + Slice B (drag + `zonedTimeToUtc`, PR #33), both merged to `main`.

## Goal
Let a rep create an appointment directly from the schedule: click an empty time slot in the **Week** view → a pre-filled modal create form opens → pick a job, type, optional crew, time/duration → save. This is the last of the three schedule slices (A = views/filters, B = drag-to-reschedule/reassign, C = create).

This is an **internal** entry point to the same primitive the customer-facing `/book/[token]` slot-picker uses (`bookAppointment` + `appointment/booked`). It does not replace the booking flow.

## Scope decisions (from brainstorm)
- **Week view only** for this slice. Month/Crew click-to-create deferred (their cells have no precise time axis). Staged like A/B.
- **Job picker = searchable typeahead** (customer name / address) **+ a "New lead" escape-hatch link** to `/leads/new` (NOT an inline lead-create form — keep the slice small; matches onboarding's deep-link pattern). The rep creates+converts the lead there; the job then appears in search.
- **Assignee is optional** — "Unassigned" is allowed (the Crew board already has an Unassigned column). No conflict check until a crew is assigned.
- **Job search covers all jobs** (any stage) by customer/address — no stage filtering.
- **No schema migration** — `appointment.assigneeUserId` is already nullable.

## Architecture (units + interfaces)

### 1. Pure: `minutesFromOffset` (`@savvy/core/schedule-view.ts`)
Inverse of the grid's vertical positioning. Maps a click offset within a day column to a wall-clock minute-of-day.
- Signature: `minutesFromOffset(offsetY: number, height: number): number`
- Logic: `DAY_START_MIN + (offsetY / height) * SPAN_MIN`, snapped to 30 (`snap30`), clamped to `[DAY_START_MIN, DAY_END_MIN - 30]` (6a–8p window; leaves room for a min 30-min appt).
- Reuses existing `DAY_START_MIN=360`, `DAY_END_MIN=1200`, `SPAN_MIN=840`, `snap30`.
- The grid then builds the start instant with the existing `zonedTimeToUtc(civilDate, minutes, tz)` (Slice B) and adds the chosen duration for `endsAt`.
- **Unit-tested** alongside `applyDragToWeek`/`zonedTimeToUtc` (boundaries: top=6:00, bottom clamps to 19:30, mid snaps to 30).

### 2. `WeekGrid` / `WeekCol` — empty-slot click (`apps/web/src/app/(app)/schedule/WeekGrid.tsx`)
- `WeekGrid` gains an `onCreate(date: string, minutes: number)` prop.
- `WeekCol`'s container `onClick` reads click-Y relative to the column (`e.clientY - rect.top`), calls `minutesFromOffset(offsetY, 560)`, then `onCreate(day.date, minutes)`.
- Existing `WeekBlock` buttons call `e.stopPropagation()` in their `onClick` so clicking an appointment opens its popover, not the create form.
- PointerSensor `activationConstraint.distance: 5` already ensures a plain click (no drag) doesn't start a drag — click-to-create and drag-to-reschedule coexist.

### 3. `CreateAppointmentForm` modal (new, sibling of `AppointmentPopover.tsx`)
Centered modal mirroring `AppointmentPopover`'s shell. Pre-filled from the clicked slot. Fields:
| Field | Control | Notes |
|-------|---------|-------|
| Job | searchable typeahead | calls `searchSchedulableJobs(q)`; required to submit; empty-state shows **"+ New lead"** → `/leads/new` |
| Type | native `<select>` | `APPOINTMENT_TYPE`; default first/`inspection` |
| Crew | native `<select>` | `props.crew` + an **"Unassigned"** option; optional |
| Start | `datetime-local` | pre-filled from clicked slot (editable) |
| Duration | native `<select>` | options 30/60/90/120/480 min; default = the type's configured `durationMin` (`parseSchedulingConfig().types[type]`: inspection/cm = 60, crew = 480) |

- The typeahead is a controlled input + a results list (debounced or transition-driven server call). No shadcn `Select`/combobox exists in the repo → build a minimal controlled typeahead with a native list (consistent with the "native `<select>`" precedent).
- Submit → `createAppointmentAction(...)`. On `{error:"slot_taken"}` show an inline message (mirrors the reschedule popover's `slotTaken` pattern) and keep the form open. On `{ok}` → success toast, close, `revalidatePath` re-fetch brings the new block in (no client-side optimistic synth — simpler than reschedule because it's a new entity with server-derived display fields).

### 4. `createAppointmentAction` (`apps/web/src/lib/scheduling-actions.ts`)
- Signature: `createAppointmentAction(input: { jobId: string; type: AppointmentType; assigneeUserId: string | null; startsAt: string; endsAt: string }): Promise<{ ok: true } | { error: "slot_taken" }>`
- Resolves `customerId` from the job (same as `booking-action.ts` does) so reminders have a phone/email lookup.
- Calls existing `bookAppointment`, emits `appointment/booked` (try/catch like the other emits), `revalidatePath("/schedule")`.
- Catches `SlotTakenError` → `{error:"slot_taken"}`.

### 5. `bookAppointment` widening (`packages/db/src/lifecycle/appointments.ts`)
- `BookInput.assigneeUserId: string` → `string | null`; insert passes `assigneeUserId: input.assigneeUserId ?? null`.
- The per-crew `appointment_no_overlap` EXCLUDE constraint does not fire when the assignee key is null (Postgres exclusion treats nulls as non-conflicting) — exactly the desired "no conflict check until assigned" behavior.
- Existing callers (`booking-action`) pass a non-null assignee — unaffected.

### 6. Job search query (`apps/web/src/lib/schedule-create-queries.ts`, new, `import "server-only"`)
- `searchSchedulableJobs(q: string): Promise<{ jobId: string; customerName: string; address: string | null; customerId: string }[]>`
- `withTenant` + RLS (thin web query, same pattern as `getLeads`/`getBoard` — tenant isolation enforced by RLS, not a hand-rolled filter). Joins `job → customer → property`, `ILIKE %q%` on customer name OR property address, `LIMIT 10`, recent first. Empty/short `q` → empty list.

## Data flow
1. Rep clicks an empty Week slot → `WeekCol.onClick` → `minutesFromOffset` → `onCreate(date, minutes)` (bubbles to `ScheduleClient`).
2. `ScheduleClient` holds `createDraft: { date, minutes } | null`; sets it → renders `CreateAppointmentForm` pre-filled (`zonedTimeToUtc(date, minutes, tz)` for the start `datetime-local`).
3. Rep fills job (typeahead → `searchSchedulableJobs`), type, optional crew, edits time/duration.
4. Submit → `createAppointmentAction` → `bookAppointment` → emit `appointment/booked` → `revalidatePath`.
5. Server re-renders `/schedule`; `ScheduleClient`'s `useEffect` re-hydrates `appts`; the new block appears in the grid.

## Error handling
- **Busy assigned crew** → `SlotTakenError` → inline "That time is taken for this crew — pick another time or crew." Form stays open.
- **No job selected** → submit disabled.
- **Unassigned** → always creates (no conflict check).
- **Inngest down** → emit is best-effort (try/catch); the appointment still persists (same resilience as `booking-action`).

## Testing
- **Unit (`@savvy/core`):** `minutesFromOffset` — top→360, just-below-bottom clamps to 1170 (19:30), mid-column snaps to nearest 30.
- **Integration (`@savvy/db`):** `bookAppointment` with `assigneeUserId: null` inserts a scheduled appointment and does NOT raise on an overlapping null-assignee row; cross-tenant isolation still holds.
- **e2e (Playwright, `apps/web/tests/e2e/`):** click an empty Week slot → form opens pre-filled → search+pick a seeded job → create → the block appears; a busy-crew conflict shows the inline error (form stays open); an unassigned create succeeds. Seeds a job inline for the per-run e2e tenant (like `pipeline`/`leads` specs). Re-run the existing `scheduling.spec`/`schedule` specs to confirm click-to-create did not break click-to-open or drag.

## Out of scope (deferred)
- Month/Crew click-to-create.
- Inline lead/customer creation (the "New lead" link is the escape hatch).
- Drag-to-paint a time range to set duration (Approach C).
- Recurring appointments; multi-attendee.

## Reuse summary
- **No new backend primitive** — reuses `bookAppointment`, `zonedTimeToUtc`, `appointment/booked`, `convertLeadToJob` (indirectly, via the leads flow).
- **No schema migration.**
- New code is concentrated in: one pure helper, one grid handler, one modal component, one server action, one thin query, and a one-line `BookInput` type widening.
