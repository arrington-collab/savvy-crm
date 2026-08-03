# Claude Code prompt — Phase 1: Door Dossier (internal data)

_Paste everything below the line into a Claude Code session opened on `~/Sites/savvy-crm`.
Build the field-app half in `~/Sites/savvy-canvass`. Read `CLAUDE.md` first._

---

You are building **Phase 1 of the "door dossier"** for Northwind Roofing's door-knocking system.
Goal: when a canvasser opens the knock modal at an address, show a small card built **only from
Northwind's own Savvy data** so the opener writes itself — e.g. "You've done 2 roofs on this street ·
the Hendricks 2 doors down are customers · this door was knocked 4 days ago (no answer)."

**No external vendors in this phase.** Roof age/material and storm swaths are later phases —
do NOT add them now. Use only data already in Savvy's Postgres.

## Repos & where things live
- Backend + DB: `~/Sites/savvy-crm` (Next.js App Router monorepo, pnpm + Turborepo). Read `CLAUDE.md`.
- Field app: `~/Sites/savvy-canvass/index.html` (single-file client app). Also copy the final file to
  `~/Sites/savvy-canvass-deploy/index.html` (mirror used for deploy).
- The field app calls the backend at `https://savvy-crm.vercel.app/api/canvass/*`.

## What to build

### 1. Backend endpoint — `GET /api/canvass/dossier`
Create `apps/web/src/app/api/canvass/dossier/route.ts`. **Copy the exact auth/CORS/RLS pattern from
`apps/web/src/app/api/canvass/knocks/route.ts`** — do not invent a new one. Specifically:
- Auth: `const sess = verifyCanvassToken(bearerToken(req.headers))` → 401 if missing. Tenant comes
  from `sess.tenantId`. **Never** accept a client-supplied tenant key for this route — it returns PII.
- CORS: use `canvassCors(req, "GET, OPTIONS")` from `@/lib/canvass-cors`; add an `OPTIONS` handler.
- All DB reads go through `withTenant(sess.tenantId, tx => ...)` (RLS — non-negotiable, see CLAUDE.md).
- `export const runtime = "nodejs"`.

Query params: `lat`, `lng` (required, numbers), `address` (optional string).

Behavior (keep it fast — bounding-box prefilter in SQL, precise distance in JS):
- **Nearby jobs / customers:** select `job` joined to `property` (has `lat`,`lng`,`address`) and
  `customer` (has `name`) for the tenant, prefiltered to a ~0.004° lat/lng bounding box around the
  point, then compute haversine distance in JS and keep those within **250 m**. Return up to 8,
  nearest first: `{ customerName, address, distanceM, stage }`.
- **Roofs on this street:** of the tenant's jobs, count those whose `property.address` shares the
  same street name as the passed `address` (normalize: lowercase, strip leading house number, compare
  the street token). If no `address` param, fall back to count of nearby jobs within 250 m.
- **Prior knock at this door:** query `canvass_knock` for the tenant within ~30 m of the point
  (bounding box + haversine); return the most recent as `{ outcome, ts, repName }` or null. Join
  `canvass_rep` for the name like the knocks route does.
- **Is existing customer here:** true if any nearby job is within ~30 m.

Response JSON:
```json
{
  "roofsOnStreet": 2,
  "nearby": [{ "customerName": "Hendricks", "address": "1420 Elm St", "distanceM": 38, "stage": "closed" }],
  "priorKnock": { "outcome": "noanswer", "ts": "2026-07-02T18:04:00Z", "repName": "Alex" },
  "isExistingCustomer": false
}
```

Put the pure logic (haversine, bounding box, street-name normalize, "build dossier from rows")
in a **testable helper** — either a new file in `packages/core/src/` (e.g. `canvass-dossier.ts`,
export from `packages/core/src/index.ts`) or `apps/web/src/lib/`. Keep the route thin.

### 2. Clerk middleware — REQUIRED, do not skip
Add the new route to the public allowlist in `apps/web/src/middleware.ts`. Change the canvass regex
to include `dossier`:
```
/^\/api\/canvass\/(login|contract|reps|knocks|eod|territories|dossier)$/
```
**If you skip this, the route returns a 404 HTML page even though it exists** (Clerk intercepts it).
The route self-authenticates via the canvass session token, so it must be Clerk-public. (This exact
gap already bit this project once.)

### 3. Field app — show the card
In `~/Sites/savvy-canvass/index.html`, in `openKnockModal(latlng, preset)`, after the modal opens,
fetch the dossier and render a compact card near the top of the knock modal (above the outcome
buttons). Use the app's existing helpers: `canvassBase()` for the URL base, `authHeaders()` for the
bearer token. Example call: `fetch(canvassBase()+'/dossier?lat='+lat+'&lng='+lng+'&address='+enc)`.
- Fail-soft: if the fetch fails or returns nothing useful, show nothing (never block logging a knock).
- Match the app's design tokens exactly: paper card `var(--card)`, border `var(--bord)`, copper accent
  `var(--acc)`, serif headings `var(--serif)`, muted text `var(--mut)`. It should look native.
- Copy: lead with the strongest line, e.g. "🏠 2 roofs on this street" / "✓ Hendricks (2 doors down)
  are customers" / "🚪 Knocked 4 days ago — no answer". Keep it 2–4 short lines.
- Bump `APP_VERSION` (currently `1.3.0-beta`) to the next minor.
- When done, copy the file to `~/Sites/savvy-canvass-deploy/index.html` as well.

## Tests & verification (run these; keep them green)
Start Postgres first (DB-backed tests need it): `pnpm db:up` (or the repo's documented command).
- Add a vitest for the pure helper (distance, street-normalize, dossier assembly). Follow the style of
  `packages/agents/src/functions/canvass-contract.test.ts` for any DB-backed test (seed a tenant +
  customer + property + job + canvass_knock, call the helper/route logic, assert the dossier).
- Run and fix until clean: `pnpm typecheck && pnpm lint && pnpm test`.
- Note: `@savvy/integrations` `vapi.ts` has a PRE-EXISTING typecheck error unrelated to this work —
  don't try to fix it; just confirm you introduced no NEW errors.

## Deploy (do this yourself at the end, report the URLs)
The GitHub→Vercel auto-deploy webhook is currently broken, so deploy via CLI:
- Backend: `cd ~/Sites/savvy-crm && npx vercel --prod --archive=tgz --force --scope advosy`
- Field app: `cd ~/Sites/savvy-canvass && npx wrangler pages deploy . --project-name=savvy-canvass`
- Verify the route is live (should return `{"error":"unauthorized"}` JSON, NOT a 404 HTML page):
  `curl -s https://savvy-crm.vercel.app/api/canvass/dossier?lat=39.7&lng=-104.9 | head -c 100`

## Definition of done
- [ ] `/api/canvass/dossier` live, self-authed, RLS-scoped, in the Clerk allowlist
- [ ] Dossier card renders in the knock modal, matches the app design, fails soft
- [ ] Pure helper unit-tested; `pnpm typecheck && pnpm lint && pnpm test` clean (no new errors)
- [ ] Both `savvy-canvass/index.html` and `savvy-canvass-deploy/index.html` updated; `APP_VERSION` bumped
- [ ] Both apps deployed; dossier route verified returning JSON

## Guardrails
- Tenant isolation on every query (`withTenant`) — never bypass RLS.
- This is internal data only — no StormProof, no parcel vendors, no new API keys.
- Small, reviewed commit with a clear summary.
- **Only run ONE Claude Code session on `savvy-crm` at a time** — concurrent sessions overwrite each
  other's work (this has happened on this repo). Confirm no other session is active before editing.
