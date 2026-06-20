# Schedule Calendar + Filters (Slice A) — Design Spec (2026-06-19)

The second UX sub-project from the product walkthrough (after Navigation & discoverability,
PR #30). The current `/schedule` is a flat chronological agenda list. This replaces it with a
real calendar with three views and filtering. **Slice A of 3** — read + filter + existing
actions. Slice B (drag-to-reschedule) and Slice C (click-to-create) are separate later specs.

## Goal
A `/schedule` screen with **Week / Month / Crew** toggleable views and **four filters**
(crew, appointment type, job type, city), over existing appointments. Clicking an appointment
opens a popover with its existing actions (Done / No-show / Reschedule / Cancel) and a link to
the job. Done-when: the three views render the tenant's appointments correctly in the tenant
timezone; each filter narrows the set; the popover's actions work; and a new `property.city`
field (auto-parsed from the address) backs the city filter.

Branch `feat/schedule-calendar` off `main` (independent of open PRs #27/#28/#29/#30).

## Non-negotiables honored
- Tenant isolation: every appointment/property/job read goes through `withTenant`/RLS; the new
  `city` column is on the already-isolated `property` table.
- All testable logic (date math, view-model building, city parsing) is **pure in `@savvy/core`**
  and unit-tested; `apps/web` stays the thin rendering layer (Playwright-only, no vitest).
- Ships with tests; typecheck + lint clean; existing e2e stays green.
- No new heavy dependency (hand-built grids, not a calendar library).
- AI/agents untouched; this is a CRUD-read + UI slice.

---

## Part 1 — Data model: `property.city`

- **Migration** (next number in sequence): `ALTER TABLE property ADD COLUMN city text;` (nullable;
  drizzle-kit generates it; commit the generated `.sql` + `meta/` journal together).
- **Pure parser** `parseCityFromAddress(address: string): string | null` in
  `@savvy/core` (`address.ts`): extracts the city token — the comma-separated segment immediately
  before the `STATE ZIP` tail (e.g. `"123 Main St, Mesa AZ 85201"` → `"Mesa"`;
  `"45 Oak Ave, Phoenix, AZ 85003"` → `"Phoenix"`). Returns `null` when no city can be
  confidently extracted (single-token addresses, no comma, etc.). Unit-tested against a table of
  real-world address shapes incl. the null cases. **Heuristic, not a geocoder** — null → "Unknown"
  bucket in the UI.
- **Populate on creation**: in `apps/web/src/lib/intake.ts` (the one `insert(property)` site,
  line ~22), set `city: parseCityFromAddress(input.address)`.
- **Backfill existing rows**: a one-time script `packages/db/src/scripts/backfill-city.ts`
  (adminDb, iterate properties with `city IS NULL`, set `city = parseCityFromAddress(address)`).
  Run manually once (documented in the plan); idempotent (only touches null cities).

## Part 2 — Queries (`apps/web/src/lib/scheduling-queries.ts`)

- Extend `listAppointments(filter?)` filter type to
  `{ assigneeUserId?: string; type?: string; jobType?: string; city?: string }`:
  - **Fix the currently-ignored `type`** (today the param is accepted but never added to the
    WHERE) → `eq(appointment.type, filter.type)`.
  - Add `jobType` → `eq(job.type, filter.jobType)` (the query already left-joins `job`).
  - Add `city` → `eq(property.city, filter.city)` (already left-joins `property`); a special
    sentinel `"__unknown__"` filters `isNull(property.city)`.
  - Return additional columns on each row: `assigneeUserId`, `assigneeName` (join `user`),
    `jobId`, `jobType`, `city`. Keep `id, type, status, startsAt, endsAt, customerName, address`.
- **Filter-option queries** (small, tenant-scoped): `getScheduleCities()` →
  `SELECT DISTINCT city ... WHERE city IS NOT NULL ORDER BY city` (+ surface an "Unknown" option
  when any null exists). Reuse existing `listUsers()` for the crew list. Appointment-type and
  job-type options are static from `@savvy/core` enums (`APPOINTMENT_TYPE`, `JOB_TYPE`).

## Part 3 — Pure calendar engine (`@savvy/core/schedule-view.ts`, unit-tested)

All functions are pure and **timezone-aware via `Intl`** (the tenant's `finance.timezone`,
default `America/Phoenix`). `anchor` is an ISO date string; appointments carry ISO `startsAt`/
`endsAt`. Business-hours window for time grids = **06:00–20:00**.

- `weekRange(anchorISO, tz)` → `{ startISO, endISO, days: DayMeta[] }` (7 days, **Sunday-start**
  Sun–Sat, US convention).
- `buildWeekView(appts, anchorISO, tz)` → for each of 7 day columns, the appointments that fall
  on it, each with `{ topPct, heightPct }` positioned within 06:00–20:00 (clamped to the window
  if out of range). Overlapping appts in the same day split horizontally (simple N-column split).
- `buildMonthView(appts, anchorISO, tz)` → a 6×7 grid of day cells (leading/trailing days from
  adjacent months flagged `outside: true`), each with its appointment chips (capped at e.g. 3 +
  "more").
- `buildCrewView(appts, anchorISO, tz, crew)` → for the anchored week, one column per crew member
  (from the crew list) with that member's appointments grouped by day; an "Unassigned" column for
  `assigneeUserId === null`.
- Nav helpers: `addDays/addWeeks/addMonths(anchorISO, n, tz)`, `todayISO(tz)`.
- Color: a pure `appointmentTypeTone(type)` mapping `inspection|cm|crew` → existing status/accent
  tokens (so blocks are color-coded consistently).

## Part 4 — apps/web rendering

- **`/schedule/page.tsx`** (server, `force-dynamic`): read `searchParams`
  (`view`, `anchor`, `crew`, `type`, `jobType`, `city`); load
  `listAppointments(filters)` + `getScheduleCities()` + `listUsers()` + the tenant `finance.timezone`;
  pass everything to the client. Default `view=week`, `anchor=today`.
- **`ScheduleClient`** (replaces today's agenda client): a header with the **view toggle**
  (Week/Month/Crew), **prev / today / next** nav, and a **filter bar** of four native `<select>`s
  (crew, type, job type, city). All of view/anchor/filters are reflected in the URL searchParams
  (so a filtered view is shareable and server-rendered). Renders the chosen view component from
  the core view-models.
- **View components** (bespoke, themed): `WeekGrid`, `MonthGrid`, `CrewBoard`. Blocks/chips are
  colored by `appointmentTypeTone`; each is a button that opens the popover.
- **`AppointmentPopover`**: shows type, time range, customer, address, assignee, status; action
  buttons reuse the existing server actions `markStatusAction(id, "done"|"no_show")`,
  `rescheduleAction(...)`, `cancelAction(id)`; plus a `<Link href={`/jobs/${jobId}`}>Open job</Link>`.
  (Reschedule in Slice A keeps the existing action's UX — a prompt/inline input — NOT drag; drag is
  Slice B.)
- The current `AppointmentRow` agenda is removed (the views supersede it). The existing
  scheduling **actions** file is reused unchanged.

## Part 5 — Testing
- **Unit (vitest, `@savvy/core`)**: `parseCityFromAddress` (incl. null/edge addresses);
  `buildWeekView`/`buildMonthView`/`buildCrewView` (correct day bucketing, block positioning %s,
  outside-month flags, unassigned column, timezone correctness incl. a non-Phoenix tz);
  `addWeeks/addMonths` nav.
- **e2e (Playwright)**: seed appointments across multiple days, crews, types, and cities, then:
  the three views render (Week shows positioned blocks, Month shows chips, Crew shows per-member
  columns); each filter narrows the set (assert a known appt disappears when filtered out); the
  view toggle + prev/next change the rendered range; clicking an appointment opens the popover and
  `markStatusAction` flips its status. apps/web is Playwright-only — no vitest there.

## Decisions (locked)
- Default view **Week**; time grid **06:00–20:00**; **Sunday-start** weeks.
- Render in the tenant **`finance.timezone`** (America/Phoenix default).
- **Replace** the agenda list (not a 4th tab).
- City filter = `property.city` auto-parsed from address (heuristic; null → "Unknown").
- Hand-built grids, **no calendar library**.

## Out of scope (later slices / deferred)
- **Slice B**: drag-to-reschedule (reuses `@dnd-kit`, conflict handling vs the no-overlap constraint).
- **Slice C**: click-empty-slot to create an appointment inline.
- Recurring/multi-day appointments; all-day events; external-calendar (Google) overlay;
  per-tenant business-hours config; territory/zip area model (chose city).

## Risks / honest constraints
- **City parsing is heuristic** — messy/foreign/PO-box addresses land in "Unknown". Acceptable: it
  backs a filter, not money. The parser is unit-tested so its behavior is pinned and improvable.
- **Time-grid positioning is the fiddly bit** — overlapping-appointment layout + clamping to the
  06:00–20:00 window. That's exactly why it's pure + unit-tested in `@savvy/core`, not in the JSX.
- **Timezone**: appointments are `timestamptz`; all day-bucketing/positioning uses the tenant tz via
  `Intl` (UTC bucketing would misplace evening appts for western tenants — the same class of bug the
  finance code already guards against). DST handled by `Intl`; tested with a non-Phoenix tz.
- Migration adds a column to a large table; nullable + no default = fast (no table rewrite).
