# Stage 4 — Drive-time-aware assignment + `getRecommendedSlots` (design)

**Date:** 2026-06-24
**Branch:** `feat/stage4-drivetime-scheduling` (worktree `~/Sites/savvy-stage4`, off `origin/main` @ `9ce05a5`)
**Pipeline context:** This is **Phase A** of the larger Lead Intake Pipeline (capture → enrich → score → **assign + schedule** → instant-contact → voice → track). Stage 4 is built first because every downstream stage consumes its `getRecommendedSlots(leadId)` output. Phases B–D (dedupe/lane/scoring rework, instant-contact + 3-min clock, AI voice agent) follow in later spec → plan → execute cycles.

---

## Goal

Make lead assignment and inspection scheduling **drive-time aware**:

1. Assign a new lead to the rep who can physically reach the property **soonest**, not just by zip/territory.
2. Expose **`getRecommendedSlots(leadId)`** returning the top 2–3 inspection slots ranked by *soonest-feasible + least added drive time + same-day clustering* — a single function reused by Phase C messaging, Phase D voice agent, and the rep UI.

Everything here is **deterministic** (drive-time math, slot ranking, assignment). No LLM is on this path. The drive-time provider **fails open to straight-line distance**, so a missing/broken Distance Matrix key degrades quality but never blocks assignment or scheduling.

---

## What already exists (enhance, don't replace)

| Capability | Location | Reuse |
|---|---|---|
| Slot computation w/ haversine clustering | `packages/core/src/scheduling.ts` → `computeOpenSlots(config, type, existingAppts, fromDate, now, clusterAround?)` returns `Slot[] {startsAt,endsAt,score}` | **Extend** — add a drive-time term to the score |
| Scheduling config (hours, granularity, horizon, types, reminders) | `tenant.settings.scheduling` jsonb; `parseSchedulingConfig` / `saveSchedulingConfig` in `apps/web/src/lib/settings-actions.ts` | **Extend** — add `office`, `driveTime` keys |
| Public token booking slots | `apps/web/src/lib/booking-action.ts` → `getSlotsForToken` | Pattern to mirror for the internal `getRecommendedSlots` |
| 5 assignment strategies (off/round_robin/least_loaded/territory/score) | `packages/core/src/lead-assignment.ts`, `pick-assignee.ts`; `AssignmentConfig` union | **Extend** — add a 6th `"proximity"` strategy (opt-in) |
| Assignment candidates (role, open-lead count, lastAssignedAt) | `packages/db/src/lifecycle/assignment.ts` → `getAssignmentCandidates`, `getAssignmentSettings`, `saveAssignmentConfig` | **Extend** — candidate rows gain an origin location |
| Assignment applied in workflow | `packages/agents/src/functions/lead-intake.ts` `assign-lead` step (~L89–111, 222) | **Extend** — pass property dest + resolve origins |
| External-gateway pattern (env-or-fake singleton, fail-open) | `packages/integrations/src/stormproof.ts` (`stormProof`, `httpStormProof`, `makeFakeStormProof`) | **Mirror** for the new distance gateway |
| GCal sync on `appointment/booked`/`changed` | `packages/agents/src/functions/appointment-calendar.ts` | Untouched — "re-optimize on calendar change" is free because slots are computed live per call |

---

## Components

### 1. Drive-time gateway — `packages/integrations/src/distance.ts` (new)

Mirrors the StormProof gateway shape exactly (env-or-fake singleton, graceful failure).

```ts
export type LatLng = { lat: number; lng: number };

export interface DistanceGateway {
  // Returns drive-time MINUTES for each origin→dest pairing, row-major [origins][dests].
  // Any unresolvable pair is null. Whole call returns null on transport/quota error (fail-open).
  driveMinutesMatrix(origins: LatLng[], dests: LatLng[]): Promise<(number | null)[][] | null>;
}
```

- `httpDistance`: Google **Distance Matrix** API. One batched request per assignment/scheduling decision (origins = candidate reps' resolved origins; dests = the lead's property — usually 1 dest). Reads `GOOGLE_MAPS_SERVER_KEY` (see Config dependency below).
- `makeFakeDistance()`: deterministic — drive-minutes = `round(haversineKm * 1.3 / 0.66)` (≈ city avg 40 km/h with a 1.3 road-factor) so tests are stable and ordering matches intuition. Used whenever `GOOGLE_MAPS_SERVER_KEY` is unset (dev/test).
- Singleton `distance` selects http vs fake by env presence — identical to `stormProof`.

**Fail-open contract:** callers treat `null` (whole-matrix or per-pair) as "no drive-time signal" and fall back to the haversine term already in `computeOpenSlots`. A missing key is therefore a *quality* degradation, never an outage.

### 2. Origin resolver — `packages/core/src/rep-origin.ts` (new) + a db lifecycle loader

```ts
// Pure: given a rep's same-day appointments (already loaded) + bases, pick the origin
// to measure drive-time FROM, for a slot starting at `slotStart`.
export function resolveRepOrigin(args: {
  sameDayAppts: { startsAt: Date; lat: number; lng: number }[]; // rep's other appts that day, with location
  slotStart: Date;
  repBase: LatLng | null;     // user.baseLat/baseLng
  tenantOffice: LatLng | null; // settings.scheduling.office
}): LatLng | null;
```

Resolution order (per the approved model):
1. The rep's **last same-day appointment that ends before `slotStart`** (most accurate — they drive from their previous stop).
2. Else **rep home/office base** (`user.baseLat/baseLng`).
3. Else **tenant office** (`settings.scheduling.office`).
4. Else `null` → proximity term is skipped for that rep/slot (load-balance + soonest only).

The db loader joins a rep's same-day appointments to their location via **`appointment.jobId → job.propertyId → property.lat/lng`** (appointments have no direct `propertyId`). Only `status='scheduled'` appointments count.

### 3. `getRecommendedSlots(leadId)` — extend `packages/core/src/scheduling.ts` + server action `apps/web/src/lib/recommended-slots.ts` (new)

- **Core (pure):** a new `rankSlots(slots, { driveMinutesBySlot, weights })` that blends the existing `Slot.score` (soonest + clustering) with a **drive-time term**, deterministically. Returns slots sorted desc.
- **Server action `getRecommendedSlots(leadId, opts?)`:** resolves the lead → assigned rep (or, if unassigned, the would-be assignee) → property (dest) → scheduling config → rep busy intervals → `computeOpenSlots` → resolve origin per candidate slot → one batched `distance.driveMinutesMatrix` call (origins = the resolved origins for the top-N candidate slots, dest = property) → `rankSlots` → return **top 2–3** `RecommendedSlot { startsAt, endsAt, driveMinutes: number | null, score }`.
- Tenant-scoped via the existing `withTenant`/RLS path (same as `getSlotsForToken`). Drive-time is **best-effort**: on `null` matrix, `driveMinutes` is `null` and ranking uses the haversine/soonest score only.

**Ranking formula (config-driven, all weights in `settings.scheduling.driveTime`):**
```
finalScore = wSoon * soonScore        // 1.0 for the earliest feasible slot, decaying with delay
           + wDrive * driveScore       // 1/(1 + driveMinutes/driveHalfMin); skipped (term=neutral) when driveMinutes null
           + wCluster * clusterScore    // existing computeOpenSlots clustering term
```
Defaults: `wSoon=0.5, wDrive=0.3, wCluster=0.2`, `driveHalfMin=20`. Tunable per tenant; documented in the repo doc.

### 4. Proximity assignment strategy — extend `lead-assignment.ts` / `pick-assignee.ts`

- Add `"proximity"` to the `AssignmentConfig` strategy union (config shape gains nothing required; reuses territory/skill filters where present).
- `pickAssignee` proximity branch: among eligible candidates (active, role in owner/admin/rep, territory match if rules exist, **skill match if the lead's lane needs one and any skilled rep exists**), choose **min drive-time from each rep's resolved origin to the property**, tie-broken by **least open leads**, then **least-recently-assigned**. Reps with `null` origin/drive sort *after* reps with a real drive-time (so we prefer a known-reachable rep), but remain eligible.
- The `assign-lead` step in `lead-intake.ts` passes the property dest + loads each candidate's resolved origin (reusing the resolver loader). Idempotent: never reassigns an already-assigned lead (unchanged).

**Skill matching (soft):** a lead carries a **lane** (set in Phase B; until then derived inline from `property.roofType === 'tile' → 'tile'`). If lane is `tile` and ≥1 active rep has `'tile'` in `user.skills`, restrict the candidate pool to skilled reps; otherwise the pool is unrestricted. Skill never blocks assignment.

### 5. Schema — one migration

```sql
ALTER TABLE "user" ADD COLUMN "base_lat" double precision;
ALTER TABLE "user" ADD COLUMN "base_lng" double precision;
ALTER TABLE "user" ADD COLUMN "skills" text[] NOT NULL DEFAULT '{}';
```
- `base_lat/base_lng`: nullable rep home/office origin (set later via profile/onboarding UI — out of scope for this phase; columns + plumbing only).
- `skills`: rep capabilities (e.g. `{tile}`), default empty.
- Tenant office + drive-time weights are **jsonb config** (`settings.scheduling.office`, `settings.scheduling.driveTime`) — **no migration**, follows the established `parseSchedulingConfig` pattern with zod defaults.

> Migration hygiene (repo gotcha): commit the generated `.sql` **and** its drizzle meta (`_journal.json` entry + `NNNN_snapshot.json`) together, or CI/fresh-DB silently skips the migration.

---

## Data flow

```
lead/created (Inngest)
  └─ assign-lead step
       ├─ load lead + property (dest lat/lng)
       ├─ getAssignmentSettings(tenant) → strategy
       ├─ if strategy="proximity":
       │     getAssignmentCandidates + resolve each rep's origin (last appt→base→office)
       │     distance.driveMinutesMatrix(origins, [propertyDest])  ──fail-open→ haversine
       │     pickAssignee(proximity): min drive-time, tie→least-loaded
       └─ set lead.assignedUserId  (unchanged downstream)

getRecommendedSlots(leadId)   [called by Phase C msg, Phase D voice, rep UI]
  → lead → assignee → property(dest) → scheduling config → busy intervals
  → computeOpenSlots → per-slot origin resolve → driveMinutesMatrix (batched)
  → rankSlots → top 2–3 {startsAt, endsAt, driveMinutes, score}
```

---

## Error handling

- **Distance Matrix unavailable / no key / quota:** gateway returns `null`; assignment and ranking fall back to haversine + load-balance. Logged once (not per-pair). No retry storm — one batched call per decision.
- **No rep origin resolvable** (no appts, no base, no office): proximity term skipped for that rep/slot; assignment still proceeds on load-balance/soonest.
- **Property has no lat/lng** (old/partial lead): proximity is impossible → assignment falls back to the tenant's configured non-proximity behavior (least_loaded default); `getRecommendedSlots` returns soonest slots with `driveMinutes: null`.
- **Inngest:** assignment stays inside the existing `assign-lead` `step.run` (idempotent, retried by the platform). The added Distance call is inside the same step.

---

## Config dependency (Brett's hands — non-blocking)

Google **Distance Matrix is a server-side call** and **cannot use** the existing `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` (that key is HTTP-referrer-restricted for the browser; a server request has no `Referer` and would be rejected, and the key must not be exposed server-side anyway). Phase A introduces **`GOOGLE_MAPS_SERVER_KEY`** — an unrestricted-or-IP-restricted key with **Distance Matrix API enabled**. Until it's set in Vercel + `.env`, the gateway uses the deterministic fake locally and **fails open to haversine in prod** (proximity ranking degrades to straight-line; nothing breaks). This mirrors the R2/Storm-cert rollout: code ships behind a fail-open guard; the key is flipped on separately.

---

## Testing

Pure unit (reliable locally; DB-backed paths gated by CI):
- **distance fake**: matrix shape, monotonic with haversine, `null` propagation.
- **resolveRepOrigin**: last-appt-before-slot chosen; falls through appt→base→office→null; appt starting *after* the slot is ignored.
- **rankSlots**: soonest wins when drive equal; nearer wins when soonest equal; `driveMinutes=null` slots ranked on soon+cluster only; weight changes reorder as expected (boundary cases).
- **pickAssignee proximity**: min-drive wins; tie → least-loaded → least-recent; `null`-origin reps sort after real-drive reps; skill filter restricts pool only when a skilled rep exists.
- **getRecommendedSlots**: returns ≤3 slots, each with `driveMinutes`; fail-open path (matrix `null`) still returns ranked slots.
- **schema/migration**: typecheck on the new `user` columns; assignment + scheduling type chains compile.

---

## Out of scope (this phase)

- Rep base-location / skills **editing UI** (columns + plumbing only; set via DB/seed for now).
- Lane modeling on the lead (Phase B) — Stage 4 derives `tile` inline from `property.roofType`.
- SLA windows / 3-minute speed-to-lead clock / cadence / quiet-hours enforcement (Phase C).
- AI voice agent (Phase D).
- Persistent drive-time caching (one batched live call per decision is sufficient at current volume; revisit if quota pressures appear).
- Changing the public token booking flow (`getSlotsForToken` stays haversine-only for now; it can adopt `rankSlots` later).

---

## Self-review

- **Placeholders:** none — every component names its file, signature, and reuse target.
- **Consistency:** the fail-open contract is stated once and applied uniformly (gateway → assignment → ranking). `getRecommendedSlots` return type (`driveMinutes: number | null`) matches the ranking's `null` handling.
- **Scope:** single implementation plan's worth — one gateway, one resolver, one ranking fn, one new strategy, one migration, one server action. Heavier items (UI, lanes, SLA, voice) explicitly deferred.
- **Ambiguity:** origin order, tie-breaks, weight defaults, and the server-key dependency are all pinned to concrete values.
