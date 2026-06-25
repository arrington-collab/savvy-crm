# Phase B — Scoring rework + Lanes + Dedupe (design)

**Date:** 2026-06-24
**Branch:** `feat/scoring-lanes` (worktree `~/Sites/savvy-phaseb`, off `origin/main` @ `831d690`)
**Pipeline context:** Phase B of the Lead Intake Pipeline. Covers **Stage 1 (capture/dedupe)**, **Stage 2 (lane-tag)**, and **Stage 3 (scoring)** in one cycle. Builds on Phase A (Stage 4), which already reads `lead.lane` for skill-matching.

---

## Goal

Three coupled improvements to lead qualification, deterministic where it's math:

1. **Scoring rework** — replace the flat additive baseline with a weighted, banded, config-driven model matching the product spec; keep the best-effort LLM ±10 refinement (fail-open).
2. **Lanes** — persist a `lead.lane` (`storm` / `tile` / `standard`) set at intake and on re-score; Stage 4 consumes it.
3. **Dedupe** — stop creating duplicate customer/property records when the same person re-submits; non-destructive attach on exact phone/email match.

Plus a **nightly re-score cron** (fresh storms lift old leads) and **band + reasons surfaced** on the lead.

---

## Decisions locked (from brainstorming)

- **All three in one cycle** (one spec/plan/PR), built in waves.
- **Re-weighted scoring** to available signals: **Storm 47 · Roof age/type 33 · Source 20** (value + engagement dropped, renormalized to 100; they slot in later without re-tuning if data arrives).
- **Keep the LLM ±10 hybrid**, fail-open (unchanged from today's `hybridScore`).
- **Re-score trigger:** nightly Inngest cron over open leads.
- **Lane:** persisted `lead.lane` column.
- **Dedupe:** non-destructive attach, exact normalized phone OR email match only.

---

## What exists (enhance, don't replace)

| Piece | Location | Action |
|---|---|---|
| `scoreLeadBaseline(features)` flat additive, `SCORE_WEIGHTS`, `recencyFactor` | `packages/core/src/lead-scoring.ts` | **Rework** into weighted/banded/config-driven `scoreLead` |
| `buildLeadFeatures` / `LeadFeatures` | `packages/core/src/lead-features.ts` | Reuse; feed the new scorer |
| `hybridScore` (LLM ±10, fail-open) | `packages/agents/src/functions/lead-intake.ts:12` | Keep; call new `scoreLead` for the baseline |
| `ai-qualify` step (scores + persists) | `lead-intake.ts` ~L222 | Extend to persist `scoreBand` + `lane` |
| Stage 4 inline lane (`roofType === "tile"`) | `lead-intake.ts:116` (`runLeadAssignment`) | **Replace** with the persisted `lead.lane` |
| `createLeadForTenant` (always inserts new customer/property/lead) | `apps/web/src/lib/intake.ts` | **Enhance** with dedupe attach |
| `normalizePhone` | `packages/core` (used by `leadIntakeSchema`) | Reuse for match keys |
| StormProof `lookupStorms` (events w/ size/wind/date) | `packages/integrations/src/stormproof.ts` | Reuse in re-score cron |
| Cron pattern (TZ Phoenix) | `packages/agents/src/functions/cold-archive.ts` | Mirror for re-score |
| `tenant.settings.*` jsonb config pattern | `assignment`/`scheduling` | Mirror for `scoring` |

---

## Component 1 — Scoring (`packages/core/src/lead-scoring.ts`, reworked)

New pure entry point (the cron + intake both call it):

```ts
export type ScoreBand = "hot" | "warm" | "cool" | "cold";
export type ScoredLead = {
  score: number;            // 0..100 (pre-LLM baseline)
  band: ScoreBand;
  reasons: string[];        // human-readable
  components: { storm: number; roof: number; source: number }; // 0..100 each, pre-weight
  disqualified: boolean;    // out-of-service-area gate
};
export function scoreLead(f: LeadFeatures, cfg: ScoringConfig): ScoredLead;
```

**Weighted composite** (config weights, default 47/33/20):
`score = round( wStorm*stormSub + wRoof*roofSub + wSource*sourceSub )` where each `*Sub` is 0..1.

**Storm sub-score** (exact, from product spec): for each storm event `severityBase × recencyFactor`; take the **max**; **+10%** (capped at 1.0) if ≥2 qualifying events in the last 12 mo.
- `severityBase` (÷100 to normalize 0..1): hail ≥1.5″ = 100 · ≥1.0″ = 70 · ≥0.75″ = 40; wind ≥58 mph = 60 · ≥45 mph = 35; else 0.
- `recencyFactor` by months since event: ≤6 = 1.00 · >6–12 = 0.85 · >12–18 = 0.55 · >18–24 = 0.30 · >24 = 0.00.
- Today's `StormFeature` carries `maxHailInches`, `maxWindMph`, `daysSinceWorst`, `eventCount` (not per-event). v1 computes the sub-score from these summary fields (worst event drives `severityBase` via max hail/wind; `daysSinceWorst` drives recency; `eventCount ≥ 2` within 12 mo drives the +10%). A follow-up can pass full `events[]` for exactness — noted, not built.

**Roof sub-score** (0..1): from `roofAgeYears` — 0 below 10 yrs, ramping linearly to 1.0 at ≥22 yrs (config `roofAgeMinYears`/`roofAgeMaxYears`); `roofType === "tile"` adds a small configurable bump (tile is higher-value work). Unknown age → **neutral 0.5** (degrade, not zero).

**Source sub-score** (0..1): config map (referral/repeat = 1.0 … cold canvass/other = ~0.25); unknown → `sourceDefault`.

**Bands:** `hot ≥ 80 · warm 60–79 · cool 40–59 · cold < 40` (config cutoffs).

**Fit gates:**
- **Out-of-service-area** → `score 0`, `band cold`, `disqualified true`. Service area = config list of state codes (default: derive from existing assignment territory if present, else no gate). Reason: `"Out of area — disqualified"`.
- **Renter/absentee ×0.5** — occupancy is **not tracked today**, so this gate is specified in config but **dormant** (no input wired) until an occupancy signal exists. Flagged explicitly; no fake data.

**`reasons[]`** built per contributing component (e.g. `"Severe hail 4 mo ago"`, `"Roof ~26 yrs (tile)"`, `"Referral"`).

**LLM refinement** stays in `hybridScore`: `scoreLead` provides the baseline + reasons; `hybridScore` clamps the LLM to ±10 and falls open to the baseline on any error (unchanged contract). Persisted: `lead.score` (post-LLM), `lead.scoreBand`, `lead.scoreReason`, `lead.scoreFeatures` (now includes `components` + `reasons` + `disqualified`).

**Config** `tenant.settings.scoring` (zod-defaulted, `parseScoringConfig`): weights, band cutoffs, severity bases, recency tiers, roof-age ramp, tile bump, source map, service-area states, renter multiplier. Fully tunable.

> Backward-compat: `scoreLeadBaseline` is currently imported by `hybridScore`. Replace that call with `scoreLead(...).score`/reasons; keep or remove `scoreLeadBaseline` based on remaining callers (grep in the plan).

## Component 2 — Lanes (`lead.lane` column)

- Migration: `lead.lane` text, nullable (set by the workflow, not at raw insert).
- **Derivation** (pure `deriveLane(features, cfg): "storm" | "tile" | "standard"`), precedence:
  1. `storm` — a qualifying recent swath (storm sub-score ≥ config `stormLaneThreshold`, default 0.3 ≈ within 24 mo & meaningful severity).
  2. `tile` — `roofType === "tile"`.
  3. `standard` — otherwise.
- Set in the `ai-qualify` step (has features + storm) and recomputed by the re-score cron.
- **Stage 4 wiring:** `runLeadAssignment` reads `lead.lane` from the row (drop the inline `roofType === "tile"` derivation at `lead-intake.ts:116`); `pickAssignee`'s soft skill-match already consumes `lane`.

## Component 3 — Re-score cron (`packages/agents/src/functions/lead-rescore.ts`, new)

- Nightly Inngest cron (`TZ=America/Phoenix`, mirrors `cold-archive`). Per tenant, for **open** leads (status not in won/lost) with a property lat/lng:
  - re-run `stormProof.lookupStorms`, rebuild features, `scoreLead`, `deriveLane`;
  - if the **band improved** (e.g. cool→hot), persist new score/band/lane and **notify the owner** — reuse the existing notification/comms path (an internal notification or owner SMS/email per the comms layer; the plan picks the lightest existing mechanism) and record an `agentRun`.
  - Idempotent: re-scoring is pure recompute; no duplicate notifications for an unchanged band.
- Fail-open: a StormProof error for one lead is logged and skipped; the cron continues.

## Component 4 — Dedupe (`createLeadForTenant`, `apps/web/src/lib/intake.ts`)

Before inserting, within the tenant transaction:
- **Match key:** normalized phone (`normalizePhone`) OR normalized email (trim+lowercase). Exact match only.
- If a **customer** matches → reuse it (don't insert a new customer). Then match that customer's **property** by `normalizeAddress(address)` (new pure helper: lowercase, strip punctuation, collapse whitespace; compare on line1+zip when present, else full address) — reuse if matched, else insert a new property under the existing customer.
- Always insert a **new `lead`** linked to the resolved customer/property (a re-inquiry is a new lead, not a silent drop), preserving its own `source`/attribution.
- **Non-destructive:** never updates/merges/deletes existing customer or property records. Address-only matches (no phone/email match) are **not** deduped (avoid false merges) → new records.
- Emits `lead/created` as today (the new lead still flows through intake).

> This is conservative by design: high-precision (exact phone/email) over high-recall. Fuzzy/address-only merge + a manual "merge duplicates" UI are explicitly a later concern.

## Stage 7 sliver

- `lead.scoreBand` + `scoreFeatures.reasons` surface on the lead detail (band chip + reason list) — read-side only; UI is a thin addition to the existing lead detail Contact/score area.
- Re-score band-upgrades are logged (`agentRun`) and notify the owner.

---

## Schema (one migration)

```sql
ALTER TABLE "lead" ADD COLUMN "score_band" text;
ALTER TABLE "lead" ADD COLUMN "lane" text;
```
Both nullable, set by the workflow. Office/scoring config stay in `tenant.settings` (no migration). Ship `.sql` + drizzle meta together (`_journal.json` + `NNNN_snapshot.json`).

---

## Data flow

```
lead/created → leadIntake
  ├─ enrich-property (StormProof: storm summary + property)   [unchanged]
  └─ ai-qualify: buildLeadFeatures → scoreLead(cfg) → deriveLane(cfg)
       → hybridScore (LLM ±10, fail-open) → persist score/scoreBand/scoreReason/scoreFeatures/lane
  └─ assign-lead: runLeadAssignment reads lead.lane (persisted) → pickAssignee  [Stage 4, now real lane]

createLeadForTenant (intake.ts)  [Stage 1]
  → match existing customer by norm phone|email → reuse customer (+ property by norm address)
  → insert NEW lead linked → emit lead/created

lead-rescore cron (nightly, per tenant, open leads)  [Stage 3 re-score]
  → lookupStorms → scoreLead + deriveLane → if band improved: persist + notify owner + agentRun
```

---

## Error handling

- **LLM down:** `hybridScore` already falls open to the deterministic baseline — unchanged.
- **StormProof error** (intake or cron): storm summary degrades to empty (existing `EMPTY_STORMS`), storm sub-score → 0, lane falls to tile/standard; cron skips the one lead and continues.
- **Dedupe ambiguity:** multiple customers match the same phone/email (shouldn't happen, but) → pick the oldest deterministically; never merge.
- **Config missing/invalid:** `parseScoringConfig` returns full defaults (safe model).
- **Idempotency:** intake scoring runs in the durable `ai-qualify` step; cron re-score is a pure recompute keyed per lead.

---

## Testing

Pure unit (local-gated):
- `scoreLead`: storm severity/recency **boundary** cases (1.5″/1.0″/0.75″ hail; 58/45 mph wind; month tiers 6/12/18/24); the +10% multi-event bump + cap; roof-age ramp (10/22 yr) + tile bump + unknown→0.5; source map; weighted composite sums; band cutoffs (39/40/59/60/79/80); out-of-area gate → 0/disqualified; unknown fields degrade neutral.
- `deriveLane`: storm > tile > standard precedence; threshold boundary.
- `parseScoringConfig`: defaults + overrides.
- `normalizeAddress`: punctuation/case/whitespace; line1+zip vs full.
- dedupe matcher (pure part): phone/email normalization equality.

CI-gated (DB):
- `createLeadForTenant` dedupe: same phone → reuses customer, new lead; same email diff phone → reuse; different contact → new records; address-only → not deduped.
- `ai-qualify` persists `scoreBand` + `lane`; `runLeadAssignment` reads persisted lane.
- re-score cron: a lead whose storm now qualifies gets band upgrade + lane=storm + owner notified; unchanged band → no notify.

---

## Out of scope

- Property-value + engagement data sources (the two dropped components).
- Fuzzy/address-only dedupe + manual merge-duplicates UI.
- Occupancy/renter data (gate stays dormant).
- Per-event storm exactness (v1 uses StormProof summary fields).
- 3-min speed-to-lead / cadence / voice (Phases C–D).

---

## Self-review

- **Placeholders:** none; every component names its file + signature.
- **Consistency:** `scoreLead` output (`band`, `reasons`, `components`, `disqualified`) is what `ai-qualify` persists and the cron recomputes; `lead.lane`/`scoreBand` columns match the migration; Stage 4 reads the same `lane` values `deriveLane` produces.
- **Scope:** large but one coherent qualification slice; UI is read-only/thin; risky fuzzy-merge deferred.
- **Ambiguity:** weights, curves, cutoffs, lane precedence/threshold, dedupe match keys, and the dormant renter gate are all pinned to explicit values/config.
