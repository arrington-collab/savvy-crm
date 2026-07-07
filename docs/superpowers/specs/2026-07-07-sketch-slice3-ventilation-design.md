# Sketch Slice 3 — Ventilation (design)

**Date:** 2026-07-07
**Branch:** `worktree-sketch-tool-slice-3` (stacked on `worktree-sketch-tool-slice-2` / PR #164)
**Depends on:** Slice 2's shared-edge dedup (`summarizeSketch` → deduped `edgeLf.ridge`).

## Goal

From a drawn roof sketch, tell the rep how much attic ventilation the roof needs and
which exhaust products would satisfy it — as **advisory suggestions**, never auto-added to
the estimate. Also surface the plan (footprint) area that already exists in the summary.

## Scope (this slice)

- Per-facet **"counts toward ventilation"** flag (default ON).
- A pure `ventilationSummary(sketch)` in `packages/core` computing required NFA and a small
  set of **exhaust** product options, sized off the slice-2 deduped ridge LF.
- Surface plan (footprint) sqft and the ventilation block in the report + editor; surface
  plan sqft on the lead card.
- **Exhaust only.** Intake target NFA is computed and shown as a number; intake *product*
  suggestions (soffit vents) are deferred to a later slice.

## Non-goals (explicitly deferred)

- Intake product suggestions (soffit/undereave vent counts).
- Hips as ventable exhaust length (this slice is **ridge-only**).
- The unbalanced ÷150 path (this slice is **always balanced ÷300**).
- Persisting the rep's chosen product; wiring any ventilation line into the auto-estimate
  (`sketchSummaryToAreas` / `generateEstimateLineItems`) — suggestions stay advisory.

## Locked decisions (from brainstorming)

| Decision | Choice |
|---|---|
| NFA-per-unit source | **Core constants** (pure, no migration) |
| Balance rule | **Always ÷300 (balanced)**, 50/50 intake/exhaust |
| Facet toggle default | **ON** |
| Ventable exhaust edges | **Ridge only** (deduped `edgeLf.ridge`) |
| Number of exhaust products | **A few, rep picks** (comparison table) |
| Ridge length when longer than needed | **Full ventable ridge LF** (NFA may exceed target) |
| Intake products | **Deferred** (target NFA shown, no product counts) |

## Data model — no DB migration

The sketch is stored as JSONB in `measurement.areas.sketch`, validated by zod. Add one
optional field to `sketchFacetSchema` in `packages/core/src/roof-sketch.ts`:

```ts
/** Whether this facet sits over ventilated attic space (counts toward NFA). */
ventilated: z.boolean().default(true),
```

Because it defaults to `true`, existing sketches parse unchanged (field materializes as
`true`) — no migration, consistent with slices 1–2. The `__draft__` placeholder facet and
any object literals cast to `SketchFacet` in `SketchEditor.tsx` must set `ventilated: true`.

## Core: constants + `ventilationSummary`

All NFA is carried internally in **square inches** (how vents are rated); required NFA is
also exposed in square feet for display. Constants are **[ASSUMED]** industry defaults,
grouped so they are easy to tune later:

```ts
/** Attic sqft served per 1 sqft of net free area (NFA), balanced ventilation. */
export const NFA_BALANCED_DIVISOR = 300;
/** Fraction of required NFA allocated to exhaust (and, symmetrically, intake). */
export const EXHAUST_FRACTION = 0.5;

export interface VentProductSpec {
  key: string;
  name: string;
  unit: "lf" | "each";
  /** Net free area contributed per unit, in square inches. */
  nfaPerUnitSqIn: number;
  /** "ridge" products run the full ventable ridge LF; "count" products fill to target. */
  sizing: "ridge" | "count";
}

export const EXHAUST_PRODUCTS: VentProductSpec[] = [
  { key: "ridge_vent_shingle_over", name: "Shingle-over ridge vent", unit: "lf",   nfaPerUnitSqIn: 18,  sizing: "ridge" },
  { key: "ridge_vent_aluminum",     name: "Aluminum ridge vent",     unit: "lf",   nfaPerUnitSqIn: 12,  sizing: "ridge" },
  { key: "box_vent",                name: "Box / louver vent",       unit: "each", nfaPerUnitSqIn: 50,  sizing: "count" },
  { key: "turbine_vent",            name: "Turbine vent (12\")",     unit: "each", nfaPerUnitSqIn: 113, sizing: "count" },
];
```

### Function

```ts
export interface VentExhaustOption {
  key: string;
  name: string;
  unit: "lf" | "each";
  /** Suggested quantity: full ventable ridge LF for ridge products, else ceil(target / nfaPerUnit). */
  quantity: number;
  /** NFA the suggested quantity provides, square inches. */
  nfaProvidedSqIn: number;
  /** Whether nfaProvidedSqIn >= exhaustTargetSqIn. */
  meetsTarget: boolean;
}

export interface VentilationSummary {
  ventilatedPlanSqft: number;      // Σ plan sqft of facets with ventilated === true
  requiredNfaSqft: number;         // ventilatedPlanSqft / 300
  requiredNfaSqIn: number;         // requiredNfaSqft * 144
  exhaustTargetSqIn: number;       // 50% of requiredNfaSqIn
  intakeTargetSqIn: number;        // 50% of requiredNfaSqIn (informational this slice)
  ventableRidgeLf: number;         // summary.edgeLf.ridge (deduped by slice 2)
  exhaustOptions: VentExhaustOption[];
}

export function ventilationSummary(sketch: RoofSketch): VentilationSummary;
```

**Algorithm:**
1. `ventilatedPlanSqft` = Σ `planAreaSqFt(facet.points)` for facets where `facet.ventilated !== false`.
2. `requiredNfaSqft` = `ventilatedPlanSqft / NFA_BALANCED_DIVISOR`; `requiredNfaSqIn = requiredNfaSqft * 144`.
3. `exhaustTargetSqIn = intakeTargetSqIn = requiredNfaSqIn * EXHAUST_FRACTION`.
4. `ventableRidgeLf` = `summarizeSketch(sketch).edgeLf.ridge` (deduped — the slice-2 tie-in).
5. For each `EXHAUST_PRODUCTS` item:
   - `sizing === "ridge"` → `quantity = round(ventableRidgeLf)`, `nfaProvided = ventableRidgeLf * nfaPerUnit`.
   - `sizing === "count"` → `quantity = ceil(exhaustTargetSqIn / nfaPerUnit)`, `nfaProvided = quantity * nfaPerUnit`.
   - `meetsTarget = nfaProvided >= exhaustTargetSqIn`.

Reuses `planAreaSqFt` and `summarizeSketch` — no geometry duplication.

## UI surfaces

| File | Change |
|---|---|
| `packages/core/src/roof-sketch.ts` | `ventilated` field; constants; `ventilationSummary`; export from `index.ts` |
| `apps/web/.../measure/SketchEditor.tsx` | Per-facet "Counts toward ventilation" toggle in the selected-facet panel (mirrors `setFacetPitch`/`setFacetLabel`); live plan-sqft + required-NFA readout; set `ventilated: true` on the draft placeholder |
| `apps/web/.../measure/report/page.tsx` | New **Ventilation** section (required NFA in sqft, exhaust option table with qty + NFA + meets-target, intake target as a number) + a **Plan (footprint) area** row in the Area table |
| `apps/web/.../leads/[id]/LeadArtifacts.tsx` | Surface `totalPlanSqft` on the card |

The report ventilation section is a **static comparison table** — every exhaust product with
its resulting quantity; the rep reads the row they want and orders it manually. No client
state, no persistence, fully server-rendered.

## Testing (TDD, red-path first)

Add to `packages/core/src/roof-sketch.test.ts`. Fixture: two 30×20 facets, both 6/12,
sharing a 30 ft ridge (the two 30 ft slope-bottom edges are eaves, the four 20 ft edges are
rakes, the shared 30 ft edge is the ridge).

1. **Red-path guard (slice-2 tie-in):** `ventableRidgeLf === 30`, NOT 60 — proves the ridge
   is deduped before it drives ventilation (the double-count would suggest 60 LF of ridge vent).
2. `ventilatedPlanSqft === 1200` and `requiredNfaSqft === 4.0`.
3. Shingle-over ridge exhaust option: `quantity === 30`, `nfaProvidedSqIn === 540`, `meetsTarget === true`.
4. Box vent option: `quantity === ceil(288/50) === 6`.
5. **Toggle:** setting one facet `ventilated: false` drops `ventilatedPlanSqft` to 600 and
   `requiredNfaSqft` to 2.0.
6. **Back-compat:** a facet parsed without a `ventilated` key defaults to `ventilated: true`.

Existing 28 roof-sketch tests must stay green (no behavior change to `summarizeSketch`).

## Assumptions & what's missing

- **[ASSUMED]** NFA-per-unit values (18/12/50/113 sq in) — confirmed as defaults; tunable constants.
- **[ASSUMED]** ventilated attic floor area ≈ ventilated plan (footprint) sqft — standard, but
  ignores cathedral/partial-attic nuance.
- **[ASSUMED]** the rep reconciles ridge-vent product choice against real attic access on site.
- **What a domain expert would challenge:** always-balanced ÷300 overstates required NFA when
  there is no working intake; ridge-only ignores hip-vent capacity on hip roofs; turbine vents
  are active (their sq-in NFA equivalence is approximate). All deferred by design this slice.
