# D1c — Crew teams (design)

**Date:** 2026-06-29 · **Slice:** Jobs build, D1c (the last open Jobs item). Adds a crew/team entity so install (`type='crew'`) appointments are assigned to a crew, with crew-level capacity + crew-member check-in.

## Goal
1. **Crew entity + membership** — define crews (named teams of `crew`-role users) and staff them.
2. **Crew-assigned installs** — `type='crew'` appointments are assigned to a CREW (`appointment.crewId`), not an individual; a crew can't be double-booked (DB EXCLUDE constraint).
3. **Crew capacity** — a per-crew lane on `/capacity` (utilization = crew install-minutes vs office minutes in the 7-day window).
4. **Crew-member check-in** — any member of the assigned crew can check into that crew's install jobs.
5. **Settings UI** — manage crews + membership.

## Scope boundary (decided with Brett)
- **Rep / lead assignment stays per-user** — D1c does NOT touch `getAssignmentCandidates`, `pickAssignee`, territory/round-robin, or `listAssignableReps`. Crews are install teams only.
- Crew overlap protection = **DB EXCLUDE constraint** on `(crew_id, time_range) WHERE status='scheduled'` (parallels the existing per-user `appointment_no_overlap`; `btree_gist` already enabled in migration 0003).
- **Accepted tradeoff:** the schedule form's drive-time "recommended slots" is keyed on a single user's base location; a crew entity has no base, so recommended-slots will not show for crew-entity installs. Documented follow-up: give `crew` a base lat/lng later to restore it.

## What exists (verified on origin/main @ 1ad8bde)
- No `crew`/team table. "crew" today = (a) `APPOINTMENT_TYPE` value `'crew'` (480-min install) and (b) `USER_ROLE` value `'crew'` (PIN-only field rep).
- `appointment.assigneeUserId -> user` (single). No-overlap = `EXCLUDE USING gist (assignee_user_id WITH =, tstzrange(starts_at,ends_at,'[)') WITH &&) WHERE status='scheduled'` (migration 0003; **null assignee rows are skipped by GiST** — so crew installs with null user need the parallel crew constraint).
- `bookAppointment(BookInput)` throws `SlotTakenError` (pg code 23P01) on EXCLUDE violation; UI already handles `slot_taken`.
- `crew_checkin(crewUserId -> user, jobId, ...)` — per-person check-in. `listCrewJobs(CrewSession{crewUserId})` grants access to jobs where `appointment.assigneeUserId = crewUserId AND type='crew'` (or `job.assignedUserId`). `crewCanAccessJob` derives from it.
- `/capacity`: `getCapacityView()` (`apps/web/src/lib/capacity-queries.ts`) → `buildCapacityView()` (`packages/core/src/capacity.ts`): per-rep `scheduledMin` vs `officeMinutesInWindow - blockedMin`. `officeMinutesForWindow(config, civilDates)` gives office minutes.
- Schedule create form (`CreateAppointmentForm.tsx`): one dropdown (labelled "Crew") bound to `assignee` (a **userId**, `props.crew: {id,name}[]`); `createAppointmentAction({type, assigneeUserId, ...})` → `bookAppointment`.
- RLS: `tenantIsolation()` is a drizzle `pgPolicy` → drizzle auto-emits `CREATE POLICY "tenant_isolation" ... TO "savvy_app"` for new tables (seen in 0030).

## Design

### Schema (`packages/db/src/schema/crew.ts`)
- `crew`: `id, tenantId -> tenant, name text notNull, active boolean notNull default true, createdAt`. `index(tenant)`, `tenantIsolation()`.
- `crewMember`: `id, tenantId -> tenant, crewId -> crew, userId -> user, createdAt`. `uniqueIndex(crewId,userId)`, `index(tenant)`, `tenantIsolation()`.
- `appointment.crewId`: nullable `uuid -> crew`. `index(tenant, crewId)`.
- Export new tables from `packages/db/src/schema/index.ts`.

### Migration (0031 — next number)
- Drizzle-generated: create `crew` + `crew_member` (+ RLS policies + FKs + indexes), add `appointment.crew_id` (+ FK + index).
- **Hand-append** (like 0003) the crew EXCLUDE:
  ```sql
  ALTER TABLE "appointment" ADD CONSTRAINT "appointment_crew_no_overlap"
    EXCLUDE USING gist (crew_id WITH =, tstzrange(starts_at, ends_at, '[)') WITH &&) WHERE (status = 'scheduled');
  ```
- Commit the whole `packages/db/drizzle` dir (sql + `_journal.json` + snapshot).

### DB lifecycle (`packages/db/src/lifecycle/crew.ts`)
- `createCrew({tenantId, name})` → CrewRow.
- `listCrews(tenantId)` → `{ id, name, active, members: {userId, name}[] }[]` (join crew_member→user).
- `renameCrew({tenantId, crewId, name})`, `setCrewActive({tenantId, crewId, active})`.
- `addCrewMember({tenantId, crewId, userId})` (idempotent on unique), `removeCrewMember({tenantId, crewId, userId})`.
- `listCrewIdsForUser(tx, tenantId, userId)` → string[] (the user's crew ids; used by check-in access).
- Extend `bookAppointment` `BookInput` with `crewId?: string | null` (insert it). Export all from `packages/db/src/index.ts`.

### Capacity (`packages/core/src/capacity.ts` + `capacity-queries.ts`)
- Add `CrewCapacityInput = { crewId; name; scheduledMin; apptCount }`, `CrewCapacity = CrewCapacityInput + { availableMin; utilizationPct; status }`, and `buildCrewCapacityView({ officeMinutesInWindow, windowDays, crews })` reusing the existing `util()`/`statusOf()` (no per-crew blocks). Returns `{ crews: CrewCapacity[]; teamUtilizationPct; overCount }`.
- `capacity-queries.ts`: in the same `withTenant` tx, fetch active crews + the window's `type='crew'` appts with a non-null `crewId`; sum durations per crew → `buildCrewCapacityView`. Return alongside the rep view.
- `/capacity` page: render a "Crews" section mirroring the rep lane.

### Crew-member check-in access (`apps/web/src/lib/crew-queries.ts`)
- In `listCrewJobs`, also include jobs where `appointment.crewId IN listCrewIdsForUser(tx, tenantId, crewUserId)` (union with the existing assignee/job-assigned conditions). `crewCanAccessJob` inherits it. (Check-in still records the individual `crewUserId` — no `crew_checkin` schema change.)

### Schedule create form + action
- `createAppointmentAction` gains `crewId?: string | null`; passes it to `bookAppointment`.
- `CreateAppointmentForm`: when `type === 'crew'`, the dropdown lists **crew entities** (new `crews` prop) → sets `crewId` (assigneeUserId null); for other types, unchanged (user assignee). Gate the recommended-slots `useEffect` to the user-assignee path only (skip for crew-entity installs). The page that renders the form passes `crews` from `listCrews`.

### Settings UI (`apps/web/src/app/(app)/settings/crews/`)
- A page listing crews with members; create crew, rename, activate/deactivate, add/remove members (member options = `role='crew'` users). Server actions in `apps/web/src/lib/crew-team-actions.ts` wrapping the db fns + `revalidatePath`. Mirror `settings/team` / `settings/crew` (PIN) structure.

## Tests
- **db `crew.test.ts`:** createCrew/listCrews(with members)/rename/setActive/add+removeMember (idempotent), `listCrewIdsForUser`, cross-tenant RLS returns nothing.
- **db `appointments` (extend):** booking two overlapping `crew` appts for the same crew → `SlotTakenError`; non-overlapping or different crew → ok; crewId persists.
- **core `capacity.test.ts`:** `buildCrewCapacityView` utilization/status math + empty-crew case.
- **web:** `pnpm typecheck` + `pnpm lint`; Playwright e2e only if a seeded crew/install path exists (select by unique handle).

## Out of scope (explicit follow-ups)
- Team-based lead/rep assignment + team availability in slot suggestion (Option C).
- Crew base location → drive-time recommended slots for crew installs.
- Shared crew-level PIN (members still log in with their own PIN).
- Per-crew availability blocks / crew working-hours overrides.
