# Storm Certificate on Lead Creation — Design

**Date:** 2026-06-24
**Status:** Approved (design)
**Repos:** `savvy-crm` (consumer, primary) + `bresco-storm-scout` (new endpoint dependency)

## Problem

When a roofing lead comes in, the rep wants to know immediately whether the property has a **verified storm event** (hail/wind, NWS-backed) and, if so, have a **credible certificate** ready to support the claim. Today this would be a fragile multi-step n8n chain (auth → geocode → storm lookup → point-in-polygon → generate PDF → store). That is brittle and unmaintainable.

Savvy already has a `stormProof` integration stub (`packages/integrations/src/stormproof.ts`) but it points at endpoints that don't exist on the real storm-scout API and has **no certificate-generation method**.

## Goal

When a lead is created in Savvy, automatically (in a durable background workflow) check the property for verified storms over the last **24 months** and:
- **If a storm actually hit the address** → generate a certificate, store the PDF, attach it to the customer (carrying over to the job on conversion), and mark the lead **verified**.
- **If no verified storm in 24 months** → mark the lead **none** (explicitly denoted, not silent).
- **If the check fails** → mark **error** (retryable).

The rep sees the outcome on the lead. One durable call; all storm logic stays server-side in storm-scout.

## Approach (A)

Collapse the entire flow into **one storm-scout endpoint**; Savvy makes a single durable call inside an Inngest workflow triggered by `lead/created`.

```
bresco-storm-scout:  POST /api/leads/certify   (API-key auth)
   body {address?, lat?, lng?, months?}  →  {verified, certId?, pdfBase64?, verifyUrl?, storm?, checkedMonths}
   internally: geocode (if needed) → fetchVerifiedStormTracks(24mo) → point-in-polygon
               pick most-severe storm that HIT the address → generateCertificatePDF → return

savvy-crm:  Inngest fn on "lead/created"
   → stormProof.generateCertificate({address,lat,lng,months:24})  (one HTTP call)
   → verified:  upload PDF to R2 → create `document`(kind:'cert', customerId) → lead.stormCertStatus='verified'
   → not:       lead.stormCertStatus='none'
   → error:     lead.stormCertStatus='error' (Inngest retries)
   convertLeadToJob: stamp jobId onto the customer's cert document(s)  ← carry-over
```

This honors Savvy's non-negotiables: durable Inngest workflow (idempotent + retried), tenant-scoped writes under RLS, files in R2, env-configured, tested.

---

## Component 1 — storm-scout endpoint (`bresco-storm-scout`)

### `POST /api/leads/certify`

**Auth:** API key in header `x-api-key`, compared to env `LEADS_API_KEY` (new). Distinct from field PINs. Fails closed (401) when the key is missing/wrong; in production the env var is required.

**Request body:**
```json
{ "address": "123 Main St, Aurora CO", "lat": 39.7, "lng": -104.8, "months": 24 }
```
- **`lat`+`lng` is the primary path** — Savvy's `property` carries `lat`/`lng`, so Savvy passes them whenever present (the normal case). `address` is a fallback: storm-scout geocodes it **only if a server-side geocoder is configured there**; otherwise it returns `400`. (The plan must confirm storm-scout's geocoding capability; if absent, Savvy geocodes the property first or marks the lead `none`.)
- `months` optional, default **24**.

**Behavior:**
1. Resolve `lat`/`lng` (geocode address if needed).
2. `fetchVerifiedStormTracks(lat, lng, months, …)` (same source the cert app uses).
3. **Point-in-polygon**: keep only tracks whose damage ring contains the point AND have a real magnitude (`size` for hail / `windMph` for wind) — the same rule the field app's `stormAtPoint` enforces. Pick the **most severe** (hail inches and wind mph on a common scale).
4. If none → respond `{ verified: false, checkedMonths }`.
5. If one → `generateCertificatePDF({address, location, polygon(1-mi zone), tracks, stormDate, mapImageBase64, …})` (the existing BSS- generator, which already includes the QR + history).

**Response (200):**
```json
{
  "verified": true,
  "certId": "BSS-XXXXXXXX",
  "pdfBase64": "<base64 PDF>",
  "verifyUrl": "https://stormproofcerts.com/verify/BSS-XXXXXXXX?lat=..&lng=..&date=YYYY-MM-DD",
  "storm": { "date": "2026-06-08", "eventType": "hail", "size": 2.75, "windMph": null },
  "checkedMonths": 24
}
```
Or `{ "verified": false, "checkedMonths": 24 }` when no storm hit the address.

**Notes:** This is additive — no change to existing routes. It reuses `fetchVerifiedStormTracks`, the `stormAtPoint`-style filter, and `generateCertificatePDF`. The cert is persisted in storm-scout's `Certificate` table as today (source `'LEAD'`).

---

## Component 2 — Savvy integration

### 2a. Gateway (`packages/integrations/src/stormproof.ts`)

Fix the stub to the real API and add cert generation:

```ts
export interface StormCertResult {
  verified: boolean;
  certId?: string;
  pdfBase64?: string;
  verifyUrl?: string;
  storm?: { date: string; eventType: "hail" | "wind"; size?: number; windMph?: number };
  checkedMonths: number;
}

export interface StormProofGateway {
  // existing
  lookupStorms(o: { lat?: number; lng?: number; address?: string; months?: number }): Promise<StormSummary>;
  // NEW
  generateCertificate(o: { address?: string; lat?: number; lng?: number; months?: number }): Promise<StormCertResult>;
}
```

- `httpStormProof.generateCertificate` → `POST {STORMPROOF_API_BASE}/api/leads/certify` with `x-api-key: STORMPROOF_API_KEY`, body `{address, lat, lng, months}`.
- `makeFakeStormProof.generateCertificate` → returns a deterministic verified result (and a `none` variant the tests can select) so the workflow is testable without the network.
- `lookupStorms` points at the real `/api/storms/verified` (fixing the stub's `/api/storms/lookup`).
- Env: add `STORMPROOF_API_BASE`, `STORMPROOF_API_KEY` to `.env.example`. `stormProof` selects http vs fake on `STORMPROOF_API_BASE` presence (existing pattern).

### 2b. Data model (`packages/db/src/schema`)

- New enum `storm_cert_status`: `pending | verified | none | error` (default `pending`).
- `lead` gains: `stormCertStatus` (enum, default `pending`), `stormCheckedAt` (timestamp, null), `stormCertDocumentId` (uuid FK → `document.id`, null).
- `document.kind` already supports `'cert'` — no schema change there. Cert documents are created with `kind:'cert'`, `customerId` set (from the lead), `r2Key`, `filename`, `externalUrl` = the verify URL.
- Migration via `pnpm db:generate` + `db:migrate`. RLS/`tenantIsolation()` already applies to `lead` and `document`.

### 2c. Inngest workflow (`packages/agents/src/functions/storm-cert.ts`)

Subscribes to **`lead/created`** (`{ leadId, tenantId }`), a sibling to `lead-intake`.

Steps (each an Inngest `step.run`, idempotent, retried):
1. **Load** lead → property (`withTenant`). If no `address` and no `lat/lng` → set `stormCertStatus='none'`, `stormCheckedAt=now`, done (nothing to check).
2. **Certify**: `stormProof.generateCertificate({ address, lat, lng, months: 24 })`.
3. **Branch:**
   - `verified` → `step.run("store-pdf")`: upload `pdfBase64` bytes to R2 via `r2Storage` (key e.g. `tenants/{tenantId}/certs/{certId}.pdf`); `step.run("record")`: create `document` (`kind:'cert'`, `customerId`, `r2Key`, `filename`, `externalUrl=verifyUrl`) and update lead (`stormCertStatus='verified'`, `stormCheckedAt=now`, `stormCertDocumentId=<doc.id>`).
   - not verified → update lead (`stormCertStatus='none'`, `stormCheckedAt=now`).
4. **Idempotency:** Inngest idempotency key = `lead-storm-cert:{leadId}`; the document write also guards on existing `stormCertDocumentId` (no duplicate cert on replay).
5. **Errors:** a thrown gateway/R2 error lets Inngest retry; on final failure set `stormCertStatus='error'` (a terminal `step` in the function's failure handler).

All DB writes go through `withTenant(tenantId, …)` (RLS).

### 2d. Carry-over on conversion (`packages/db/src/lifecycle/appointments.ts`)

Inside `convertLeadToJob`, after the job is created (same tenant tx), stamp the job onto the customer's cert documents:
```ts
await tx.update(document)
  .set({ jobId: newJob.id })
  .where(and(eq(document.customerId, l.customerId), eq(document.kind, "cert"), isNull(document.jobId)));
```
The cert (attached to the customer at lead time) now also belongs to the job. Idempotent (only stamps where `jobId IS NULL`).

### 2e. UI (`apps/web` lead detail)

Minimal, read-only denotation on the lead view:
- `verified` → green badge "Storm certified — {storm.date} ({size}″ hail / {windMph} mph)" + a download link (signed R2 URL via the existing storage gateway) and the verify URL.
- `none` → neutral badge "No verified storm in last 24 months (checked {stormCheckedAt})".
- `pending` → subtle "Checking storm history…".
- `error` → amber "Storm check failed".

No manual trigger button in v1 (auto-on-create only, per decision).

---

## Error Handling

- **No address/coords on the lead** → `none` (can't check), not an error.
- **Geocode failure (storm-scout)** → `400`; Savvy marks `error`, Inngest retries (geocode may be transient).
- **storm-scout 5xx / network** → Inngest retries with backoff; final failure → `error`.
- **R2 upload failure** → retried as its own step; doesn't lose the verified result (re-run resumes).
- **No storm** is a normal `200 {verified:false}`, never an error.

## Testing (Vitest + RLS suite)

- **Gateway**: `generateCertificate` builds the right URL/headers/body; parses verified + not-verified responses (mocked fetch).
- **Workflow** (with `makeFakeStormProof`): verified path creates a `document(kind:'cert')` + sets lead `verified`/`stormCertDocumentId`; none path sets `none`; missing-address path sets `none` without calling the gateway; error path sets `error`.
- **Idempotency**: re-running the workflow for the same lead does not create a second cert document.
- **Carry-over**: `convertLeadToJob` stamps `jobId` on the customer's cert document; idempotent on repeat.
- **Tenant isolation**: cert documents and lead status are tenant-scoped; the cross-tenant-read suite stays green.

## Non-Negotiables Compliance

- Tenant isolation on all new writes (`withTenant`, RLS on `lead`/`document`). ✓
- Async/multi-step = durable Inngest workflow with idempotency + retries. ✓
- Integrate, don't rebuild — storm logic stays in storm-scout. ✓
- Files in R2. ✓ New config in `.env.example`; no secrets committed. ✓
- Ships with tests; typecheck + lint clean. ✓
- AI gateway: not applicable (no model calls). 

## Out of Scope

- Manual "re-generate" button (auto-on-create only for v1).
- Re-checking storms over time / property-level dedup across multiple leads at the same address.
- Multiple certificates per lead (one most-severe cert).
- Changes to the storm-scout cert PDF layout (uses the existing BSS- generator).

## Success Criteria

- Creating a lead with a storm-affected address auto-produces a `kind:'cert'` document on the customer and marks the lead `verified` — visible on the lead — within the workflow's normal completion time.
- A lead with no verified storm in 24 months shows "No verified storm in last 24 months," not a blank/pending state.
- Converting the lead to a job carries the cert document onto the job (`jobId` set).
- A storm-scout/network failure marks the lead `error` and is retried, never crashes lead creation.
- All new tests pass; tenant-isolation suite stays green; typecheck + lint clean.

## Risks & Mitigations

- **storm-scout geocoding may be limited** → prefer passing `lat`/`lng` from the property when present; fall back to address-geocode; if neither resolvable, `none`.
- **API volume** (every lead hits storm-scout) → acceptable for v1; the call is one durable step; can add a property-level cache later if needed.
- **24-month archive coverage** (IEM/NOAA) → supported; the window is a query parameter.
- **Existing gateway stub consumers** → confirm nothing depends on the old `/api/storms/lookup` shape before changing `lookupStorms` (grep shows only the stub + fake).
