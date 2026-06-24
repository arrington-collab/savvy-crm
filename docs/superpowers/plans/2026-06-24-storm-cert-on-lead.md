# Storm Certificate on Lead Creation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a lead is created in Savvy, automatically check the property for verified storms over 24 months and — if a storm actually hit the address — generate an NWS certificate, store it in R2 as a `cert` document on the customer (carried to the job on conversion), denoting `verified`/`none`/`error` on the lead.

**Architecture:** One new storm-scout endpoint (`POST /api/leads/certify`) collapses geocode → 24-month storm lookup → point-in-polygon → PDF generation behind a single API-key-authed call. Savvy's `stormProof` gateway gains `generateCertificate`, invoked from a durable Inngest workflow on `lead/created`, which stores the PDF in R2 and writes a `cert` document + lead status. `convertLeadToJob` stamps the `jobId` onto that document.

**Tech Stack:** storm-scout: Express 5, Prisma, `sharp`, `jspdf`, `qrcode`. Savvy: Next.js 16, Drizzle/Postgres (RLS), Inngest, Cloudflare R2, Vitest, pnpm/Turborepo.

## Global Constraints

- **Savvy — tenant isolation:** every new table/query is `tenant_id`-scoped; all DB writes go through `withTenant(tenantId, tx => …)`. The cross-tenant-read test suite must stay green.
- **Savvy — durability:** the storm-cert flow is an **Inngest function** with an idempotency key and retries — never a fire-and-forget promise.
- **Savvy — files in R2** via `r2Storage` (`putObject` / `presignDownload`). No secrets in repo; new config goes in `.env.example`.
- **Savvy — every feature ships with tests**; `pnpm typecheck` + `pnpm lint` clean before commit. TypeScript everywhere, double quotes (match existing files), 2-space indent.
- **Savvy — integrate, don't rebuild:** storm logic stays in storm-scout; Savvy makes one call.
- **storm-scout** has **no test framework** — use standalone `node` assertion scripts for pure helpers and `curl`/script smoke tests for endpoints. Single quotes, existing Express patterns. The endpoint is additive (no change to existing routes).
- **storm-scout auth:** reuse the existing `validateApiKey` middleware (DB-managed `bss_live_…` keys), header `x-api-key`. Do NOT invent a parallel env-key scheme.
- **Certificate verify URL format (exact):** `https://stormproofcerts.com/verify/{certId}?lat={lat}&lng={lng}&date={YYYY-MM-DD}`
- **Lookback window:** 24 months (the endpoint passes `months=24`).
- Branches: storm-scout work on `feat/leads-certify-endpoint` (in `~/Sites/bresco-storm-scout`); Savvy work on `feat/storm-cert-on-lead` (already created, in `~/Sites/savvy-crm`). Commit after each task.

---

## File Structure

**storm-scout (`~/Sites/bresco-storm-scout`):**
- Modify: `utils/geo.js` — add `pointInRing(lat, lng, ring)`.
- Modify: `routes/leads.js` — add `POST /certify` handler (file exists from Phase 8 lead-capture).
- Modify: `server.js` — confirm/add `app.use('/api/leads', …)` mount.
- Create: `scripts/test-point-in-ring.js` — node assertion test for the helper.

**savvy-crm (`~/Sites/savvy-crm`):**
- Modify: `packages/core/src/enums.ts` — add `STORM_CERT_STATUS`.
- Modify: `packages/db/src/schema/enums.ts` — add `stormCertStatusEnum`.
- Modify: `packages/db/src/schema/crm.ts` — add 3 columns to `lead`.
- Create: migration via `pnpm db:generate`.
- Modify: `packages/integrations/src/stormproof.ts` — add `generateCertificate` + `StormCertResult`; fix `lookupStorms` URL; update fake.
- Modify: `.env.example` — `STORMPROOF_API_BASE`, `STORMPROOF_API_KEY`.
- Create: `packages/agents/src/functions/storm-cert.ts` — the Inngest function.
- Modify: `packages/agents/src/index.ts` — register `stormCertOnLead`.
- Create: `packages/agents/src/functions/storm-cert.test.ts`.
- Modify: `packages/db/src/lifecycle/appointments.ts` — carry-over in `convertLeadToJob`.
- Modify: `packages/db/src/lifecycle/appointments.test.ts` (or a sibling) — carry-over test.
- Modify: the lead detail page under `apps/web` — storm status badge + download.
- Create: `apps/web/.../storm-cert-actions.ts` — server action for the signed download URL.

---

## Task 1: storm-scout `POST /api/leads/certify` endpoint

**Repo:** `~/Sites/bresco-storm-scout` (branch `feat/leads-certify-endpoint`)

**Files:**
- Modify: `utils/geo.js`
- Create: `scripts/test-point-in-ring.js`
- Modify: `routes/leads.js`
- Modify: `server.js`

**Interfaces:**
- Produces (HTTP): `POST /api/leads/certify` (header `x-api-key: bss_live_…`), body `{address?, lat?, lng?, months?}` → `200 {verified:boolean, certId?, pdfBase64?, verifyUrl?, storm?:{date,eventType,size,windMph}, checkedMonths:number}`.
- Produces (JS): `pointInRing(lat:number, lng:number, ring:[number,number][]):boolean` from `utils/geo.js`.

- [ ] **Step 1: Create the failing helper test**

Create `scripts/test-point-in-ring.js`:

```js
'use strict';
const assert = require('assert');
const { pointInRing } = require('../utils/geo');

const ring = [[39.4, -105.1], [39.6, -105.1], [39.6, -104.9], [39.4, -104.9]];
assert.strictEqual(pointInRing(39.5, -105.0, ring), true,  'center is inside');
assert.strictEqual(pointInRing(41.0, -105.0, ring), false, 'far north is outside');
assert.strictEqual(pointInRing(39.5, -104.0, ring), false, 'far east is outside');
console.log('pointInRing OK');
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node scripts/test-point-in-ring.js`
Expected: throws `TypeError: pointInRing is not a function` (helper not yet exported).

- [ ] **Step 3: Add `pointInRing` to `utils/geo.js`**

Append before `module.exports`, and add `pointInRing` to the exports object:

```js
// Ray-casting point-in-polygon. ring entries are [lat, lng]; treat lng as x, lat as y.
function pointInRing(lat, lng, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const yi = ring[i][0], xi = ring[i][1];
    const yj = ring[j][0], xj = ring[j][1];
    const intersect = (yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}
```

Then ensure the module exports include it, e.g. `module.exports = { ...existing exports, pointInRing };` (merge into the existing `module.exports` — do not drop existing exports like `haversineMiles`).

- [ ] **Step 4: Run it to verify it passes**

Run: `node scripts/test-point-in-ring.js`
Expected: prints `pointInRing OK`, exit 0.

- [ ] **Step 5: Add the `/certify` route handler to `routes/leads.js`**

At the top of `routes/leads.js`, ensure these requires exist (add any missing):

```js
const { validateApiKey } = require('../middleware/apiAuth');
const { geocodeAddress } = require('../services/geocode');
const { fetchVerifiedStormTracks } = require('../services/stormData');
const { generateCertificatePDF } = require('../services/certificate');
const { pointInRing } = require('../utils/geo');
```

Add this handler (before `module.exports = router;`):

```js
// POST /api/leads/certify — one-shot "address → certificate" for CRM integrations.
// API-key auth. Geocodes if needed, finds the most-severe verified storm that
// actually hit the point (point-in-polygon) over `months`, and returns a cert.
router.post('/certify', validateApiKey, async (req, res) => {
  try {
    let { address, lat, lng, months } = req.body || {};
    months = parseInt(months) || 24;

    if ((lat == null || lng == null) && address) {
      const geo = await geocodeAddress(address);
      if (!geo) return res.status(400).json({ error: 'Could not geocode address' });
      lat = geo.lat; lng = geo.lng;
    }
    if (lat == null || lng == null) {
      return res.status(400).json({ error: 'lat+lng or a geocodable address is required' });
    }
    lat = parseFloat(lat); lng = parseFloat(lng);

    const { tracks } = await fetchVerifiedStormTracks(lat, lng, months);
    const all = Array.isArray(tracks) ? tracks : [];

    // Only storms whose damage ring contains the point AND have a real magnitude.
    const hits = all.filter((t) => {
      const hasMag = t.eventType === 'hail' ? (t.size || 0) > 0 : (t.windMph || 0) > 0;
      return hasMag && Array.isArray(t.rings) && t.rings[0] && pointInRing(lat, lng, t.rings[0]);
    });

    if (hits.length === 0) {
      return res.json({ verified: false, checkedMonths: months });
    }

    // Most severe — hail inches vs wind mph on a rough common scale (80mph ~ 2in).
    const sev = (t) => (t.eventType === 'hail' ? (t.size || 0) : (t.windMph || 0) / 40);
    hits.sort((a, b) => sev(b) - sev(a));
    const storm = hits[0];
    const stormDate = (storm.date || '').substring(0, 10);

    // 1-mile (0.5mi radius) zone polygon around the point for the cert map.
    const zonePolygon = [];
    const radiusMiles = 0.5, points = 24;
    for (let i = 0; i < points; i++) {
      const ang = (2 * Math.PI * i) / points;
      const dLat = (radiusMiles / 69.0) * Math.cos(ang);
      const dLng = (radiusMiles / (69.0 * Math.cos((lat * Math.PI) / 180))) * Math.sin(ang);
      zonePolygon.push([lat + dLat, lng + dLng]);
    }

    const { buffer, certId } = await generateCertificatePDF({
      address: address || `${lat.toFixed(5)}, ${lng.toFixed(5)}`,
      location: { lat, lng },
      polygon: zonePolygon,
      parcelSource: 'RADIUS',
      county: storm.county || 'Unknown',
      tracks: all,
      stormDate,
    });

    const verifyUrl = `https://stormproofcerts.com/verify/${certId}?lat=${lat}&lng=${lng}&date=${stormDate}`;
    res.json({
      verified: true,
      certId,
      pdfBase64: buffer.toString('base64'),
      verifyUrl,
      storm: {
        date: stormDate,
        eventType: storm.eventType,
        size: storm.size ?? null,
        windMph: storm.windMph ?? null,
      },
      checkedMonths: months,
    });
  } catch (err) {
    console.error('Lead certify error:', err.message);
    res.status(500).json({ error: 'Certification failed' });
  }
});
```

- [ ] **Step 6: Confirm the route is mounted**

Check `server.js` for the leads mount. If `app.use('/api/leads', ...)` is absent, add it next to the other route mounts:

```js
const leadRoutes = require('./routes/leads');
app.use('/api/leads', leadRoutes);
```

Run: `node -e "require('./routes/leads'); console.log('leads route loads')"`
Expected: prints `leads route loads` (no syntax/require errors). If it fails for a missing dep, symlink deps from a sibling checkout as documented in the repo before retrying.

- [ ] **Step 7: Smoke-test the endpoint (manual)**

Start the app locally (or hit the deployed instance after deploy). With a valid `bss_live_…` key:

```bash
curl -s -X POST "$BASE/api/leads/certify" \
  -H "x-api-key: $KEY" -H "content-type: application/json" \
  -d '{"lat":39.295,"lng":-104.15,"months":24}' | head -c 400
```
Expected: JSON with `"verified":true`, a `certId` starting `BSS-`, a `pdfBase64`, and a `verifyUrl` of the documented form. Try a no-storm point (e.g. mid-ocean `{"lat":25.0,"lng":-45.0}`) → `{"verified":false,"checkedMonths":24}`.

- [ ] **Step 8: Commit**

```bash
git add utils/geo.js routes/leads.js server.js scripts/test-point-in-ring.js
git commit -m "feat(leads): add POST /api/leads/certify (address -> certificate)"
```

---

## Task 2: Savvy — `storm_cert_status` enum + lead columns + migration

**Repo:** `~/Sites/savvy-crm` (branch `feat/storm-cert-on-lead`)

**Files:**
- Modify: `packages/core/src/enums.ts`
- Modify: `packages/db/src/schema/enums.ts`
- Modify: `packages/db/src/schema/crm.ts`
- Create: migration (generated)

**Interfaces:**
- Produces: `STORM_CERT_STATUS` (readonly tuple) from `@savvy/core`; `stormCertStatusEnum` from db schema; `lead.stormCertStatus` / `lead.stormCheckedAt` / `lead.stormCertDocumentId` columns.

- [ ] **Step 1: Add the enum constant in core**

In `packages/core/src/enums.ts`, add alongside the other constants (match the existing `as const` tuple style):

```ts
export const STORM_CERT_STATUS = ["pending", "verified", "none", "error"] as const;
export type StormCertStatus = (typeof STORM_CERT_STATUS)[number];
```

- [ ] **Step 2: Add the pgEnum in the db schema**

In `packages/db/src/schema/enums.ts`, import `STORM_CERT_STATUS` from `@savvy/core` (add to the existing core import list) and add:

```ts
export const stormCertStatusEnum = pgEnum("storm_cert_status", STORM_CERT_STATUS);
```

- [ ] **Step 3: Add columns to the `lead` table**

In `packages/db/src/schema/crm.ts`, import `stormCertStatusEnum` (from `./enums`) and add these columns to the `lead` `pgTable` (alongside `status`, before the constraints array). Use `timestamp` (already imported in the schema; if not, add it to the `drizzle-orm/pg-core` import):

```ts
  stormCertStatus: stormCertStatusEnum("storm_cert_status").notNull().default("pending"),
  stormCheckedAt: timestamp("storm_checked_at", { withTimezone: true }),
  stormCertDocumentId: uuid("storm_cert_document_id"),
```

(Plain `uuid` without a `.references()` — `document` is defined in `ops.ts` and a hard FK would create a circular import; the workflow guarantees the id is valid. This matches how the schema avoids cross-file circular refs.)

- [ ] **Step 4: Generate the migration**

Run: `pnpm db:generate`
Expected: a new migration file appears under `packages/db/` adding the `storm_cert_status` enum type and the three `lead` columns. Inspect it: it should `CREATE TYPE storm_cert_status` and `ALTER TABLE lead ADD COLUMN`.

- [ ] **Step 5: Verify typecheck**

Run: `pnpm typecheck`
Expected: passes (no type errors from the new enum/columns).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/enums.ts packages/db/src/schema/enums.ts packages/db/src/schema/crm.ts packages/db
git commit -m "feat(db): storm_cert_status enum + lead storm-cert columns"
```

---

## Task 3: Savvy — `stormProof.generateCertificate` gateway

**Files:**
- Modify: `packages/integrations/src/stormproof.ts`
- Modify: `.env.example`

**Interfaces:**
- Consumes: storm-scout `POST /api/leads/certify` (Task 1).
- Produces: `StormCertResult` type; `StormProofGateway.generateCertificate(o:{address?,lat?,lng?,months?}):Promise<StormCertResult>`; updated `makeFakeStormProof`.

- [ ] **Step 1: Write the failing gateway test**

Create `packages/integrations/src/stormproof.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { httpStormProof, makeFakeStormProof } from "./stormproof";

afterEach(() => vi.restoreAllMocks());

describe("stormProof.generateCertificate", () => {
  it("POSTs to /api/leads/certify with x-api-key and parses a verified result", async () => {
    process.env.STORMPROOF_API_BASE = "https://sp.test";
    process.env.STORMPROOF_API_KEY = "bss_live_x";
    const payload = { verified: true, certId: "BSS-1", pdfBase64: "AAAA", verifyUrl: "https://stormproofcerts.com/verify/BSS-1?lat=1&lng=2&date=2026-06-08", storm: { date: "2026-06-08", eventType: "hail", size: 2.75, windMph: null }, checkedMonths: 24 };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => payload });
    vi.stubGlobal("fetch", fetchMock);

    const r = await httpStormProof.generateCertificate({ lat: 1, lng: 2, months: 24 });
    expect(r.verified).toBe(true);
    expect(r.certId).toBe("BSS-1");
    const [url, opts] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/api/leads/certify");
    expect(opts.headers["x-api-key"]).toBe("bss_live_x");
    expect(JSON.parse(opts.body)).toMatchObject({ lat: 1, lng: 2, months: 24 });
  });

  it("throws on a non-ok response (so the workflow retries)", async () => {
    process.env.STORMPROOF_API_BASE = "https://sp.test";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) }));
    await expect(httpStormProof.generateCertificate({ lat: 1, lng: 2 })).rejects.toThrow();
  });

  it("fake returns a deterministic verified result", async () => {
    const fake = makeFakeStormProof();
    const r = await fake.generateCertificate({ lat: 1, lng: 2 });
    expect(r.verified).toBe(true);
    expect(r.pdfBase64).toBeTruthy();
    expect(r.checkedMonths).toBe(24);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @savvy/integrations test stormproof` (or `pnpm vitest run packages/integrations/src/stormproof.test.ts`)
Expected: FAIL — `generateCertificate` does not exist on the gateway.

- [ ] **Step 3: Implement the gateway changes**

In `packages/integrations/src/stormproof.ts`:

Add the result type near the other types:

```ts
export type StormCertResult = {
  verified: boolean;
  certId?: string;
  pdfBase64?: string;
  verifyUrl?: string;
  storm?: { date: string; eventType: "hail" | "wind"; size?: number | null; windMph?: number | null };
  checkedMonths: number;
};
```

Add to the `StormProofGateway` interface:

```ts
  generateCertificate(o: { address?: string; lat?: number; lng?: number; months?: number }): Promise<StormCertResult>;
```

Add to `httpStormProof`:

```ts
  async generateCertificate({ address, lat, lng, months = 24 }) {
    const res = await fetch(`${BASE()}/api/leads/certify`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers() },
      body: JSON.stringify({ address, lat, lng, months }),
    });
    if (!res.ok) throw new Error(`storm-scout certify failed (${res.status})`);
    return (await res.json()) as StormCertResult;
  },
```

Fix the stale `lookupStorms` URL: change `/api/storms/lookup` → `/api/storms/verified` and, since that endpoint takes `lat`/`lng` (not `location`), keep the lat/lng branch and drop the `location` param (if only an address is available with no coords, return `EMPTY_STORMS`). Leave `lookupStorms`'s try/catch swallow (scoring is non-critical) — only `generateCertificate` throws.

Add to `makeFakeStormProof`'s returned object:

```ts
    async generateCertificate({ lat, lng }) {
      calls.push({ op: "generateCertificate" });
      return {
        verified: true,
        certId: "BSS-FAKE1",
        pdfBase64: "JVBERi0xLjQK", // "%PDF-1.4" — minimal stub bytes
        verifyUrl: `https://stormproofcerts.com/verify/BSS-FAKE1?lat=${lat ?? 0}&lng=${lng ?? 0}&date=2026-06-08`,
        storm: { date: "2026-06-08", eventType: "hail", size: 1.5, windMph: null },
        checkedMonths: 24,
      };
    },
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run packages/integrations/src/stormproof.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Add env keys**

In `.env.example`, add (no real values):

```
# StormProof (storm-scout) integration
STORMPROOF_API_BASE=
STORMPROOF_API_KEY=
```

- [ ] **Step 6: Commit**

```bash
git add packages/integrations/src/stormproof.ts packages/integrations/src/stormproof.test.ts .env.example
git commit -m "feat(integrations): stormProof.generateCertificate + fix lookupStorms URL"
```

---

## Task 4: Savvy — `stormCertOnLead` Inngest workflow

**Files:**
- Create: `packages/agents/src/functions/storm-cert.ts`
- Modify: `packages/agents/src/index.ts`
- Create: `packages/agents/src/functions/storm-cert.test.ts`

**Interfaces:**
- Consumes: `stormProof.generateCertificate` (Task 3); `r2Storage` (`putObject`); `lead`/`customer`/`property`/`document` + `withTenant`/`eq` from `@savvy/db`; the `lead/created` event `{leadId, tenantId}`.
- Produces: `stormCertOnLead` Inngest function (registered in `functions`).

- [ ] **Step 1: Write the failing workflow test**

Create `packages/agents/src/functions/storm-cert.test.ts`. It tests the extracted core (`runStormCert`) with injected fakes (no Inngest runtime):

```ts
import { describe, it, expect } from "vitest";
import { makeFakeStormProof, makeFakeStorage } from "@savvy/integrations";
import { runStormCert } from "./storm-cert";

// Minimal fake "ctx loader" + recorder so the core logic is testable without a DB.
function fakeDeps(over: Partial<Parameters<typeof runStormCert>[0]> = {}) {
  const updates: any[] = [];
  const docs: any[] = [];
  return {
    leadId: "lead1",
    tenantId: "t1",
    loadLead: async () => ({ customerId: "cust1", address: "1 Main St", lat: 39.3, lng: -104.2, existingDocId: null as string | null }),
    gateway: makeFakeStormProof(),
    storage: makeFakeStorage(),
    createCertDocument: async (d: any) => { docs.push(d); return "doc1"; },
    updateLead: async (u: any) => { updates.push(u); },
    _updates: updates, _docs: docs,
    ...over,
  };
}

describe("runStormCert", () => {
  it("verified: stores PDF + creates cert doc + marks lead verified", async () => {
    const d = fakeDeps();
    const out = await runStormCert(d as any);
    expect(out.status).toBe("verified");
    expect(d._docs[0]).toMatchObject({ kind: "cert", customerId: "cust1" });
    expect(d.storage.calls.some((c) => c.op === "put" || c.op === "upload")).toBe(true);
    expect(d._updates.at(-1)).toMatchObject({ stormCertStatus: "verified" });
  });

  it("none: no address and no coords → marks none, never calls gateway", async () => {
    const fake = makeFakeStormProof();
    const d = fakeDeps({ loadLead: async () => ({ customerId: "c", address: null, lat: null, lng: null, existingDocId: null }), gateway: fake });
    const out = await runStormCert(d as any);
    expect(out.status).toBe("none");
    expect(fake.calls.length).toBe(0);
    expect(d._updates.at(-1)).toMatchObject({ stormCertStatus: "none" });
  });

  it("none: gateway says not verified → marks none", async () => {
    const d = fakeDeps({ gateway: { generateCertificate: async () => ({ verified: false, checkedMonths: 24 }) } as any });
    const out = await runStormCert(d as any);
    expect(out.status).toBe("none");
  });

  it("idempotent: existing cert doc id → does not create a second doc", async () => {
    const d = fakeDeps({ loadLead: async () => ({ customerId: "c", address: "x", lat: 1, lng: 2, existingDocId: "docPrev" }) });
    const out = await runStormCert(d as any);
    expect(out.status).toBe("verified");
    expect(d._docs.length).toBe(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run packages/agents/src/functions/storm-cert.test.ts`
Expected: FAIL — `runStormCert` does not exist.

- [ ] **Step 3: Implement the workflow + its testable core**

Create `packages/agents/src/functions/storm-cert.ts`:

```ts
import { withTenant, lead, customer, property, document, eq } from "@savvy/db";
import { stormProof as defaultStormProof, r2Storage, type StormProofGateway, type StorageGateway } from "@savvy/integrations";
import { inngest } from "../client";

type LoadResult = { customerId: string | null; address: string | null; lat: number | null; lng: number | null; existingDocId: string | null } | null;

export interface StormCertDeps {
  leadId: string;
  tenantId: string;
  loadLead: () => Promise<LoadResult>;
  gateway: Pick<StormProofGateway, "generateCertificate">;
  storage: Pick<StorageGateway, "putObject">;
  createCertDocument: (d: { tenantId: string; customerId: string | null; r2Key: string; filename: string; externalUrl: string | null }) => Promise<string>;
  updateLead: (u: { stormCertStatus: "verified" | "none"; stormCheckedAt: Date; stormCertDocumentId?: string }) => Promise<void>;
}

// Pure-ish core: no Inngest, no direct DB — all I/O injected. Fully unit-testable.
export async function runStormCert(d: StormCertDeps): Promise<{ status: "verified" | "none"; certId?: string; documentId?: string }> {
  const ctx = await d.loadLead();
  if (!ctx) return { status: "none" };

  if (!ctx.address && (ctx.lat == null || ctx.lng == null)) {
    await d.updateLead({ stormCertStatus: "none", stormCheckedAt: new Date() });
    return { status: "none" };
  }

  const result = await d.gateway.generateCertificate({
    address: ctx.address ?? undefined,
    lat: ctx.lat ?? undefined,
    lng: ctx.lng ?? undefined,
    months: 24,
  });

  if (!result.verified || !result.certId || !result.pdfBase64) {
    await d.updateLead({ stormCertStatus: "none", stormCheckedAt: new Date() });
    return { status: "none" };
  }

  if (ctx.existingDocId) {
    // Idempotent replay: cert already recorded.
    return { status: "verified", certId: result.certId, documentId: ctx.existingDocId };
  }

  const r2Key = `tenants/${d.tenantId}/certs/${result.certId}.pdf`;
  const bytes = Uint8Array.from(Buffer.from(result.pdfBase64, "base64"));
  await d.storage.putObject({ key: r2Key, bytes, contentType: "application/pdf" });

  const documentId = await d.createCertDocument({
    tenantId: d.tenantId,
    customerId: ctx.customerId,
    r2Key,
    filename: `storm-cert-${result.certId}.pdf`,
    externalUrl: result.verifyUrl ?? null,
  });

  await d.updateLead({ stormCertStatus: "verified", stormCheckedAt: new Date(), stormCertDocumentId: documentId });
  return { status: "verified", certId: result.certId, documentId };
}

export const stormCertOnLead = inngest.createFunction(
  { id: "storm-cert-on-lead", concurrency: { limit: 5 }, idempotency: "event.data.leadId" },
  { event: "lead/created" },
  async ({ event, step }) => {
    const { leadId, tenantId } = event.data;

    const out = await step.run("storm-cert", () =>
      runStormCert({
        leadId,
        tenantId,
        gateway: defaultStormProof,
        storage: r2Storage,
        loadLead: () =>
          withTenant(tenantId, async (tx) => {
            const [l] = await tx.select().from(lead).where(eq(lead.id, leadId));
            if (!l) return null;
            let address: string | null = null, lat: number | null = null, lng: number | null = null;
            if (l.propertyId) {
              const [p] = await tx.select().from(property).where(eq(property.id, l.propertyId));
              if (p) { address = p.address; lat = p.lat ?? null; lng = p.lng ?? null; }
            }
            return { customerId: l.customerId, address, lat, lng, existingDocId: l.stormCertDocumentId ?? null };
          }),
        createCertDocument: (dd) =>
          withTenant(tenantId, async (tx) => {
            const [doc] = await tx.insert(document).values({
              tenantId: dd.tenantId, customerId: dd.customerId, kind: "cert",
              r2Key: dd.r2Key, filename: dd.filename, externalUrl: dd.externalUrl,
            }).returning();
            return doc!.id;
          }),
        updateLead: (u) =>
          withTenant(tenantId, async (tx) => {
            await tx.update(lead).set(u).where(eq(lead.id, leadId));
          }),
      }),
    );

    return out;
  },
);

// Final-failure handler: after Inngest exhausts retries, denote the lead errored.
export const stormCertOnLeadFailure = inngest.createFunction(
  { id: "storm-cert-on-lead-failure" },
  { event: "inngest/function.failed" },
  async ({ event, step }) => {
    const failed = (event.data as { function_id?: string }).function_id;
    if (failed !== "storm-cert-on-lead") return { ignored: true };
    const orig = (event.data as { event?: { data?: { leadId?: string; tenantId?: string } } }).event?.data;
    if (!orig?.leadId || !orig?.tenantId) return { ignored: true };
    await step.run("mark-error", () =>
      withTenant(orig.tenantId!, async (tx) => {
        await tx.update(lead).set({ stormCertStatus: "error", stormCheckedAt: new Date() }).where(eq(lead.id, orig.leadId!));
      }),
    );
    return { status: "error" };
  },
);
```

(If `makeFakeStorage`'s call op is `"upload"`/`"put"` differs from the test's `some(...)` check, align the test assertion to the actual op label observed in Step 4.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run packages/agents/src/functions/storm-cert.test.ts`
Expected: PASS (4 tests). If the storage-op assertion mismatches, adjust the test's `some(c => c.op === …)` to the real label and re-run.

- [ ] **Step 5: Register the functions**

In `packages/agents/src/index.ts`: add imports and exports for `stormCertOnLead` and `stormCertOnLeadFailure`, and append both to the `functions` array.

```ts
import { stormCertOnLead, stormCertOnLeadFailure } from "./functions/storm-cert";
export { stormCertOnLead, stormCertOnLeadFailure } from "./functions/storm-cert";
// ...add to the array:
export const functions = [/* …existing…, */ stormCertOnLead, stormCertOnLeadFailure];
```

- [ ] **Step 6: Typecheck + commit**

Run: `pnpm typecheck` → passes.

```bash
git add packages/agents/src/functions/storm-cert.ts packages/agents/src/functions/storm-cert.test.ts packages/agents/src/index.ts
git commit -m "feat(agents): storm-cert-on-lead Inngest workflow (+ failure handler)"
```

---

## Task 5: Savvy — carry the cert onto the job at conversion

**Files:**
- Modify: `packages/db/src/lifecycle/appointments.ts`
- Create/Modify: `packages/db/src/lifecycle/storm-cert-carryover.test.ts`

**Interfaces:**
- Consumes: `document` table, `and`/`isNull`/`eq` from `@savvy/db` internals, the existing `convertLeadToJob`.

- [ ] **Step 1: Write the failing carry-over test**

Create `packages/db/src/lifecycle/storm-cert-carryover.test.ts` following the existing lifecycle test pattern (see `change-order.test.ts` for seeding tenant/customer/property/lead). The test: seed a tenant + customer + property + a `lead` (status not booked) + a `document` (`kind:'cert'`, `customerId`, `jobId:null`); call `convertLeadToJob`; assert the document now has `jobId === <new job id>`; call again (idempotent) and assert no error and still one cert doc with that jobId.

```ts
import { describe, it, expect } from "vitest";
import { adminDb } from "../test-helpers"; // use the same helper the other lifecycle tests use
import { tenant, customer, property, lead, document, job } from "../schema";
import { convertLeadToJob } from "./appointments";
import { eq, and } from "drizzle-orm";

describe("convertLeadToJob carry-over", () => {
  it("stamps jobId onto the customer's cert document", async () => {
    // —— seed (mirror change-order.test.ts seeding) ——
    const [t] = await adminDb.insert(tenant).values({ name: "T" }).returning();
    const [c] = await adminDb.insert(customer).values({ tenantId: t!.id, name: "Cust" }).returning();
    const [p] = await adminDb.insert(property).values({ tenantId: t!.id, customerId: c!.id, address: "1 Main" }).returning();
    const [l] = await adminDb.insert(lead).values({ tenantId: t!.id, customerId: c!.id, propertyId: p!.id }).returning();
    const [doc] = await adminDb.insert(document).values({ tenantId: t!.id, customerId: c!.id, kind: "cert", r2Key: "k", filename: "f.pdf" }).returning();

    const { jobId } = await convertLeadToJob({ tenantId: t!.id, leadId: l!.id });

    const [after] = await adminDb.select().from(document).where(eq(document.id, doc!.id));
    expect(after!.jobId).toBe(jobId);

    // idempotent re-run
    await convertLeadToJob({ tenantId: t!.id, leadId: l!.id });
    const stillOne = await adminDb.select().from(document).where(and(eq(document.customerId, c!.id), eq(document.kind, "cert")));
    expect(stillOne.length).toBe(1);
    expect(stillOne[0]!.jobId).toBe(jobId);
  });
});
```

(Use the exact admin-db/seed helpers the sibling lifecycle tests import — match `change-order.test.ts`.)

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run packages/db/src/lifecycle/storm-cert-carryover.test.ts`
Expected: FAIL — `after.jobId` is `null` (carry-over not implemented).

- [ ] **Step 3: Implement the carry-over in `convertLeadToJob`**

In `packages/db/src/lifecycle/appointments.ts`: ensure `document`, `and`, `isNull` are imported (add to the existing imports). Inside `convertLeadToJob`, in the same `withTenant` tx, **after** `seedJobTasks`/`recordStageChange` and **before** `return`, add:

```ts
    // Carry any storm certificate (attached to the customer at lead time) onto the job.
    await tx.update(document)
      .set({ jobId: newJob!.id })
      .where(and(eq(document.customerId, l.customerId!), eq(document.kind, "cert"), isNull(document.jobId)));
```

Also handle the early-return path (when the lead is already `booked` and an existing job is found): stamp there too, so a re-run still associates a later-arriving cert. Simplest: extract a tiny local `const stampCerts = (jobId: string) => tx.update(document).set({ jobId }).where(and(eq(document.customerId, l.customerId!), eq(document.kind, "cert"), isNull(document.jobId)));` and call it in both branches.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run packages/db/src/lifecycle/storm-cert-carryover.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/lifecycle/appointments.ts packages/db/src/lifecycle/storm-cert-carryover.test.ts
git commit -m "feat(db): carry storm cert document onto job at lead conversion"
```

---

## Task 6: Savvy — lead-detail storm-cert denotation + download

**Files:**
- Create: a server action file co-located with the lead detail page, e.g. `apps/web/app/(app)/leads/[id]/storm-cert-actions.ts` (adjust to the real route group).
- Modify: the lead detail page/component that renders a single lead.

**Interfaces:**
- Consumes: `lead.stormCertStatus` / `stormCheckedAt` / `stormCertDocumentId`; `document.r2Key`; `r2Storage.presignDownload`.

- [ ] **Step 1: Locate the lead detail page**

Run: `find apps/web -path "*leads*" -name "*.tsx" | head` and identify the single-lead view (the page that shows one lead's fields). Note its path + how it loads the `lead` row (it already queries the lead; you'll read the new columns from it).

- [ ] **Step 2: Add the signed-download server action**

Create the action file next to that page:

```ts
"use server";
import { withTenant, document, eq } from "@savvy/db";
import { r2Storage } from "@savvy/integrations";
import { getTenantId } from "@/lib/tenant"; // use the app's existing tenant resolver

export async function getStormCertDownloadUrl(documentId: string): Promise<string | null> {
  const tenantId = await getTenantId();
  return withTenant(tenantId, async (tx) => {
    const [doc] = await tx.select().from(document).where(eq(document.id, documentId));
    if (!doc?.r2Key) return null;
    const { url } = await r2Storage.presignDownload({ key: doc.r2Key });
    return url;
  });
}
```

(Use the app's actual tenant-resolution helper — match how other server actions in `apps/web` obtain `tenantId` from Clerk.)

- [ ] **Step 3: Render the denotation on the lead page**

In the lead detail view, add a block driven by `lead.stormCertStatus`:

```tsx
{lead.stormCertStatus === "verified" && (
  <div className="rounded-md border p-3">
    <span className="inline-flex items-center gap-1 text-sm font-medium text-green-700">✓ Storm certified</span>
    <p className="text-xs text-muted-foreground">Verified storm at this address.</p>
    {lead.stormCertDocumentId && (
      <form action={async () => { "use server"; }}>
        {/* client button calls getStormCertDownloadUrl(lead.stormCertDocumentId) then window.open(url) */}
      </form>
    )}
  </div>
)}
{lead.stormCertStatus === "none" && (
  <p className="text-sm text-muted-foreground">No verified storm in the last 24 months
    {lead.stormCheckedAt ? ` (checked ${new Date(lead.stormCheckedAt).toLocaleDateString()})` : ""}.</p>
)}
{lead.stormCertStatus === "pending" && (
  <p className="text-sm text-muted-foreground">Checking storm history…</p>
)}
{lead.stormCertStatus === "error" && (
  <p className="text-sm text-amber-700">Storm check failed — will retry.</p>
)}
```

For the download, add a small client component that, on click, calls the `getStormCertDownloadUrl` server action and opens the returned URL in a new tab (match the app's existing pattern for signed-URL downloads — e.g. how job documents are downloaded). Keep colors token-based so dark mode is unaffected.

- [ ] **Step 4: Verify build + typecheck**

Run: `pnpm typecheck` and `pnpm --filter web build` (or `pnpm build`)
Expected: clean; the lead page compiles with the new fields and action.

- [ ] **Step 5: Commit**

```bash
git add apps/web
git commit -m "feat(web): show storm-cert status + download on the lead detail page"
```

---

## Self-Review Notes

- **Spec coverage:** endpoint (T1), 24-month + point-in-polygon + most-severe (T1), gateway+fix stub+env (T3), enum+lead columns (T2), Inngest workflow verified/none/error + idempotency (T4), R2 storage + cert document on customer (T4), carry-over to job (T5), lead denotation UI (T6). All spec sections mapped. ✓
- **Auth refinement:** the spec floated a bare `LEADS_API_KEY` env; the plan instead reuses storm-scout's existing `validateApiKey` (`bss_live_…`, DB-managed) — a justified improvement that matches the repo's established pattern. Savvy stores that key in `STORMPROOF_API_KEY`.
- **Geocode question resolved:** storm-scout has `services/geocode.js#geocodeAddress`, so the address fallback is real; lat/lng remains the primary path from `property`.
- **Type consistency:** `StormCertResult` shape is identical across gateway (T3), fake (T3), and workflow consumption (T4); `runStormCert` deps match between impl and test; `document` cols (`kind`,`customerId`,`r2Key`,`filename`,`externalUrl`,`jobId`) match the schema read in Task discovery.
- **Placeholders:** code is complete for T1–T5; T6 has two necessary discovery steps (locate the lead page; match the app's tenant resolver + download pattern) rather than logic placeholders — unavoidable without the apps/web route map, and called out explicitly.
- **Cross-repo ordering:** T1 ships independently; Savvy T2–T6 are testable via `makeFakeStormProof`/`makeFakeStorage` without the live endpoint. End-to-end against the real endpoint happens after both are deployed.
