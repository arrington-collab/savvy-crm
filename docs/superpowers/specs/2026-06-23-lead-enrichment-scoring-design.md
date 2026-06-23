# Address-Aware Lead Capture, Enrichment & Hybrid Scoring — Design

**Date:** 2026-06-23
**Status:** Approved (brainstorming) → ready for implementation plan
**Author:** Claude (with Brett)

## Problem

Today the lead score is a black box. `lead-intake.ts` calls an LLM with only the
customer name + source — it even passes `address: "unknown"` (a leftover stub),
so the property location, roof, and storm exposure never influence the number. A
referral scores ~72 purely because the model knows referrals close well, not
because of anything about the property. The score is also non-deterministic and
unexplainable, so reps can't trust it.

We want lead capture to collect a **structured, validated address**, **enrich** it
with free data we already have access to (county assessor + storm history via the
**StormProof** backend), score leads with an **explainable hybrid engine** (rules +
AI), and turn storm exposure into a **rep-facing install/upsell recommendation**.

## Goals

1. Predictive address entry (Google Places) that splits into **street / city /
   state / zip** (no default state — multi-state ready) and captures `lat/lng` +
   `county`.
2. Optional **roof type** (dropdown) and **year built** (number) on the form;
   rep-entered values always win.
3. **Enrich** blanks, best-effort, async, never blocking lead creation:
   - **Year built** from county assessor (via StormProof `/api/property`).
   - **Roof type** opportunistically from the same assessor response *if present*.
   - **Storm history** (hail/wind) from StormProof `/api/storms/lookup` →
     `lead.stormEventId` + structured storm features.
4. **Hybrid scoring**: a deterministic baseline (pure, testable, returns the
   factors) + an AI pass that nudges within a band and writes the human reason —
   grounded in the real factors so it cannot invent.
5. **Storm-driven install/upsell recommendation** (rep-facing suggestion), seeded
   with editable default trigger→product mappings.
6. **Phone auto-formatting**: accept any common phone format and normalize to
   E.164 at the schema layer (so the form, `/api/leads`, and Twilio inbound all
   benefit), with as-you-type display formatting in the form.
7. **Managed lead sources**: a dropdown of common roofing lead sources with an
   inline **"+ Add"** that persists a new source to the tenant for next time.

## Non-goals (v1)

- **Roof material auto-detection from imagery** (no reliable source).
- **Google Solar roof geometry** (pitch/area) — nice-to-have, deferred.
- **ASCE-7 code-accurate design-wind-speed lookup** — wind rating uses *observed*
  storm wind for v1; code-accurate ratings are a later enhancement.
- **Zillow / Redfin scraping** — no public API, ToS-protected, actively blocked.
  County assessor (already in StormProof) is the legitimate free source.
- Auto-applying upsells to estimates — v1 only *surfaces* the recommendation; the
  estimator validates. (Seeding `estimate.upsellSuggestions` is a later hook.)

## Key constraint: multi-state

Brett chose **no default state**. StormProof's county-assessor coverage is
**Arizona-only** (Maricopa, Pinal, …), so **year-built / roof-type enrichment only
fills for AZ leads**; non-AZ leads keep those blank unless the rep types them.
**Storm lookup (NOAA-sourced) works nationwide.** This is graceful, not an error.

## Architecture

Everything hangs off the existing `lead/created` → `lead-intake` Inngest workflow.
We extend that one workflow (durable, idempotent) rather than add parallel paths.

```
NewLeadForm (Google Places autocomplete + structured fields + optional roof/year)
   └─ createLead (action)  →  createLeadForTenant
         ├─ customer insert
         ├─ property insert (line1/city/state/zip/county/lat/lng/roofType/yearBuilt)
         └─ lead insert  →  emit lead/created
                                  │
                       Inngest: lead-intake (extended)
                         step load-lead      → read customer + FULL property
                         step enrich-property→ StormProof: year built, roof type, storms (best-effort)
                         step score-lead      → scoreLeadBaseline (rules) + AI pass (reason)
                                                 + deriveInstallRecommendation
                                                 → persist score/scoreReason/scoreFeatures/installRecommendation/stormEventId
                         step send-sms        → unchanged (best-effort)
```

### Component boundaries

| Unit | Package | Purpose | Depends on |
|---|---|---|---|
| `AddressAutocomplete` | `apps/web` (client) | Google Places typeahead → structured fields; graceful fallback to plain inputs | Google Maps JS (Places), `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` |
| `NewLeadForm` (edit) | `apps/web` | adds structured address + optional roofType/yearBuilt | `AddressAutocomplete`, `createLead` |
| `normalizePhone` / `formatPhoneDisplay` | `packages/core` | **pure** any-format → E.164; E.164 → `(480) 555-1234` display | — |
| `leadIntakeSchema` (extend) | `packages/core` | optional structured fields + phone `transform` → E.164 (backward-compatible) | zod, `normalizePhone` |
| `property` / `lead` schema (extend) | `packages/db` | new columns + migration | drizzle |
| `createLeadForTenant` (edit) | `apps/web/lib/intake` | persist structured + optional fields | `@savvy/db` |
| `stormproof` gateway | `packages/integrations` | real `httpStormProof` + `makeFakeStormProof`, env-selected | `STORMPROOF_API_BASE`, optional key |
| `scoreLeadBaseline` | `packages/core` | **pure** deterministic score + factor list | — |
| `deriveInstallRecommendation` | `packages/core` | **pure** storm/roof → install class + upsell products | seeded default config |
| `lead-intake` (extend) | `packages/agents` | enrich → hybrid score → recommend, all idempotent steps | gateway, stormproof, core fns |
| lead detail (edit) | `apps/web` | surface enriched facts + score factors + install/upsell rec | queries |

## Data model changes

Extend `property` (already has `city`, `lat`, `lng`, `parcelId`, `roofSqft`,
`roofPitch`, `yearBuilt`, `stories`):

- `line1 text` — street line (the formatted full `address` stays for back-compat)
- `state text`
- `zip text`
- `county text`
- `roofType text` — enum-by-convention: `asphalt_shingle | tile | metal | flat_foam | other` (null = unknown)

Extend `lead` (already has `score`, `scoreReason`, `stormEventId`):

- `scoreFeatures jsonb` — the exact signals + factor breakdown behind the score (auditability)
- `installRecommendation jsonb` — `{ windRating, impactResistance, suggestedProducts[], rationale }`

One migration via `pnpm db:generate` (next number `0015`). All new columns
nullable → no backfill, no break to existing rows/flows. RLS unchanged (policies
are table-level, already cover these tables).

## Address autocomplete

- `AddressAutocomplete` loads the Google Maps JS API (Places library) with
  `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` (browser key, restricted to Places + the
  prod/localhost referrers).
- On place selection, map `address_components` → `{ line1, city, state, zip,
  county (administrative_area_level_2), lat, lng }`; populate four editable inputs
  so the rep can correct. **No state default.**
- **Graceful degradation**: if the script fails to load (missing key / offline),
  render the four fields as plain text inputs. The form still submits without
  `lat/lng`. Enrichment then degrades by source: **storm lookup still works**
  (StormProof `/api/storms/lookup` geocodes by `address`), but **year-built lookup
  is skipped** (StormProof `/api/property` requires `lat/lng` and does not
  geocode). Rep-entered year/roof still apply.
- Optional fields: `roofType` (`<select>`, native — repo has no shadcn Select) and
  `yearBuilt` (number). Rep-entered values are authoritative.

## Phone normalization

Today `leadIntakeSchema.phone` is `z.string().regex(/^\+[1-9]\d{6,14}$/)` — strict
E.164, rejecting everything else (the "one particular format" pain).

- **`normalizePhone(input): string | null`** (pure, `@savvy/core`): strip to
  digits; **10 digits** → `+1XXXXXXXXXX`; **11 digits starting `1`** → `+1…`;
  input already starting `+` with 7–15 digits → pass through; otherwise `null`.
- **`formatPhoneDisplay(e164): string`** (pure): US numbers → `(480) 555-1234`,
  else return the E.164 string.
- The schema `phone` becomes a **transform**: accept any string, run
  `normalizePhone`, emit E.164, and add a validation issue only when it can't be
  normalized. Because normalization lives in the schema, **all entry paths**
  (web form, `/api/leads`, Twilio inbound — already E.164, idempotent) are
  covered at once.
- **Form UX**: the phone input formats **as the rep types** (US 10-digit →
  `(480) 555-1234`); label changes from "E.164, e.g. +14805551234" to "Phone"
  with a friendly placeholder. The server transform remains the source of truth.
- **No new dependency** (US-centric; valid international E.164 still passes).
  `libphonenumber-js` is a future option if full international parsing is needed.

## Managed lead sources

Today `source` is a free-text input (defaulting to "manual"). Replace it with a
dropdown backed by a default list plus tenant-added entries.

- **`DEFAULT_LEAD_SOURCES`** (pure, `@savvy/core`) — `{ value, label }[]`:
  referral, repeat, door_knock, storm_canvass, website, google, facebook,
  yard_sign, carrier, other. These `value`s align with the scoring weights.
- **Tenant additions** live in `tenant.settings.leadSources: string[]` (jsonb).
  `addLeadSource(tenantId, source)` (`@savvy/db`, adminDb, read-modify-write
  preserving sibling settings, case-insensitive dedupe). Any authenticated user
  may add (low-risk).
- **`mergeLeadSources(custom)`** (pure, core) → defaults + custom (deduped) for
  the dropdown.
- **`LeadSourceSelect`** (web) — native `<select>` of merged options + an inline
  **"+ Add"** affordance: reveal a small input → `addLeadSourceAction` persists +
  selects it (also available on the next lead).
- **Scoring alignment**: `scoreLeadBaseline` looks up the source weight
  case-insensitively (`SCORE_WEIGHTS.source[value.toLowerCase()] ?? default`), so
  custom sources simply score at the default weight.

## Enrichment (StormProof gateway)

New `packages/integrations/src/stormproof.ts` following the repo's gateway pattern
(`httpDocuseal` / `companycam`): an interface, a real HTTP impl, a fake impl, and
an env-selected factory `stormProof` that returns the **fake when
`STORMPROOF_API_BASE` is unset** (so dev/test/e2e never hit the network).

Methods (all best-effort, typed, return `null`/empty on any failure):

- `getProperty({ lat, lng, address })` → `{ yearBuilt?, roofAge?, roofType?, county?, supported }`
  - HTTP: `GET {base}/api/property?lat&lng&address` (optional `STORMPROOF_API_KEY` header)
  - **Requires `lat/lng`** (the endpoint does not geocode) — returns `null` if absent.
  - `roofType` only set if the assessor response carries a usable construction field.
- `lookupStorms({ lat, lng, address, months })` → `{ events[], maxHailInches, maxWindMph, daysSinceWorst, worstEventId, eventCount }`
  - HTTP: `GET {base}/api/storms/lookup?lat&lng&months` — falls back to `?location=<address>` (the endpoint geocodes) when `lat/lng` absent.

`enrich-property` Inngest step (runs before scoring, wrapped so it can never throw
out of the workflow):
1. If `property.yearBuilt` null **and `lat/lng` present** → `getProperty`,
   fill `yearBuilt` (+ `roofType` if blank and present, + `county`).
2. `lookupStorms` → set `lead.stormEventId = worstEventId`, stash storm features.
3. Assemble a `LeadFeatures` object for the next step.

`LeadFeatures` (the single typed input to both pure functions):
```ts
type LeadFeatures = {
  source: string;
  state: string | null;
  inTerritory: boolean;          // tenant territory match (v1: any non-null state = true; refine later)
  hasContact: boolean;           // phone/email present
  roofType: string | null;
  yearBuilt: number | null;
  roofAgeYears: number | null;
  storm: { eventCount: number; maxHailInches: number; maxWindMph: number; daysSinceWorst: number | null };
};
```

## Hybrid scoring

**`scoreLeadBaseline(features): { score: number; factors: { label: string; points: number }[] }`**
— pure, in `@savvy/core`, exhaustively unit-tested. Deterministic point system,
clamped 0–100. Seeded weights (editable constants):

| Factor | Points (illustrative, tunable) |
|---|---|
| Source: referral / web / manual / carrier | +18 / +8 / +5 / +12 |
| Recent hail ≥1″ within 12 mo (scaled by size + recency) | up to +30 |
| Recent wind event (scaled by mph + recency) | up to +20 |
| Roof age ≥ 15 yrs (scaled) | up to +20 |
| In-territory (has a state) | +5 |
| Has contact info | +5 |

**AI pass** — through the gateway (`capability: "reasoning"`), given the baseline
score + factor list + features, with an explicit rubric. It may adjust the score
within **±10** of the baseline and must return a terse `reason` that cites the
factors. Schema `{ score: 0–100, reason: ≤200 chars }`. Because it sees the
deterministic factors, the output is grounded.

Persist `lead.score` (AI-adjusted), `lead.scoreReason`, `lead.scoreFeatures`
(`{ features, baseline, factors, aiAdjustment }`). Replaces the old `qualifyLead`
stub path. Status still moves `new → contacted` as today.

## Install / upsell recommendation

**`deriveInstallRecommendation(features): { windRating; impactResistance; suggestedProducts[]; rationale }`**
— pure, in `@savvy/core`, unit-tested. Seeded **editable default config** (Brett
tunes after seeing it live):

| Trigger | Output |
|---|---|
| `maxWindMph ≥ 110` OR ≥2 wind events in window | `windRating: "high"` → products: high-wind shingle, 6-nail pattern, upgraded starter + ridge |
| `maxHailInches ≥ 1.0` | `impactResistance: "class4"` → product: Class 4 impact-resistant shingles (+ insurance-discount talking point) |
| `roofAgeYears ≥ 18` AND any storm | rationale notes: frame as full replacement vs repair |
| else | `windRating: "standard"`, `impactResistance: "standard"`, empty products |

Stored on `lead.installRecommendation`; surfaced on the lead detail. **Rep-facing
suggestion only** — not a code determination, not auto-applied to estimates.
Thresholds + product strings live in one exported config object for easy tuning.

## UI surfacing

- **NewLeadForm**: autocomplete + structured fields + optional roof/year (above).
- **Lead detail** (`/leads/[id]`): add an "Enrichment & Recommendation" card —
  enriched facts (year built, roof type, county, storm summary), the **score
  factor breakdown** (from `scoreFeatures`, so the 72 is explained), and the
  **install/upsell recommendation** chips.

## Error handling

- Google Places: client-side, degrades to plain inputs; never blocks submit.
- StormProof calls: wrapped per-call (`try/catch` → `null`), and the whole
  `enrich-property` step is wrapped so enrichment failure still lets scoring +
  lead creation proceed (scoring just runs with fewer signals).
- Idempotency: re-running `lead-intake` re-enriches and overwrites
  score/features deterministically (safe to retry; Inngest step-level).
- No secrets in repo; `STORMPROOF_API_BASE`/`STORMPROOF_API_KEY` +
  `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` documented in `.env.example`.

## Testing

- **Unit (pure, `@savvy/core`)**: `scoreLeadBaseline` (factor math, clamping,
  every source), `deriveInstallRecommendation` (each trigger + the else case),
  address-component mapping, StormProof feature extraction (raw response →
  `LeadFeatures.storm`), `normalizePhone`/`formatPhoneDisplay` (10-digit, 11-digit
  `1…`, E.164 pass-through, dashes/parens/spaces, invalid → reject).
- **Integration (`@savvy/db` / `@savvy/agents` with the fake gateway)**:
  `createLeadForTenant` persists the new property/lead fields; `enrich-property`
  with `makeFakeStormProof` fills year built + storm; cross-tenant isolation still
  green.
- **e2e (Playwright)**: `/leads/new` renders structured + optional fields and
  creates a lead; lead detail shows the enrichment/recommendation card. Google
  Places is **stubbed/bypassed** in e2e (the structured inputs are filled
  directly — autocomplete needs a real Google key).
- AI scoring uses the existing request-aware `ai-stub.mjs` in e2e.

## Non-negotiables checklist (CLAUDE.md)

- ✅ Tenant isolation: all property/lead writes via `withTenant`/RLS.
- ✅ AI via gateway by **capability** (`reasoning`) — no hardcoded model.
- ✅ Async/multi-step = Inngest steps, idempotent + best-effort.
- ✅ Integrate, don't rebuild: StormProof is wrapped as a gateway (real+fake).
- ✅ No secrets; `.env.example` updated.
- ✅ Every unit ships with tests; typecheck + lint clean; local prod `next build`
  before PR (CI never builds prod).

## Implementation slices (for the plan)

- **A — Address form + schema + intake**: migration, schema, `leadIntakeSchema`,
  `normalizePhone`/`formatPhoneDisplay` + phone transform, managed lead sources
  (`DEFAULT_LEAD_SOURCES`/`mergeLeadSources` + `addLeadSource` + `LeadSourceSelect`),
  `AddressAutocomplete`, `NewLeadForm` (with as-you-type phone formatting),
  `createLeadForTenant`. (No scoring change yet; structured data just lands.)
- **B — StormProof enrichment**: `stormproof` gateway (real+fake), `enrich-property`
  step, `LeadFeatures` assembly, `stormEventId` wiring, env + `.env.example`.
- **C — Hybrid scoring**: `scoreLeadBaseline`, AI pass, persist score/features,
  retire the `address:"unknown"` stub; lead-detail factor breakdown.
- **D — Install/upsell recommendation**: `deriveInstallRecommendation` + config,
  persist + surface on lead detail.

Each slice is independently testable and shippable in order.

## Open questions / future enhancements

- ASCE-7 design-wind-speed lookup for code-accurate wind ratings (multi-state).
- Google Solar roof geometry (pitch/area) to feed roof-size scoring.
- Seed `estimate.upsellSuggestions` from `installRecommendation` at estimate time.
- Per-tenant territory definition to make `inTerritory` real (v1 = has-a-state).
- Tenant-editable scoring weights + upsell config (v1 = code constants).
