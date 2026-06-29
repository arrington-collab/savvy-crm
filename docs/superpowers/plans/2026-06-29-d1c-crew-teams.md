# D1c — Crew teams — execution plan

Spec: `docs/superpowers/specs/2026-06-29-d1c-crew-teams-design.md`. Worktree `.claude/worktrees/crew-teams` (off origin/main @ 1ad8bde). One PR off `main`. Next migration = **0031**.

## Task 1 — schema + migration (crew, crew_member, appointment.crewId, EXCLUDE)  (sonnet)
- `packages/db/src/schema/crew.ts`: `crew` + `crewMember` tables per spec; export from `schema/index.ts`. Add `crewId` (nullable FK → crew) + `index(tenant, crewId)` to `appointment` in `schema/comms.ts`.
- `pnpm install` in the worktree first (deps not linked), then `pnpm db:generate`.
- **Hand-append** to the generated `0031_*.sql` the crew EXCLUDE constraint (see spec). `git add packages/db/drizzle` (whole dir).
- Apply locally: `pnpm db:up` (if needed) + `pnpm --filter @savvy/db db:migrate`.
- Verify: `pnpm --filter @savvy/db typecheck`.

## Task 2 — db lifecycle `crew.ts` + bookAppointment.crewId (TDD · sonnet)
- TEST FIRST `packages/db/src/lifecycle/crew.test.ts` (`.js` relative imports): createCrew, listCrews returns members, rename, setCrewActive, addCrewMember (idempotent), removeCrewMember, `listCrewIdsForUser`; cross-tenant read returns nothing (RLS).
- IMPL `packages/db/src/lifecycle/crew.ts` per spec. Extend `BookInput` in `lifecycle/appointments.ts` with `crewId?` (insert it; default null). Export all from `packages/db/src/index.ts`.
- ALSO extend `appointments` tests: two overlapping same-crew `type='crew'` appts → `SlotTakenError`; different crew or non-overlap → ok; crewId persists.
- Verify: `pnpm --filter @savvy/db test crew && pnpm --filter @savvy/db test appointments` green; `pnpm --filter @savvy/db typecheck`.

## Task 3 — core `buildCrewCapacityView` (TDD · haiku)
- TEST FIRST in `packages/core/src/capacity.test.ts` (extend): utilization/status math for crews; empty crew (0 scheduled) → 0% / under; over case.
- IMPL in `packages/core/src/capacity.ts`: `CrewCapacityInput`, `CrewCapacity`, `buildCrewCapacityView` reusing `util()`/`statusOf()`. Export.
- Verify: `pnpm --filter @savvy/core typecheck` + run capacity test (root vitest).

## Task 4 — capacity-queries + `/capacity` Crews section  (sonnet)
- `apps/web/src/lib/capacity-queries.ts`: fetch active crews + window `type='crew'` appts with non-null crewId; sum durations per crew → `buildCrewCapacityView`; return `{ ...repView, crews }`.
- `/capacity` page: render a "Crews" section mirroring the rep lane (utilization bar, status). data-testid hooks.
- Verify: `pnpm --filter @savvy/web typecheck`.

## Task 5 — crew-member check-in access  (sonnet/inline)
- `apps/web/src/lib/crew-queries.ts` `listCrewJobs`: union-in jobs where `appointment.crewId IN listCrewIdsForUser(tx, s.tenantId, s.crewUserId)`. Keep existing conditions.
- Verify: `pnpm --filter @savvy/web typecheck`. (If feasible, a focused unit/e2e for crew-via-crewId access.)

## Task 6 — schedule form + create action crew-entity assignment  (sonnet)
- `scheduling-actions.ts` `createAppointmentAction`: add `crewId?: string | null`; pass to `bookAppointment`.
- `CreateAppointmentForm.tsx`: add `crews` prop; when `type==='crew'`, dropdown lists crew entities → `crewId` state, submit sends `{ crewId, assigneeUserId: null }`; other types unchanged. Gate the recommended-slots effect to the user-assignee path (skip for crew entities). The rendering page passes `crews` from `listCrews`.
- Verify: `pnpm --filter @savvy/web typecheck` + `pnpm lint`.

## Task 7 — settings/crews UI + actions  (sonnet)
- `apps/web/src/lib/crew-team-actions.ts`: server actions wrapping createCrew/renameCrew/setCrewActive/addCrewMember/removeCrewMember (+ revalidate).
- `apps/web/src/app/(app)/settings/crews/page.tsx` (+ client form): list crews + members; create/rename/activate/deactivate; add/remove members (options = role='crew' users). Mirror settings/team. Add a nav entry if settings has a nav list.
- Verify: `pnpm --filter @savvy/web typecheck` + `pnpm lint`.

## Task 8 — whole-branch verify + final review (controller + opus)
- `pnpm typecheck` + `pnpm lint` + `pnpm test` all green.
- Final whole-branch opus review (new tables + EXCLUDE + RLS, capacity math, the form crew/user switch, check-in access, tenant isolation). Address findings.
- PR off main; `gh pr checks <n> --watch` to green; squash-merge; remove worktree + remote branch; update memory.
