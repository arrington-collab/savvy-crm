# Background Ops — continuous data enrichment engine (Slice A)

**Date:** 2026-06-30
**Status:** Approved

## Principle
Agents should *constantly* improve info. Today Savvy enriches a lead **once**, at
`lead/created`, and most of it is gated on `property.lat/lng` which nothing ever
computes — so an address-only lead gets almost no enrichment, and nothing is ever
revisited. This slice adds a **background loop** that fills gaps over time, plus a
**human-escalation** path for the one field worth pressuring people for: roof type.

Live prod gap at design time: customers 0/10 with email, properties 7/11 with no lat/lng.

## Slice A is two halves (two PRs, one design)

### A-auto — the engine + automated enrichers (backend, fully unit-tested)

**1. Enricher interface + registry** (`packages/agents/src/enrichment/`)
```
interface Enricher {
  key: string;                                   // "geocode" | "property-stormproof"
  findDue(tenantId, limit): Promise<EntityRef[]>;// gap present + not recently attempted
  run(tenantId, ref): Promise<EnrichOutcome>;    // "filled" | "no_data" | "error"
}
```
Registry is an **ordered** array; the sweep runs each enricher to completion before
the next, so a property geocoded in step 1 is eligible for StormProof in step 2 **the
same night**.

**2. `enrichment_attempt` ledger** (new RLS table, migration `0037`)
Columns: `id, tenant_id, entity_type, entity_id, enricher_key, status, attempts,
last_attempt_at, detail, created_at, updated_at`. Unique `(tenant_id, entity_type,
entity_id, enricher_key)`. RLS via `tenantIsolation()`.
This is the **convergence + anti-hammer** mechanism: `findDue` selects rows where the
field is still null AND (no ledger row OR `attempts < MAX_ATTEMPTS` AND
`last_attempt_at < now() - BACKOFF`). Generic (`entity_type`/`entity_id`, like
`audit_log`) so every future enricher reuses one table.

**3. Census geocoder** (`packages/integrations/src/geocode.ts`)
`geocode(address, fetchImpl?) → { lat, lng } | null`. US Census one-line endpoint
(`geocoding.geo.census.gov/.../onelineaddress`, `benchmark=Public_AR_Current`), no key,
fail-soft (any error → null). Injectable fetch (tested with a fake, like twilio/vapi).

**4. Geocode enricher** — `findDue`: properties with `address` and null `lat/lng`, not
recently attempted. `run`: geocode → `update(property).set({lat,lng})` → record attempt.

**5. Property-StormProof enricher** — extract the existing `enrichProperty` StormProof
core out of `lead-intake.ts` into a shared `enrichPropertyFromStormProof(tx, {property, sp})`
that fills `year_built/roof_type/county` + `lead.storm_event_id`/features. Both
`lead-intake` and this enricher call it (lead-intake behavior unchanged — its test stays
green). `findDue`: properties with `lat/lng` present and `year_built` null.

**6. Sweep cron** (`packages/agents/src/functions/enrichment-sweep.ts`)
Inngest cron, `TZ=America/Phoenix` daily (mirrors `cold-archive`). For each tenant
(`adminDb`), for each enricher in order: `findDue(limit)` → `run` each (throttled). Each
run records an `agent_run` carrying the property's `leadId`, so enrichment shows in the
command-center feed **with the customer name** (reuses #80).

### A-human — roof type pressure (exception vector + edit UI)

Roof type is high-value ground-truth (needs eyes on the roof) and, paired with the
lat/lng A-auto now fills, yields an **area ↔ roof-type dataset** for future targeting.

**7. `roof_type_needed` exception vector** — computed, **no new table** (Savvy's
Exception Queue is computed at read time; the null field *is* the marker, mirrors
`task_needs_approval`). Add the kind to `packages/core/src/exception-queue.ts`
(`ExceptionKind` union + `KINDS` + builder loop), a gather query in
`apps/web/src/lib/exception-queries.ts` (`property.roof_type IS NULL` joined to an
active lead/job **with an inspection scheduled or completed** — highest signal, avoids
nagging brand-new leads), and a `KIND_LABEL` entry in `exceptions/page.tsx`.

**8. Roof-type edit surface** — there is no way to set roof type after lead creation
today. Add a `<select>` (reuse `ROOF_TYPES` + the `roofType` Zod enum:
`asphalt_shingle/tile/metal/flat_foam/other`) on the lead/job detail page, wired to a
new `setPropertyRoofType` server action (validates against the enum). Setting it nulls
the gap → the exception auto-clears (no separate "close" action, per the existing model).

## Testing (TDD)
- `packages/db`: ledger CRUD + RLS isolation; `findDue` due/backoff logic against Postgres.
- `packages/integrations`: `geocode` Census-response parsing with a fake fetch.
- `packages/agents`: geocode + stormproof enrichers with fake gateways; sweep convergence
  (geocode unblocks stormproof same pass); `lead-intake` test stays green after extraction.
- `packages/core`: `roof_type_needed` builder vector.
- e2e (apps/web): roof-type select sets the field and clears the exception.

## Cost / compliance
- A-auto: zero new cost (Census free, StormProof already wired). Coords/roof are factual,
  not marketing PII.
- Email + its consent/source gate is **Slice B**, not here.

## Out of scope (this slice)
- The "roof types by area" analytics query (data foundation lands now; the report is later).
- Email capture/append (Slice B). Roof back-fill from Roofr + Twilio Lookup (Slice C).
- Throttle/snooze column for the roof-type prompt (null field is enough for v1).
