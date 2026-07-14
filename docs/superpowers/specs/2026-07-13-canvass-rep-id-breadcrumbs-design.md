# Canvass Slice 3 — Digital Rep ID (QR) & GPS Breadcrumbs — Design

**Status:** Approved direction (Brett 2026-07-13: "spec 1 and 2 and build")
**Repos:** backend `savvy-crm`, field app `~/Sites/savvy-canvass`

## Problem / opportunity

1. **Rep ID:** Homeowners don't know who's knocking or who's on their roof. A scannable digital ID answers that fear, *and* the scan is a lead-capture + retargeting moment (per-tenant Meta pixel). Competitors (RepCard) sell digital business cards; nobody frames it as a safety/insurance-verification artifact for roofing.
2. **Breadcrumbs:** Managers can see knocks but not movement between them. Competitors (Spotio/SalesRabbit) have live rep trails; we only GPS-verify individual knocks.

## Explicit constraint — the pitch wording (decided)

The rep script must NOT claim scanning waives or transfers liability (legally false; misrepresentation risk). The page and in-app script use the **protection framing**: *"Scan this before anyone gets on your roof — it shows exactly who I am, our license, and proof we're insured."* The optional homeowner tap-through is a **property-access acknowledgment** (permission to inspect), not a waiver.

## Feature A — Digital Rep ID

### Company config (manager-entered, server-stored)

Stored in `tenant.settings.canvassId` (JSONB — no tenant migration; same pattern as `canvassLogo`):

```
{ licenseNo, insuranceCarrier, insurancePolicy, insurancePhone, coiUrl?, metaPixelId? }
```

- `coiUrl` = optional link to a hosted Certificate of Insurance PDF (no file upload in v1 — paste a URL).
- `metaPixelId` = tenant's Meta Pixel; page fires `PageView` on load and `Lead` on capture submit when set. Meta only in v1.
- Manager edits from the field app Company card → **POST `/api/canvass/company`** (new method on the existing route; bearer + `isCanvassManager`; whitelisted fields only). GET stays public/unchanged.

### Public ID page — `GET /id/<repId>` (Next.js page, public)

- Added to the middleware `PUBLIC` list as `/^\/id\//` (page prefix, same pattern as `/status/`).
- Server component; resolves the rep by uuid via `adminDb` (public page, no session): **only** `active=true` reps render; deactivated/unknown → 404. Exposes ONLY: rep name, photo, tenant name + canvass logo, `canvassId` fields, and a "Verified active — {today}" badge. Never any knock/customer data.
- Content: rep photo + name, company name/logo, license #, insurance carrier + policy + phone (+ "View certificate of insurance" link when `coiUrl`), verified-active badge, company phone CTA.
- **Capture form:** homeowner name + phone (each optional, at least one required to submit) + optional checkbox: *"I confirm {Company} has my permission to access my property, including the roof, for inspection."* Submit → POST `/api/canvass/scan` → thank-you state ("You're covered — {Rep} is verified and insured").
- **Pixel:** when `metaPixelId` set, standard `fbq` snippet; `PageView` on load, `Lead` on successful submit.

### Scan capture — table + endpoints

```
canvass_scan(id, tenant_id → tenant cascade, rep_id → canvass_rep cascade,
             name text NULL, phone text NULL, ack boolean not null default false,
             ack_at timestamptz NULL, user_agent text NULL, created_at)
  RLS tenant_isolation; index (tenant_id, created_at)
```

- **POST `/api/canvass/scan`** — PUBLIC (the homeowner has no auth). Body `{repId, name?, phone?, ack?}`. Validates rep exists + active (resolves tenant from the rep row via adminDb), requires name or phone, hard rate-limit by IP (`canvass` bucket, keyed `scan:<ip>`), inserts with `ackAt = ack ? now : null`. Returns `{ok:true}` only (no data echo).
- **GET `/api/canvass/scans`** — bearer + manager-only: recent scans (50, newest first) with rep names, for the dashboard card.

### Field app (v1.21.0-beta)

- **🪪 "My ID" button** in the header (next to the alerts bell) → modal with a large QR of `{crmBase()}/id/{repId}`, the rep's photo/name, and the approved door script text.
- QR generated client-side with `qrcode-generator` (cdnjs, SRI, lazy-loaded like Chart.js); rendered once then **cached as a data-URL in localStorage** so the QR shows offline/no-signal at the door.
- **Company card (manager):** fields for license/carrier/policy/phone/COI URL/Meta pixel ID → POST `/api/canvass/company`.
- **Manager dashboard:** "ID scans" card listing recent scans (name/phone/rep/ack/time) from `/scans`.

## Feature B — GPS breadcrumbs

### Honest scope (stated to buyers)

Browser PWA = trails record **while the app is open/active** (the existing `watchPosition` stream). Backgrounded phones don't ping — this is "field-session trails," not all-day surveillance. That's also the privacy posture: no tracking outside active canvassing.

### Data + endpoints

```
canvass_ping(id, tenant_id → tenant cascade, rep_id → canvass_rep cascade,
             lat double, lng double, at timestamptz not null, created_at)
  RLS tenant_isolation; index (tenant_id, rep_id, at)
```

- **POST `/api/canvass/pings`** — bearer (rep posts own trail; `repId` from session). Body `{points:[{lat,lng,ts}]}`, max 200/batch; server clamps + inserts. `canvass` bucket rate limit.
- **GET `/api/canvass/pings?date=YYYY-MM-DD`** — bearer + **manager-only**: all reps' points for the tenant-local day (same tz bucketing as `/eod`), grouped `{repId, points:[[lat,lng,ts]...]}`. Reps cannot fetch teammates' trails.
- **Retention:** `canvassPingPrune` Inngest daily cron deletes pings older than 30 days (all tenants, adminDb).

### Field app

- Buffer: on each `watchPosition` update, append `[ts,lat,lng]` when moved ≥25 m from the last buffered point (or ≥60 s elapsed); buffer persisted to localStorage (offline-safe); flushed to POST `/pings` inside the existing 30-sec `syncTick`; cleared on 2xx.
- Recording only when `canSell()` && authed (never in view-only manager mode).
- **Manager trail view:** a 👣 map control (manager only) toggles today's trails — one thin polyline per rep in the rep's avatar color (canvas renderer already handles polylines), tooltip = rep name + point count. Refreshes on toggle, not live-streamed (v1).

## Security / privacy summary

- `/id/<repId>` exposes only identity + company insurance fields — reviewed list, nothing else; uuid is unguessable; deactivated reps 404 immediately (offboarding kills the QR).
- `/api/canvass/scan` is the only public write: strict field whitelist, rep-active check, IP rate limit, no response echo.
- Pings: write = own session only; read = manager only; 30-day retention; app-open-only recording.
- Both new tables carry standard `tenantIsolation()` RLS.

## Non-goals (YAGNI)

- No COI file upload (URL paste only). No Google/other pixels (Meta only). No scan→lead auto-conversion (manager sees the list; conversion later). No live real-time trail streaming (fetch-on-toggle). No native background location. No per-rep custom ID pages/videos (RepCard-style) in v1.

## Rollout

One migration (2 tables) → prod `0080`. Backend deploy; field app v1.21.0-beta. Then verify: `/id/<real rep>` renders + 404s a deactivated rep; scan POST rate-limits; pings write/read scoping; QR renders offline after first view.
