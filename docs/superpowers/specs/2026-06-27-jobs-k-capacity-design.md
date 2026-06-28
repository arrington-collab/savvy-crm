# Jobs K — Capacity view (rep load vs. availability) (design)

**Date:** 2026-06-27
**Slice:** Jobs build-order item **K** (capacity; pairs with **J** the exception
queue). Branches off clean `main`.

## Goal

Give the dispatcher/owner a `/capacity` view: for the next 7 days, each rep's
**utilization** — booked appointment-hours vs. available office-hours (minus
time-off blocks) — sorted most-loaded first, so it's obvious who's **overbooked**
and who has room.

## Why now

The product runs operations through scheduling; J surfaced *exceptions*, K
surfaces *load balance*. The scheduling primitives all exist (appointments with
real durations, office hours, rep time-off blocks) but **nothing computes
utilization** — the schedule page only shows raw appointment counts per rep.

## Key facts from exploration (drives the design)

- **Capacity is per-user.** Appointments carry `assignee_user_id` (a `user`);
  there is no crew/team entity. "Reps" = active users with role ∈
  `{owner, admin, rep}` (`listAssignableReps`). The `crew` role is not in the
  assignable pool — out of scope.
- **Office hours are shared, per-weekday.** `parseSchedulingConfig` →
  `hours: Record<Weekday, [open,close] | []>` (default Mon–Fri 8–17, weekends
  closed). **Any 7 consecutive days contain exactly the 5 weekdays**, so a
  default-config window = `5 × 9h = 2700` available minutes — deterministic.
- **Booked time = real appointment duration** (`ends_at − starts_at`), summed
  per rep over `status='scheduled'` appointments whose `starts_at` is in the
  window.
- **Time-off** = `rep_availability_block` rows; their overlap with the window
  reduces a rep's available minutes.
- **Timezone** = `tenant.settings.finance.timezone` (`getTenantTimezone`); day
  boundaries via the existing `toCivilDate`/`addDays`/`zonedTimeToUtc` helpers.

## What it shows

A `/capacity` page (server component), window = **next 7 days**:
- **Team header:** team utilization % + count of overbooked reps + "next 7 days".
- **Per-rep rows** (sorted by utilization desc): name, a utilization bar
  (colored by status), the % , and `Xh booked of Yh · N appts`.
- **Status:** `over` (≥100%), `high` (≥80%), `ok` (>0%), `free` (0%).

## Design decisions (locked; labels per Brett's response-quality rule)

- **[ASSUMED] Window = next 7 days** from today (tenant tz), fixed for v1
  (no date picker). Pairs with the weekly rhythm and makes office capacity
  deterministic (always the 5 weekdays).
- **[ASSUMED] Available = office minutes in window − time-off overlap**, clamped
  to ≥ 0. Blocks are subtracted in full (not just their office-hours portion) —
  a documented simplification (blocks are typically during work hours).
- **[ASSUMED] Booked = Σ real appointment durations** (`ends_at − starts_at`) for
  `scheduled` appointments starting in the window. Buffers are not added (v1).
- **[ASSUMED] Utilization can exceed 100%** (overbooked beyond capacity is a real
  signal). When available = 0 but booked > 0 → 100% + `over`.
- **[INFERRED] Reuse, don't rebuild:** `parseSchedulingConfig`,
  `getTenantTimezone`, `listAssignableReps`, and the `schedule-view` tz helpers.
  Pure capacity math lives in `@savvy/core` (`capacity.ts`).
- **[INFERRED] No schema change.** Reads `appointment`, `rep_availability_block`,
  `user`, `tenant.settings` via `withTenant`.
- **[ASSUMED] Unassigned appointments** (null `assignee_user_id`) are not a rep's
  load → excluded from capacity (they show on the Schedule/Exceptions surfaces).

## Surfaces

- **Core (`@savvy/core`):** `officeMinutesForWindow(config, civilDates)`,
  `overlapMinutes(aStart, aEnd, wStart, wEnd)`, `buildCapacityView(input)` +
  types. Unit-tested.
- **Web (`apps/web`):** `capacity-queries.ts` (`getCapacityView()` — window math,
  per-rep appt/block aggregation), a `/capacity` page, a Sidebar nav entry.
  Playwright e2e.

## Out of scope (later)

- Crew/team capacity (no crew entity exists yet — `D1c`).
- Per-rep custom hours; a configurable window / date range.
- Drag-to-rebalance from the capacity view; suggested reassignments.
- Subtracting only the office-hours portion of a time-off block.

## Non-negotiables touched

- Tenant isolation: every query via `withTenant`; no new raw cross-tenant path.
- No hard-coded model strings (no AI here).
