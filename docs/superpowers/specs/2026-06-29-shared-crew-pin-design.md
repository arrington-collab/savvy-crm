# Shared crew PIN (design)

**Date:** 2026-06-29 · Follow-up to D1c/crew-base. One shared PIN per crew; a member enters it then **taps their name**, so check-ins keep per-person attribution.

## Decision (with Brett)
Shared PIN authenticates the crew; the member self-identifies → `session.crewUserId` = the picked member. **No `crew_checkin` schema change** (attribution stays per-person). **Backward compatible** — existing per-user PINs still work.

## What exists (origin/main @ 0ae0155)
- `crew_pin.ts` (core): `hashPin(pin)` → `scrypt$salt$hash`; `verifyPin(pin, stored)`. Reuse as-is.
- `crewLogin(key, pin)` (`apps/web/src/lib/crew-actions.ts`): rate-limit → `tenantByKey(key)` (key = `tenant.publicKey`) → scan active `role='crew'` users' `pinHash` via `verifyPin` → `setCrewCookie({tenantId, crewUserId})`. Uses `adminDb`.
- `CrewSession = { tenantId, crewUserId }` (`crew-session.ts`), token = `signPayloadToken` (string-only payload), cookie `crew_session`, 12h, secret `CREW_SESSION_SECRET`.
- `CrewGate.tsx`: PIN-only form → `crewLogin(workspaceKey, pin)` → refresh.
- Check-in: `crewCheckIn/Out` use `s.crewUserId`; `crew_checkin.crewUserId` notNull FK user. `getJobCheckins` shows `crewName` from it.
- Per-user PIN admin: `setCrewPin(userId, pin)` (`crew-admin-actions.ts`, `/^\d{6,8}$/`, `isOrgAdmin`).
- Crew entity admin: `settings/crews` (`CrewsManager.tsx` + `crew-team-actions.ts` + `lifecycle/crew.ts`).
- e2e `crew.spec.ts`: PIN-only login at `/crew/[key]` → see job → check in/out; asserts `crew_checkin` row + `agentRun`.

## Design

### Schema (migration 0034)
- `crew.pinHash` (nullable text) in `schema/crew.ts`.

### DB lifecycle (`packages/db/src/lifecycle/crew.ts`)
- `setCrewPinHash({ tenantId, crewId, pinHash: string | null })` — stores the hash (hashing done in the web action).
- `listCrews` → add `hasPin: boolean` (`pinHash != null`); **never return the hash**.
- `getCrewLoginCandidates(tenantId): Promise<{ id; pinHash: string|null; members: { id; name }[] }[]>` — ACTIVE crews with their active `role='crew'` members (server-only, used by login). Uses `withTenant`.

### Login (two-step, `apps/web/src/lib/crew-actions.ts`)
- `crewLogin(key, pin)`:
  1. rate-limit + `tenantByKey` (unchanged).
  2. **Crew PIN first:** `getCrewLoginCandidates(t.id)`; find crew where `verifyPin(pin, c.pinHash)`. If matched & has members → return `{ selectCrew: { crewId, members } }` (NO cookie set yet). If matched but 0 members → `{ error: "crew has no members" }`.
  3. **Fallback (per-user, unchanged):** scan `role='crew'` users; on match `setCrewCookie({tenantId, crewUserId})` → `{ ok: true }`.
  4. else `{ error: "invalid PIN" }`.
  - Return type: `{ ok: true } | { selectCrew: { crewId: string; members: { id: string; name: string }[] } } | { error: string }`.
- `crewSelectMember(key, pin, userId)` — NEW: rate-limit; `tenantByKey`; `getCrewLoginCandidates`; **re-verify** the crew PIN (find the crew whose `verifyPin(pin, …)` matches) AND confirm `userId` ∈ that crew's members (prevents a session without the PIN). Then `setCrewCookie({ tenantId, crewUserId: userId })` → `{ ok: true }`. (Re-verifying the PIN here is the security crux — the second step is not a bare "set session for any user".)

### CrewGate (`(crew)/crew/[key]/CrewGate.tsx`)
- Step 1: PIN → `crewLogin`. If `{ ok }` → refresh (per-user). If `{ selectCrew }` → keep `pin` + `members` in state, show a member picker.
- Step 2: member buttons → `crewSelectMember(key, pin, userId)` → refresh. data-testid: `crew-member-pick`, `crew-member-option`.

### Settings (`settings/crews`)
- `crew-team-actions.ts`: `setCrewPinAction(crewId, pin: string | null)` — `isOrgAdmin`, validate `/^\d{6,8}$/` (null clears), `hashPin`, `setCrewPinHash`, revalidate. `listActiveCrews`/`listCrews` already feed the page; surface `hasPin`.
- `CrewsManager.tsx`: per-crew PIN input + Save (shows "PIN set" when `hasPin`). Mirror the per-user `CrewPinManager` validation/UX. data-testid: `crew-pin-input`, `save-crew-pin-btn`.

## Tests
- **db `crew.test.ts`:** `setCrewPinHash` stores; `listCrews.hasPin` true/false; `getCrewLoginCandidates` returns active crews + members, excludes inactive crews / deactivated members; cross-tenant safe.
- **e2e `crew.spec.ts` (extend):** seed a crew with `pinHash` + 2 members; `/crew/[key]` → enter shared PIN → member picker appears → tap a member → see jobs → check in → assert `crew_checkin.crewUserId` == the picked member. Keep the existing per-user-PIN test green.
- **core `crew-pin.test.ts`:** unchanged (reused).
- Web verified via `pnpm typecheck` + `pnpm lint` + e2e.

## Out of scope
- Crew-level (non-person) check-in attribution (the rejected Option A).
- Rotating/expiring crew PINs; per-crew workspace key.
