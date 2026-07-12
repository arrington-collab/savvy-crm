# Claude Code prompt — Phase 2: Dossier storm history + roof age/material (StormProof)

_Paste everything below the line into a Claude Code session opened on `~/Sites/savvy-crm`.
Requires Phase 1 (`/api/canvass/dossier` + the knock-modal card) to be done and merged first.
Read `CLAUDE.md`._

---

You are extending the **door dossier** so each knock card also shows **verified storm history** and
**roof age / material** for the address — e.g. "Verified hail 6/12/26 (2.75in) · ~19-yr shake roof."

**Good news: the data source already exists and is wired.** Do NOT add a new vendor. Savvy already
has a StormProof gateway at `packages/integrations/src/stormproof.ts` exporting `httpStormProof`
(and `makeFakeStormProof` for tests) with these methods — use them directly:

```ts
interface StormProofGateway {
  getProperty(o: { lat?; lng?; address? }): Promise<PropertyData | null>;   // { yearBuilt, roofAge, roofType, county, supported }
  lookupStorms(o: { lat?; lng?; address?; months? }): Promise<StormSummary>; // { events[], maxHailInches, maxWindMph, daysSinceWorst, worstEventId }
  generateCertificate(...): Promise<...>;  // DO NOT call this — it mints a cert (side effects/cost)
}
```
`lookupStorms` hits `/api/storms/verified` (a read; no cert minted). `getProperty` hits `/api/property`.
Both are **lat/lng lookups** and both fail soft (return `EMPTY_STORMS` / `null`) when
`STORMPROOF_API_BASE` / `STORMPROOF_API_KEY` are unset — so the build works even before creds exist.

## What to build

### 1. Extend the dossier endpoint
In `apps/web/src/app/api/canvass/dossier/route.ts` (from Phase 1), after building the internal
dossier, also call the gateway for the point and merge the results:
- `const storms = await sp.lookupStorms({ lat, lng, months: 24 })`
- `const prop = await sp.getProperty({ lat, lng, address })`

where `sp` is injectable and defaults to `httpStormProof` (import from `@savvy/integrations`). Put the
"assemble storm+property lines from the gateway results" logic in the **pure helper** from Phase 1
(`canvass-dossier.ts`) so it stays unit-testable with `makeFakeStormProof`.

Add to the dossier response:
```json
{
  "storm": { "worstDate": "2026-06-12", "hailInches": 2.75, "windMph": null, "daysSince": 24, "eventCount": 3 },
  "property": { "roofAgeYears": 19, "roofType": "shake", "yearBuilt": 2007, "supported": true }
}
```
Map from the gateway: `storm` from `StormSummary` (pick the worst event for the date; `hailInches` =
`maxHailInches`; `daysSince` = `daysSinceWorst`). `property` from `PropertyData`. When a field is null
or `supported` is false, omit that line rather than showing "unknown".

**Performance / cost — required:**
- These are external HTTP calls, so run them with `Promise.all` alongside the internal query, and wrap
  each in a try/catch that returns null on failure (never let a storm timeout block the dossier).
- **Cache by rounded coordinates** to avoid re-charging for the same door: round lat/lng to ~5 decimals
  and cache the gateway result (in `canvass_knock`-adjacent storage, a small `dossier_cache` table keyed
  on `(tenant_id, geohash-or-rounded-latlng)`, or a short-TTL in-memory/edge cache). Confirm with the
  StormProof owner whether `lookupStorms`/`getProperty` are metered before turning this loose on every
  knock; if metered, caching is mandatory, TTL ~30 days for property, ~7 days for storms.
- **Do NOT** call `generateCertificate` anywhere in the dossier path — that has side effects and cost.

### 2. Optional (nice-to-have) — persist roof data onto known properties
If the dossier point matches an existing `property` row for the tenant (within ~30 m) and that row's
`roof_type` / `year_built` are null, backfill them from `getProperty`. Skip if it complicates the slice
— the live lookup is enough for the card. If you do it, go through `withTenant` (RLS).

### 3. Field app — add the lines to the dossier card
In `~/Sites/savvy-canvass/index.html`, in the dossier card rendered inside `openKnockModal`, add up to
two more lines when present:
- Storm: `⛈ Verified hail 6/12/26 · 2.75in` (format the date; show wind instead if hail is 0). If
  `daysSince` is small, emphasize it (recent storm = hot lead).
- Roof: `🏠 ~19-yr shake roof` (roofAgeYears + roofType). Older roof = better opener.
Keep the app's design tokens (paper/copper/serif). Fail soft: no storm/roof block if the data is absent.
Bump `APP_VERSION`. Copy the final file to `~/Sites/savvy-canvass-deploy/index.html` too.

## Tests
Follow the injectable-gateway pattern already used across `packages/agents` (e.g.
`canvass-contract.test.ts` uses `makeFakeStorage`). Use `makeFakeStormProof` for the dossier helper
test: assert the storm + property lines are assembled correctly, and that a null/`supported:false`
result omits the line. Then: `pnpm typecheck && pnpm lint && pnpm test` (Postgres up via `pnpm db:up`).
Ignore the pre-existing `@savvy/integrations` `vapi.ts` typecheck error — just add no new errors.

## Prerequisite you (Arrington) must handle — NOT a code task
Set these in Vercel → savvy-crm → Environment Variables (Production):
`STORMPROOF_API_BASE` and `STORMPROOF_API_KEY`. Until they're set, the endpoint returns storm/property
as null and the card just omits those lines (no error). Get the values + confirm per-lookup metering
from the StormProof / stormproofcerts.com owner.

## Deploy (webhook is broken — CLI deploy)
- Backend: `cd ~/Sites/savvy-crm && npx vercel --prod --archive=tgz --force --scope advosy`
- Field app: `cd ~/Sites/savvy-canvass && npx wrangler pages deploy . --project-name=savvy-canvass`
- Verify: with a real rep token, `GET /api/canvass/dossier?lat=..&lng=..` returns the `storm` and
  `property` keys (values may be null until creds are set — that's expected).

## Definition of done
- [ ] Dossier endpoint merges `lookupStorms` + `getProperty`, injectable, fail-soft, cached by rounded coords
- [ ] `generateCertificate` is never called in this path
- [ ] Pure helper unit-tested with `makeFakeStormProof` (present + absent cases)
- [ ] Knock card shows storm + roof lines when present; matches app design; fails soft
- [ ] `pnpm typecheck && pnpm lint && pnpm test` clean (no new errors); both apps deployed
- [ ] `APP_VERSION` bumped; `savvy-canvass-deploy/index.html` mirrored

## Guardrails
- Tenant isolation on every DB query (`withTenant`); external gateway calls are read-only lookups.
- No new vendors, no `generateCertificate`, no secrets in the repo (creds via Vercel env).
- Small, reviewed commit. **Only ONE Claude Code session on `savvy-crm` at a time** — concurrent
  sessions overwrite each other on this repo; confirm none is active before editing.
