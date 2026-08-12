# Canvass "Recently Sold" pin layer — design

**Date:** 2026-08-12
**Status:** approved, ready for planning
**Repos touched:** `savvy-crm` (data, ingest, API) and `savvy-canvass` (map layer)

## Goal

Once a week, drop a map pin on every Maricopa County home sold in the previous
7 days, so canvassing reps can target new homeowners. Each pin auto-removes 90
days after its sale date. The layer only ever adds sold homes — it never reads,
modifies, or deletes a rep's own pins.

First customer is **Pestkee** (pest control, tenant
`019ff825-efc8-7dd4-b1a3-5567ea02a86c`). Recently-sold homes are the strongest
lead signal in pest control: new homeowners buy plans.

## Scope

**In:** the sold-pin layer end to end — table, ingest, weekly schedule, prune,
read API, map rendering, a sold-date + owner-name line on the door dossier,
one-time backfill, README.

**Out (deliberate follow-ons):**
- **Go Backs** — marking a sold home for return when nobody answers. Depends on
  this layer existing; likely small once it does, since `canvass_knock` already
  has `noanswer` and `callback` outcomes.
- **Hiding roofing-specific UI for pest-control tenants.** Canvass is
  roofing-shaped throughout (storm overlay, roof material, insurance-claim
  contract language). Pestkee needs a per-tenant way to hide it. Tracked
  separately; it does not block this work.

## Why savvy-crm and not Cloudflare

The original brief proposed a Cloudflare Worker + D1 behind the Pages deploy.
Inspection ruled that out:

1. **Canvass already has a backend.** Every map pin is a `canvass_knock`
   rendered from `db.knocks`; ~18 canvass endpoints already run in savvy-crm on
   Vercel. A Worker + D1 would be a second backend with its own auth, deploy
   path, and duplicate property model.
2. **A `property` table already exists** carrying address/city/state/zip/lat/
   lng/parcelId/yearBuilt under RLS.
3. **The storm layer is a working precedent** for exactly this shape:
   viewport-scoped server fetch → dedicated `L.layerGroup` → toggle button.
4. **savvy-crm's CLAUDE.md makes Inngest non-negotiable** for anything async or
   multi-step (retries, idempotency keys, `agent_run` audit). A Cloudflare cron
   would sit outside that contract.
5. **The existing `savvy-canvass-demo.pages.dev` project is not accessible**
   from our Cloudflare account, so a Worker plan is blocked on access we do not
   have. savvy-crm deploys are already ours.

## Data model

New table `canvass_sold_listing` in `packages/db/src/schema/canvass.ts`,
tenant-scoped with `tenantIsolation()` RLS, matching every other canvass table.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | `idCol()` — app-generated UUIDv7 |
| `tenantId` | uuid | notNull, FK `tenant.id` |
| `mls` | text | nullable — not every source supplies it |
| `address` | text | notNull |
| `city`, `state`, `zip` | text | nullable |
| `lat`, `lng` | double precision | notNull — from the feed, no geocoding needed |
| `soldDate` | date | notNull — drives expiry |
| `price` | integer | whole dollars, nullable |
| `propertyType` | text | residential only |
| `beds`, `sqft`, `yearBuilt` | integer | nullable |
| `baths` | numeric | nullable — 2.5 baths is real |
| `url` | text | listing link, nullable |
| `source` | text | notNull, default `redfin_recently_sold` |
| `dedupeKey` | text | notNull — see idempotency |
| `expiresAt` | date | notNull — `soldDate + expiryDays` |
| `createdAt` | timestamptz | `createdAt()` |

Indexes:
- `uniqueIndex(tenantId, source, dedupeKey)` — the idempotency guarantee
- `index(tenantId, lat, lng)` — viewport queries
- `index(tenantId, source, expiresAt)` — prune

### Why tenant-scoped, not a shared global table

Sold data is public record and identical for every tenant, so a global table
(like `task_registry`) is defensible. We reject it because:

- `dossier_cache` sets the precedent: it caches public storm data **per tenant**
  with RLS rather than sharing one copy. Consistency with RLS is non-negotiable #1.
- The volume is trivial — ~800 sales/week × 90-day window ≈ **10k rows per
  tenant** steady-state.
- It makes **region per-tenant config**, which the brief requires. Pestkee runs
  Maricopa; a future tenant can run a different county with no code change. A
  global table would force one region on everyone.

### Config

Stored on `tenant.settings.canvassSold`, defaults in `@savvy/core`:

```json
{ "enabled": true, "regionId": 220, "regionType": 5, "expiryDays": 90 }
```

`enabled: false` (or an absent key) skips the tenant entirely, so existing
roofing tenants are unaffected until switched on. Pestkee is seeded with the
defaults above.

## Idempotency

`dedupeKey` is the normalized `MLS#`; when MLS is absent it falls back to
`address + zip`, uppercased with whitespace collapsed and trailing punctuation
stripped (so `123 Main St.` and `123 MAIN ST` collide as intended).

Insert uses `onConflictDoNothing` against
`uniqueIndex(tenantId, source, dedupeKey)`. Overlapping weeks and re-runs insert
only genuinely new homes.

Rep pins live in a different table (`canvass_knock`), so "never touch rep pins"
is guaranteed by the schema rather than by careful code. Every write and delete
in this feature is scoped to `canvass_sold_listing` and filtered on
`source = 'redfin_recently_sold'`.

## Ingest

### `packages/integrations/src/sold-feed.ts`

Source-agnostic, modeled on the existing `assessor-feed.ts`:

- `parseSoldCsv(text)` → normalized rows. Resolves columns **by header name**,
  not position, so column reordering does not silently corrupt output.
- `isResidential(row)` — keeps `Single Family Residential`, `Townhouse`,
  `Condo/Co-op`, `Mobile/Manufactured Home`, `Multi-Family`; drops
  `Vacant Land`.
- `dedupeRows(rows)` — collapses by `dedupeKey` across price-band tiles.
- `priceBands()` → `[0–300k, 300–400k, 400–500k, 500–750k, 750k+]`, contiguous
  with no gaps. Redfin caps a single export near 350 rows while the county sells
  ~700–900/week, so the pull must be tiled and recombined.

Rows missing `lat`, `lng`, `address`, or `soldDate` are skipped and counted —
never silently dropped.

### Data source

Redfin is the chosen source; county records were evaluated and rejected as
lower quality for sales data. The Redfin GIS CSV export already includes
lat/lng, so no geocoding is required.

Because Redfin's endpoint carries bot protection and its terms restrict
automated bulk access, the pull runs from a **real browser session** as a
scheduled task, which then POSTs parsed rows to the ingest endpoint. This is
internal use only. We deliberately do **not** implement a spoofed-header
server-side fetch: that is bot-detection evasion, and it is also the least
reliable option.

Consequence: the weekly **pull** lives in the scheduled browser task, while the
weekly **prune** lives in the Inngest cron. Splitting them is a feature —
expired pins still disappear on schedule during a week when the export fails.

The scheduled task builds its export URL from the tenant's `regionId` and
`regionType` config, iterating the price bands below and concatenating the
results before it POSTs. `sold_within_days=7` matches the weekly cadence; a
missed week is self-healing only up to 7 days, so a skipped run should be
re-run manually with a widened window rather than left to the next cycle.

### `packages/agents/src/functions/sold-import.ts`

Two distinct Inngest functions, so a failed pull cannot stop expiry:

**`soldImport`** — **event-triggered only** (emitted by the ingest endpoint).
It never runs on a schedule, because the pull is browser-driven.

1. Resolve per-tenant `canvassSold` config; exit early when `enabled` is false.
2. Accept the posted rows.
3. Parse → residential filter → dedupe.
4. Upsert with `onConflictDoNothing`.
5. Prune `WHERE source = 'redfin_recently_sold' AND expiresAt < today`.
6. Return `{ scanned, inserted, skipped, pruned }`.

**`soldPrune`** — **cron-triggered only**, Mondays 06:00 America/Phoenix. Runs
step 5 for every enabled tenant and nothing else. Pruning therefore happens on
schedule even in a week when no export arrives.

Both are idempotent: pruning twice is a no-op, and step 4 is conflict-guarded.

`dryRun: true` performs steps 1–3 and *counts* what step 4 and 5 would change
without writing. Reported as `{ wouldInsert, wouldPrune }`.

## API

### `POST /api/canvass/sold/ingest`

Accepts parsed rows from the scheduled browser task. Authenticated by a bearer
**ingest token** held in env (`CANVASS_SOLD_INGEST_TOKEN`), distinct from rep
sessions — this is machine-to-machine, not a logged-in rep. Body carries the
tenant's `publicKey` to resolve the tenant, same model as the other canvass
intake routes. Validates with a zod schema in `@savvy/core`, emits the Inngest
event, returns the counts. Supports `dryRun`.

### `GET /api/canvass/sold?lat&lng`

Mirrors `/api/canvass/storms`: same `verifyCanvassToken` bearer session, same
`canvassCors` helper, same `checkRateLimit`. Viewport-scoped via a bounding box
around the map center so a rep loads their neighborhood, never 10k rows.
Filters `expiresAt >= today` server-side.

## Map layer (savvy-canvass)

Mirrors the storm layer's structure:

```
fetchSold() → GET /canvass/sold?lat&lng → soldLayer → btnSold toggle
```

- **Sold pins are never written to localStorage.** They are fetched per viewport
  and held in memory, exactly like storm data. The entire app DB is one
  localStorage JSON blob near a 5–10 MB ceiling; persisting 10k sold rows could
  evict a rep's unsynced knocks. The accepted trade-off: the sold layer requires
  signal and does not work in a dead zone. Rep-authored data stays offline-first;
  reference data does not.
- **Shape, not just color.** Rep knocks are `circleMarker`s already colored
  across five outcome colors, so color alone would collide with the outcome
  legend and fail colorblind reps. Sold homes render as a house-glyph `divIcon`
  in one reserved color, drawn beneath rep pins so a rep's own work stays on top.
- **Recency shading** — marker opacity scales with age, so a home sold 3 days ago
  reads stronger than one sold 80 days ago. Catching new homeowners early is the
  whole point; this makes "hot" legible without another control.
- **Popup** — address, sold date, price, beds/baths/sqft, link to the listing.
- **Legend + toggle** sit alongside the existing storm controls. Off by default,
  so the map opens unchanged for tenants without the layer enabled.
- **Client-side expiry filter** hides anything past `expiresAt` as a safety net,
  so a failed prune never surfaces stale pins.

## Dossier integration

`/api/canvass/dossier` gains one line when the door matches a sold listing:

> 🏡 Sold 12 days ago — Jane Ruiz

Sold date comes from `canvass_sold_listing`. **Owner name is not in the Redfin
CSV** — it is county assessor data. It is therefore enriched **lazily**: when a
rep opens that specific door, the existing Maricopa assessor lookup (already used
by the storms route for year-built) is called once by address and cached in
`dossier_cache` under `kind: "property"`. This avoids ~800 assessor calls a week
for doors nobody knocks. When the lookup returns nothing, the name is omitted and
only the sold date renders. Price is deliberately not shown here — it is in the
map popup, and the dossier stays terse.

## Failure modes

**A silent parser break looks identical to a slow sales week.** If Redfin
reorders or renames columns, naive parsing yields zero rows,
`onConflictDoNothing` writes nothing, and the workflow reports success while
pins quietly stop appearing. Therefore: a fetch that returns bytes but parses to
**zero valid rows is a hard failure that alerts** — never a success with
`inserted: 0`. A genuinely empty week is distinguishable because parsing
succeeds and rows are present but all duplicates.

- **Feed unreachable** → Inngest retries with backoff; no partial writes.
- **Prune is independent of fetch.** Expiry is a correctness guarantee, not a
  side effect of a successful pull.
- **Rows missing required fields** → skipped and counted in `skipped`.
- **Assessor lookup failure at dossier time** → name omitted, sold date still
  renders. Never blocks the dossier card.

## Testing

Unit:
- `parseSoldCsv` under reordered columns, renamed columns, malformed rows,
  and empty input
- `isResidential` keeps the five residential types and drops `Vacant Land`
- `dedupeKey` normalization — `123 Main St.` equals `123 MAIN ST`; MLS wins
  over address when both present
- `priceBands` are contiguous with no gaps or overlaps
- expiry math across month and year boundaries

Integration:
- running the import **twice produces no duplicates**
- prune deletes only `source = 'redfin_recently_sold'` rows and leaves
  `canvass_knock` untouched
- **cross-tenant RLS**: Bloom cannot read Pestkee's sold rows (non-negotiable #1)
- `dryRun` writes nothing while reporting non-zero `wouldInsert`

Note: run vitest from the package directory, not a parent — running from the
repo parent picks up sibling worktrees against one Postgres and corrupts
fixtures.

## Deliverables

1. `sold-feed.ts` — parse, filter, tile, dedupe
2. `sold-import.ts` Inngest workflow — upsert + prune, with `dryRun`
3. Migration for `canvass_sold_listing`
4. `POST /api/canvass/sold/ingest` and `GET /api/canvass/sold`
5. Map layer in savvy-canvass — styling, legend, toggle, popup, expiry filter
6. Dossier line (sold date + lazily-enriched owner name)
7. Weekly cron wiring (prune) + scheduled browser task (pull)
8. One-time backfill of the current week
9. README — manual trigger, dry-run, changing region or the 90-day window

## Constraints

- MapTiler, DB, and ingest secrets stay in env — never in client code. The
  existing hardcoded MapTiler key is a client-side tile key; domain-restrict it
  separately.
- Existing company-code auth and rep pins are untouched.
- Region and expiry window are config, defaulting to Maricopa `region_id=220`,
  `region_type=5`, 90 days.
- Dry-run reports adds and prunes before any write.
