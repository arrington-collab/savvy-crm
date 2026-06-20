# Schedule Drag — Reschedule + Reassign (Slice B) — Design Spec (2026-06-19)

Slice B of the schedule upgrade (after Slice A — Week/Month/Crew calendar + filters, PR #31).
Adds drag interactions to all three views. **Stacks on `feat/schedule-calendar`** (branches off
it; its PR merges after #31, or rebases to main once #31 lands). Slice C (click-to-create) is a
separate later spec.

## Goal
Direct-manipulation scheduling: drag an appointment to change its time/day (reschedule) or its
crew (reassign), with optimistic feedback and automatic revert when the move conflicts. Done-when:
in the Week view a block dragged to a new time/day persists (duration preserved, snapped to 30 min);
in Month a chip dragged to a new day persists (time kept); in Crew a card dragged to another crew
column reassigns it; and any drop that violates the per-assignee no-double-book constraint reverts
with a toast.

## Non-negotiables honored
- Tenant isolation unchanged — reschedule/reassign go through the existing tenant-scoped write path
  (`withTenant` + the `appointment_no_overlap` EXCLUDE constraint); no new tenant data path.
- All new date math is **pure in `@savvy/core`** (the tz inverse + drag→time mapping), unit-tested;
  `apps/web` stays the thin drag-wiring layer (Playwright-only).
- Reuses the existing `rescheduleAction` and the jobs-board optimistic/revert pattern; adds one new
  write (`reassignAppointment`) that mirrors `rescheduleAppointment`'s conflict handling.
- Ships with tests; typecheck + lint clean; Slice A's e2e stays green.

---

## Part 1 — Pure engine additions (`@savvy/core/schedule-view.ts`)

- **`zonedTimeToUtc(civilDate: string, minutes: number, tz: string): string`** — the inverse of
  Slice A's `toCivilDate`/`minutesInTz`: given a wall-clock day (YYYY-MM-DD) + minutes-since-midnight
  in the tenant tz, return the UTC ISO instant. Offset-correction approach:
  ```
  guess = Date.UTC(y, mo-1, d, hh, mm)            // treat wall time as if UTC
  offsetMin = (wall time of `guess` in tz) - guess // how far tz is from UTC at that instant
  result = guess - offsetMin*60000
  ```
  where the tz offset is derived from `partsInTz(guess, tz)` vs `guess`. **Round-trip tested**:
  `toCivilDate(zonedTimeToUtc(d, m, tz), tz) === d` and `minutesInTz(...) === m`, for Phoenix AND a
  DST tz (America/New_York). Known limitation: inside the 1-hour DST spring-forward gap the mapping is
  approximate — acceptable for scheduling (documented).
- **`applyDragToWeek(appt, deltaYpx, gridHeightPx, newDate, tz): { startsAt: string; endsAt: string }`**
  — new start = `snap30(minutesInTz(appt.startsAt, tz) + round(deltaYpx / gridHeightPx * 840))`
  (840 = the 6a–8p span in minutes); clamp into `[360, 1200 - durationMin]`; new instant =
  `zonedTimeToUtc(newDate, newStartMin, tz)`; `endsAt` = start + original duration. Pure → tested
  (time shift, day change, duration preserved, snap, clamp at the window edges).
- **`applyDragToMonth(appt, newDate, tz): { startsAt; endsAt }`** — keep the appt's time-of-day in tz,
  move to `newDate`: `newStartMin = minutesInTz(appt.startsAt, tz)`; `startsAt =
  zonedTimeToUtc(newDate, newStartMin, tz)`; `endsAt = start + duration`. Pure → tested.
- Internal helper `snap30(min) = Math.round(min/30)*30`. (`minutesInTz`/`partsInTz` already exist from
  Slice A — export `minutesInTz` if not already, for the helpers; keep `partsInTz` internal.)

## Part 2 — Reassign write path

- **`reassignAppointment({ tenantId, appointmentId, assigneeUserId }): Promise<void>`**
  (`assigneeUserId: string | null` — null for the "Unassigned" column) in
  `packages/db/src/lifecycle/appointments.ts` — `withTenant` UPDATE of `appointment.assigneeUserId`
  (scoped by id + tenant); on the no-overlap `23P01` throw the existing `SlotTakenError` (mirror
  `rescheduleAppointment` exactly). Reassigning to a crew already busy at that time trips the
  per-assignee EXCLUDE constraint → surfaces as slot_taken. **Integration-tested** (`@savvy/db`):
  reassign succeeds; reassign into a conflicting slot throws `SlotTakenError`; cross-tenant id is a no-op.
- **`reassignAction(appointmentId: string, assigneeUserId: string | null): Promise<{ ok: true } | { error: "slot_taken" }>`**
  in `apps/web/src/lib/scheduling-actions.ts` — `getTenantId` → `reassignAppointment` (catch
  `SlotTakenError` → `{ error: "slot_taken" }`) → emit `appointment/changed` reason `"reassigned"` →
  `revalidatePath("/schedule")`. Mirrors `rescheduleAction`. (Reschedule reuses `rescheduleAction`.)

## Part 3 — Client drag wiring (`apps/web/src/app/(app)/schedule/`)

- **Lift appts into client state**: `ScheduleClient` holds `appts` in `useState(props.appts)` (re-synced
  when props change), so drags update optimistically and revert on failure — the same shape as the jobs
  board (`board.tsx`). A shared `onReschedule(appt, {startsAt, endsAt})` / `onReassign(appt, userId)`
  handler does: optimistic state mutation → await the action → on `{error}` revert + `toast.error` →
  on ok let `revalidatePath` refresh.
- **`@dnd-kit/core`** wraps each view in a `DndContext` (sensor with a small activation distance so a
  click still opens the popover). The draggable id = appointment id; the droppable id encodes the target
  (week: the day-column date; month: the cell date; crew: the crew column userId).
- **WeekGrid**: blocks become `useDraggable`; day columns `useDroppable` (id = date). `onDragEnd`:
  if `over` is a day column, `applyDragToWeek(appt, event.delta.y, 560, overDate, tz)` → `onReschedule`.
- **MonthGrid**: chips draggable; cells droppable (id = date). `onDragEnd` →
  `applyDragToMonth(appt, overDate, tz)` → `onReschedule`.
- **CrewBoard**: cards draggable; crew columns droppable (id = `userId ?? "unassigned"`). `onDragEnd`:
  if dropped on a different crew column → `onReassign(appt, overUserId)`. (Dropping on "unassigned" sets
  assignee to null — supported by `reassignAppointment` taking `assigneeUserId: string | null`.)
- Click-to-open-popover (Slice A) is preserved: the dnd sensor's activation distance means a tap that
  doesn't move past the threshold still fires the existing onClick.

## Part 4 — Testing
- **Unit (`@savvy/core`)**: `zonedTimeToUtc` round-trip (Phoenix + New_York); `applyDragToWeek`
  (downward drag → later snapped time; cross-column → new day; duration preserved; clamp at 6a/8p);
  `applyDragToMonth` (new day, same time-of-day).
- **Integration (`@savvy/db`)**: `reassignAppointment` success + conflict (`SlotTakenError`) + isolation.
- **e2e (Playwright)**: seed in-week appts; (a) drag a Week block to a different day → its day-column
  changes (assert the block now lives under the new `week-col-<date>` / the DB row moved); (b) drag a
  Crew card from one column to another → it appears under the new `crew-col-<userId>` (reassigned);
  (c) drag onto a slot already taken by that crew → revert + a toast. Use Playwright's drag
  (`locator.dragTo` or manual mouse move/up). dnd e2e can be flaky — prefer asserting the resulting
  state (post-revalidate) over mid-drag visuals; keep at least the reassign + one reschedule + the
  conflict-revert.

## Decisions (locked)
- Snap = **30 min** (week). Crew-drag = **reassign only** (day/time unchanged). **Optimistic + revert**,
  no confirm dialog. Duration is preserved on every reschedule.

## Out of scope (later / deferred)
- **Slice C**: click an empty slot to create an appointment.
- Drag-to-resize (changing duration); dragging across the week/month range boundary (drop only within
  the visible range); a richer touch-drag UX beyond `@dnd-kit` defaults; multi-select drag.

## Risks / honest constraints
- **tz inverse (`zonedTimeToUtc`) is approximate in the DST spring-forward gap** — a wall time that
  doesn't exist gets mapped to the nearest valid instant. Negligible for roofing scheduling; pinned by
  round-trip tests outside the gap.
- **dnd in a percentage-positioned time grid** — `event.delta.y` is the pixel delta; mapping to minutes
  uses the fixed 560px grid height (matches WeekGrid). If the grid height changes, the constant must
  change with it (kept in one place, passed into `applyDragToWeek`).
- **Optimistic state + `revalidatePath`** — after a successful action the server refresh re-seeds props;
  the client must re-sync `appts` from props (effect on `props.appts`) so the optimistic and server
  states converge without flicker.
- **dnd e2e flakiness** — asserted via resulting state, not drag animation; conflict-revert is the most
  valuable and least flaky assertion (state simply doesn't change + toast appears).
