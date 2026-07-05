# Canvass Slices 2-4 Relaunch Plan

**Why:** The canvass Slices 2-4 work (`backup/canvass-slices-2-4` @ `55ea73c`) was stranded behind a stale, conflicted merge on local `main`: (a) its migration `0050_striped_penance` collides with origin's `0050`/`0051`; (b) it predates PR #139's canvass-auth hardening and its new privileged mutations use the non-secret public-key auth #139 removed. This relaunches the work correctly as a fresh PR off current `origin/main`.

**Source of truth for the code:** the backup branch `backup/canvass-slices-2-4` (commit `55ea73c`). Re-apply its NON-migration changes; regenerate the migration.

## Sequencing (migration numbering)
- Cell-6 PR #141 owns migration `0052`. **This relaunch must be built off a `main` that already contains #141's `0052`**, so `db:generate` yields **`0053`** naturally (no manual renumber). → Land #141 first, then rebuild off updated main.
- Do NOT reuse `0050_striped_penance.sql` / its snapshot / journal entry. Delete them; regenerate from the schema diff.

## Files to re-apply (from 55ea73c)
- `packages/db/src/schema/canvass.ts` (+41 lines — knock/territory/GPS/EOD/deactivate columns) → drives the new migration.
- `packages/core/src/canvass.ts` (+48) + `canvass.test.ts` (zod objects: `canvassRepCreateObject`, `canvassDeactivateObject`, knock/territory schemas).
- `apps/web/src/app/api/canvass/knocks/route.ts` (new), `eod/route.ts` (new), `territories/route.ts` (new), `reps/route.ts` (PATCH added).
- Regenerate: `packages/db/drizzle/0053_*.sql` + snapshot + journal via `db:generate`.

## Auth model (the security correction — enforce exactly this)
Privileged **manager mutations** require an authenticated org-admin session with the tenant derived from the session (mirror `reps` POST as hardened by #139 — `getTenantId()` + `isOrgAdmin()`), NEVER `tenantByKey(publicKey)`:
- `reps` **PATCH** (deactivate/reactivate rep) → **org-admin** (currently public-key — FIX).
- `territories` **POST** (create territory) → **org-admin** (currently public-key — FIX).

Field-device actions keep the existing model (consistent with #139):
- `reps` POST already org-admin (#139) — keep.
- `knocks` POST (a rep logs their OWN knock) → rep-authenticated session (verify it's a real rep-PIN session, not a public-key masquerade; keep if legitimate).
- `knocks` GET / `eod` GET / `territories` GET (field team map/summary reads) → public-key (`?key=`) OK — reads, non-secret, the accepted field model.

## Steps
1. **Prereq:** #141 merged to main; rebase/​recreate this worktree off updated `origin/main` (must contain `0052`).
2. Re-apply schema + core + core tests from `55ea73c` (cherry-pick `-n`, then drop the old migration files).
3. Re-apply the 4 routes from `55ea73c`; resolve `reps/route.ts` to KEEP #139's org-admin POST + ADD the PATCH.
4. **Harden:** add `getTenantId()` + `isOrgAdmin()` gate to `reps` PATCH and `territories` POST; drop their `tenantByKey(key)` tenant resolution.
5. `db:generate` → `0053_*.sql`; apply to local dev DB; confirm it only adds the canvass columns/tables, touches no other table.
6. **TDD tests** for the hardened auth: `reps` PATCH and `territories` POST each reject a non-admin / no-session request (401/403) and succeed for an org-admin; plus the happy-path behavior of the new routes. Follow the existing canvass e2e/test patterns.
7. Typecheck + lint + relevant vitest; e2e for the new routes if the suite covers canvass.
8. Full whole-branch review (security focus on the auth gates), then PR → CI → merge. Run `0053` on prod post-merge.

## Definition of Done
- [ ] Migration `0053` (not 0050); no collision; additive; canvass columns only.
- [ ] `reps` PATCH + `territories` POST require org-admin (tests prove non-admin is rejected).
- [ ] Field reads + rep-knock write behavior preserved.
- [ ] All suites + typecheck + lint green; PR reviewed + CI green.
- [ ] `backup/canvass-slices-2-4` retained until merged; local `main` reset to origin/main afterward (its stale 55ea73c/48739f8 superseded).
