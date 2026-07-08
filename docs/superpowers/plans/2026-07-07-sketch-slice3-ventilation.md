# Sketch Slice 3 — Ventilation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** From a drawn roof sketch, advise the rep how much attic ventilation the roof needs and which exhaust products satisfy it — as suggestions only, never auto-added to the estimate — and surface plan (footprint) area.

**Architecture:** A pure `ventilationSummary(sketch)` in `packages/core` reuses slice-2's deduped ridge LF to size a small set of exhaust products against the required net free area (NFA = ventilated plan sqft ÷ 300, balanced). A per-facet `ventilated` flag (default on, stored in the sketch JSONB — no DB migration) selects which facets count. The editor gets a toggle + live readout, the report gets a ventilation section, and the lead card surfaces plan sqft.

**Tech Stack:** TypeScript, zod, Vitest (core + db), Next.js App Router (report/editor), Drizzle (lead-artifacts projection).

## Global Constraints

- **Package manager:** `pnpm` (monorepo, Turborepo). Run core tests via `pnpm --filter @savvy/core exec vitest run <file>`.
- **No DB migration this slice** — the `ventilated` field lives in the sketch JSONB and defaults to `true`, so existing sketches parse unchanged.
- **Suggestions only** — ventilation output must NOT flow through `sketchSummaryToAreas` / `generateEstimateLineItems`. Nothing auto-added to estimates.
- **NFA carried in square inches** internally; required NFA also exposed in square feet.
- **Scope:** exhaust-only, ridge-only, always balanced ÷300. Intake products, hips-as-ventable, and the ÷150 path are deferred (see spec non-goals).
- **db test imports use `.js` extensions** (ESM/Turbopack) — match the existing `packages/db/tests/*.ts` style.
- Spec: `docs/superpowers/specs/2026-07-07-sketch-slice3-ventilation-design.md`.

---

### Task 1: Core — `ventilated` facet field, constants, and `ventilationSummary`

**Files:**
- Modify: `packages/core/src/roof-sketch.ts` (schema field ~line 62; new constants + function after `suggestEdgeTypes`, ~line 302)
- Test: `packages/core/src/roof-sketch.test.ts` (append a new `describe` block; extend imports)

**Interfaces:**
- Consumes: `summarizeSketch(sketch).edgeLf.ridge` (deduped ridge LF), `planAreaSqFt`, `RoofSketch`, `SketchFacet` (all existing in this file).
- Produces (relied on by Tasks 2–4):
  - `sketchFacetSchema` now yields `ventilated: boolean` (default `true`).
  - `NFA_BALANCED_DIVISOR: number`, `EXHAUST_FRACTION: number`
  - `EXHAUST_PRODUCTS: VentProductSpec[]`
  - `interface VentProductSpec { key: string; name: string; unit: "lf" | "each"; nfaPerUnitSqIn: number; sizing: "ridge" | "count" }`
  - `interface VentExhaustOption { key: string; name: string; unit: "lf" | "each"; quantity: number; nfaProvidedSqIn: number; meetsTarget: boolean }`
  - `interface VentilationSummary { ventilatedPlanSqft: number; requiredNfaSqft: number; requiredNfaSqIn: number; exhaustTargetSqIn: number; intakeTargetSqIn: number; ventableRidgeLf: number; exhaustOptions: VentExhaustOption[] }`
  - `ventilationSummary(sketch: RoofSketch): VentilationSummary`

- [ ] **Step 1: Add the `ventilated` field to the facet schema**

In `packages/core/src/roof-sketch.ts`, in `sketchFacetSchema`, add after the `label` line:

```ts
  label: z.enum(["none", "dormer", "two_story", "two_layer"]).default("none"),
  /** Whether this facet sits over ventilated attic space (counts toward NFA). Default on. */
  ventilated: z.boolean().default(true),
});
```

- [ ] **Step 2: Add ventilation constants, types, and function**

In `packages/core/src/roof-sketch.ts`, append after `suggestEdgeTypes` (after its closing `}` near line 302):

```ts
// ── Slice 3: attic ventilation (advisory) ─────────────────────────────────────
// Suggests exhaust products from the drawn geometry. Balanced 1:300 NFA rule, split
// ~50/50 intake/exhaust. Exhaust is sized off the slice-2 DEDUPED ridge LF so a shared
// ridge is never double-counted into the vent suggestion. Suggestions only — never
// auto-added to an estimate.

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

/** Standard exhaust products with default NFA ratings (square inches). Tunable constants. */
export const EXHAUST_PRODUCTS: VentProductSpec[] = [
  { key: "ridge_vent_shingle_over", name: "Shingle-over ridge vent", unit: "lf", nfaPerUnitSqIn: 18, sizing: "ridge" },
  { key: "ridge_vent_aluminum", name: "Aluminum ridge vent", unit: "lf", nfaPerUnitSqIn: 12, sizing: "ridge" },
  { key: "box_vent", name: "Box / louver vent", unit: "each", nfaPerUnitSqIn: 50, sizing: "count" },
  { key: "turbine_vent", name: 'Turbine vent (12")', unit: "each", nfaPerUnitSqIn: 113, sizing: "count" },
];

export interface VentExhaustOption {
  key: string;
  name: string;
  unit: "lf" | "each";
  /** Suggested quantity: full ventable ridge LF (ceil) for ridge products, else ceil(target / nfaPerUnit). */
  quantity: number;
  /** NFA the suggested quantity provides, square inches. */
  nfaProvidedSqIn: number;
  /** Whether nfaProvidedSqIn >= exhaustTargetSqIn. */
  meetsTarget: boolean;
}

export interface VentilationSummary {
  ventilatedPlanSqft: number;
  requiredNfaSqft: number;
  requiredNfaSqIn: number;
  exhaustTargetSqIn: number;
  intakeTargetSqIn: number;
  ventableRidgeLf: number;
  exhaustOptions: VentExhaustOption[];
}

/** Advisory ventilation sizing for a sketch. Exhaust-only this slice; intake target is
 *  reported as a number but no intake products are suggested yet. */
export function ventilationSummary(sketch: RoofSketch): VentilationSummary {
  const ventilatedPlanSqft = sketch.facets
    .filter((f) => f.ventilated !== false)
    .reduce((sum, f) => sum + planAreaSqFt(f.points), 0);

  const requiredNfaSqft = ventilatedPlanSqft / NFA_BALANCED_DIVISOR;
  const requiredNfaSqIn = requiredNfaSqft * 144;
  const exhaustTargetSqIn = requiredNfaSqIn * EXHAUST_FRACTION;
  const intakeTargetSqIn = requiredNfaSqIn * EXHAUST_FRACTION;

  const ventableRidgeLf = summarizeSketch(sketch).edgeLf.ridge;

  const exhaustOptions: VentExhaustOption[] = EXHAUST_PRODUCTS.map((p) => {
    const quantity =
      p.sizing === "ridge"
        ? Math.ceil(ventableRidgeLf)
        : Math.ceil(exhaustTargetSqIn / p.nfaPerUnitSqIn);
    const nfaProvidedSqIn = quantity * p.nfaPerUnitSqIn;
    return {
      key: p.key,
      name: p.name,
      unit: p.unit,
      quantity,
      nfaProvidedSqIn,
      meetsTarget: nfaProvidedSqIn >= exhaustTargetSqIn,
    };
  });

  return {
    ventilatedPlanSqft,
    requiredNfaSqft,
    requiredNfaSqIn,
    exhaustTargetSqIn,
    intakeTargetSqIn,
    ventableRidgeLf,
    exhaustOptions,
  };
}
```

- [ ] **Step 3: Write the failing tests**

In `packages/core/src/roof-sketch.test.ts`, add `ventilationSummary` to the existing top-of-file import block (`roofSketchSchema`, `summarizeSketch`, and `SketchFacet` are already imported). Then append this block at the end of the file:

```ts
// ── Slice 3: ventilation ──────────────────────────────────────────────────────
// Two 30×20 facets sharing a 30 ft ridge on the y=0 line (same shape as the slice-2
// gable, narrower). Plan 600 each ⇒ 1200 total; deduped ridge 30 LF.
function ventGable(): SketchFacet[] {
  return [
    { id: "A", points: [ { x: 0, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 20 }, { x: 0, y: 20 } ], pitch: "6/12", edges: ["ridge", "rake", "eave", "rake"], label: "none", ventilated: true },
    { id: "B", points: [ { x: 0, y: 0 }, { x: 0, y: -20 }, { x: 30, y: -20 }, { x: 30, y: 0 } ], pitch: "6/12", edges: ["rake", "eave", "rake", "ridge"], label: "none", ventilated: true },
  ];
}

describe("ventilationSummary", () => {
  it("sizes exhaust off the DEDUPED ridge (30 LF, not 60)", () => {
    const v = ventilationSummary(sketchOf(ventGable()));
    expect(v.ventableRidgeLf).toBe(30);
  });

  it("computes ventilated plan area and required NFA (1200 sqft ⇒ 4.0 sqft NFA)", () => {
    const v = ventilationSummary(sketchOf(ventGable()));
    expect(v.ventilatedPlanSqft).toBe(1200);
    expect(v.requiredNfaSqft).toBeCloseTo(4.0, 10);
    expect(v.exhaustTargetSqIn).toBeCloseTo(288, 6);
  });

  it("suggests full ridge LF for ridge products; box vents fill to target", () => {
    const v = ventilationSummary(sketchOf(ventGable()));
    const shingle = v.exhaustOptions.find((o) => o.key === "ridge_vent_shingle_over")!;
    expect(shingle.quantity).toBe(30);
    expect(shingle.nfaProvidedSqIn).toBe(540);
    expect(shingle.meetsTarget).toBe(true);
    const box = v.exhaustOptions.find((o) => o.key === "box_vent")!;
    expect(box.quantity).toBe(6); // ceil(288 / 50)
  });

  it("excludes facets toggled off ventilation", () => {
    const facets = ventGable();
    facets[0]!.ventilated = false;
    const v = ventilationSummary(sketchOf(facets));
    expect(v.ventilatedPlanSqft).toBe(600);
    expect(v.requiredNfaSqft).toBeCloseTo(2.0, 10);
  });

  it("defaults ventilated to true when the key is absent (back-compat)", () => {
    const parsed = roofSketchSchema.parse({
      version: 1, centerLat: 33, centerLng: -112, zoom: 20,
      facets: [ { id: "f1", points: [ { x: 0, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 20 }, { x: 0, y: 20 } ], pitch: "6/12", edges: ["ridge", "rake", "eave", "rake"] } ],
    });
    expect(parsed.facets[0]!.ventilated).toBe(true);
    expect(ventilationSummary(parsed).ventilatedPlanSqft).toBe(600);
  });
});
```

Also add `ventilationSummary` to the existing import block at the top of the test file (alongside `suggestEdgeTypes`).

- [ ] **Step 4: Run the tests to verify they fail**

Run: `pnpm --filter @savvy/core exec vitest run src/roof-sketch.test.ts`
Expected: FAIL — `ventilationSummary is not exported` / not defined (before Step 2 is saved) or assertion failures if run mid-edit.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @savvy/core exec vitest run src/roof-sketch.test.ts`
Expected: PASS — the original 28 tests plus 5 new ventilation tests (33 total).

- [ ] **Step 6: Typecheck core**

Run: `pnpm --filter @savvy/core typecheck`
Expected: no errors. (`index.ts` re-exports via `export * from "./roof-sketch"`, so the new symbols are exported automatically.)

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/roof-sketch.ts packages/core/src/roof-sketch.test.ts
git commit -m "feat(sketch): slice 3 — ventilationSummary + per-facet ventilated flag"
```

---

### Task 2: Editor — per-facet ventilation toggle + live readout

**Files:**
- Modify: `apps/web/src/app/(app)/jobs/[id]/measure/SketchEditor.tsx`

**Interfaces:**
- Consumes: `ventilationSummary`, `SketchFacet` (now with `ventilated`) from `@savvy/core`; existing `summary.totalPlanSqft`.
- Produces: no new exports (leaf component).

- [ ] **Step 1: Import `ventilationSummary` and compute it**

In the `@savvy/core` import block near the top of `SketchEditor.tsx`, add `ventilationSummary`. After the existing `const summary = useMemo(() => summarizeSketch(sketch), [sketch]);` (line ~185), add:

```ts
  const vent = useMemo(() => ventilationSummary(sketch), [sketch]);
```

- [ ] **Step 2: Add the `setFacetVentilated` handler**

After `setFacetLabel` (ends ~line 579), add:

```ts
  function setFacetVentilated(id: string, ventilated: boolean) {
    pushHistory(facets);
    setFacets((prev) => prev.map((f) => (f.id === id ? { ...f, ventilated } : f)));
  }
```

- [ ] **Step 3: Set `ventilated: true` on the two in-editor facet literals**

The `SketchFacet` output type now requires `ventilated`. Update both literals:

Draft placeholder (line ~284):
```ts
      return [...base, { id: "__draft__", points: draft, pitch: "0/12", edges: [], label: "none", ventilated: true } as SketchFacet];
```

`closeDraft` new facet (line ~356-363):
```ts
      {
        id: newFacetId(),
        points: draft,
        pitch: "0/12",
        edges: draft.map(() => "unspecified" as SketchEdgeType),
        label: "none",
        ventilated: true,
      },
```

- [ ] **Step 4: Add the toggle to the selected-facet panel**

In the `mode === "select" && selectedFacet` Card, after the Label `<label>` block (closes ~line 1195) and before the `Plan … Surface …` `<div>` (line ~1196), insert:

```tsx
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={selectedFacet.ventilated}
                    onChange={(e) => setFacetVentilated(selectedFacet.id, e.target.checked)}
                    data-testid="facet-ventilated-toggle"
                  />
                  <span className="text-muted-foreground">Counts toward ventilation</span>
                </label>
```

- [ ] **Step 5: Add plan-area + required-NFA rows to the live totals card**

In the "Live totals" Card's `<dl>` (after the `Pitched / flat` Row, line ~1222), add:

```tsx
                <Row k="Plan (footprint)" v={`${Math.round(summary.totalPlanSqft)} sqft`} />
                {summary.totalPlanSqft > 0 && (
                  <Row k="Required NFA" v={`${vent.requiredNfaSqft.toFixed(1)} sqft`} />
                )}
```

- [ ] **Step 6: Typecheck + lint the web app**

Run: `pnpm --filter @savvy/web typecheck`
Expected: no errors (in particular, no "property 'ventilated' is missing" from the facet literals).

Run: `pnpm --filter @savvy/web lint`
Expected: clean (no new warnings for this file).

- [ ] **Step 7: Commit**

```bash
git add "apps/web/src/app/(app)/jobs/[id]/measure/SketchEditor.tsx"
git commit -m "feat(sketch): slice 3 — facet ventilation toggle + live NFA readout"
```

---

### Task 3: Report — Ventilation section + plan-area row

**Files:**
- Modify: `apps/web/src/app/(app)/jobs/[id]/measure/report/page.tsx`

**Interfaces:**
- Consumes: `ventilationSummary` from `@savvy/core`; existing `summary.totalPlanSqft`.
- Produces: none.

- [ ] **Step 1: Import `ventilationSummary` and compute it**

Add `summarizeSketch,` already present; add `ventilationSummary,` to the `@savvy/core` import block. After `const summary = summarizeSketch(sketch);` (line ~59), add:

```ts
  const vent = ventilationSummary(sketch);
```

- [ ] **Step 2: Add the plan-area row to the Area table**

In the Area `<tbody>`, add as the FIRST row (before `Total roof area`, line ~125):

```tsx
              <Tr k="Plan (footprint) area" v={`${Math.round(summary.totalPlanSqft).toLocaleString()} sqft`} />
```

- [ ] **Step 3: Add the Ventilation section**

Insert a new `<section>` after the Waste-factors section (after its closing `</section>`, ~line 187) and before the Facets section:

```tsx
      {/* Ventilation */}
      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Ventilation
        </h2>
        <p className="mb-3 text-sm text-muted-foreground">
          Required net free area (NFA):{" "}
          <span className="font-medium text-foreground">{vent.requiredNfaSqft.toFixed(1)} sqft</span> over{" "}
          {Math.round(vent.ventilatedPlanSqft).toLocaleString()} sqft of ventilated plan area (balanced,
          1:300). Target splits ~50% exhaust / 50% intake; intake soffit sizing is pending.
        </p>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th className="py-1.5 font-medium">Exhaust option</th>
              <th className="py-1.5 text-right font-medium">Qty</th>
              <th className="py-1.5 text-right font-medium">NFA provided</th>
              <th className="py-1.5 text-right font-medium">Meets exhaust</th>
            </tr>
          </thead>
          <tbody>
            {vent.exhaustOptions.map((o) => (
              <tr key={o.key} className="border-b border-border last:border-0">
                <td className="py-1.5">{o.name}</td>
                <td className="py-1.5 text-right">
                  {o.quantity} {o.unit === "lf" ? "LF" : "ea"}
                </td>
                <td className="py-1.5 text-right">{Math.round(o.nfaProvidedSqIn).toLocaleString()} sq in</td>
                <td className="py-1.5 text-right">{o.meetsTarget ? "Yes" : "No"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-2 text-xs text-muted-foreground">
          Suggestions only — pick the exhaust product you&apos;ll install. Nothing is added to the
          estimate automatically.
        </p>
      </section>
```

- [ ] **Step 4: Typecheck + lint**

Run: `pnpm --filter @savvy/web typecheck`
Expected: no errors.

Run: `pnpm --filter @savvy/web lint`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add "apps/web/src/app/(app)/jobs/[id]/measure/report/page.tsx"
git commit -m "feat(sketch): slice 3 — report ventilation section + plan-area row"
```

---

### Task 4: Lead card — surface plan (footprint) area

**Files:**
- Modify: `packages/db/src/lifecycle/lead-artifacts.ts`
- Modify: `apps/web/src/app/(app)/leads/[id]/LeadArtifacts.tsx`
- Test: `packages/db/tests/lead-artifacts.test.ts`

**Interfaces:**
- Consumes: `roofSketchSchema`, `summarizeSketch` from `@savvy/core`.
- Produces: `LeadArtifacts.measurement.planSqft: number | null`.

- [ ] **Step 1: Write the failing test**

In `packages/db/tests/lead-artifacts.test.ts`, add a new test inside the `describe`:

```ts
  it("computes planSqft from a DIY sketch measurement", async () => {
    const { tenantId } = await makeTenant();
    const { leadId, propertyId } = await makeLeadWithProperty(tenantId);
    await withTenant(tenantId, (tx) =>
      tx.insert(measurement).values({
        tenantId, propertyId, provider: "diy", source: "sketch", pitch: "6/12",
        areas: {
          squares: 12,
          sketch: {
            version: 1, centerLat: 33, centerLng: -112, zoom: 20,
            facets: [
              { id: "f1", points: [ { x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 30 }, { x: 0, y: 30 } ], pitch: "6/12", edges: ["ridge", "rake", "eave", "rake"], label: "none" },
            ],
          },
        },
      }),
    );
    const a = await getLeadArtifacts({ tenantId, leadId });
    expect(a.measurement?.planSqft).toBe(1200);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @savvy/db exec vitest run tests/lead-artifacts.test.ts`
Expected: FAIL — `a.measurement.planSqft` is `undefined` (property not yet on the projection).

- [ ] **Step 3: Add `planSqft` to the projection**

In `packages/db/src/lifecycle/lead-artifacts.ts`:

Extend the import from `@savvy/core` (line 6):
```ts
import { selectPreferredMeasurement, roofSketchSchema, summarizeSketch } from "@savvy/core";
```

Add `planSqft` to the measurement type (after `squares`, line 13):
```ts
    squares: number | null;
    planSqft: number | null;
```

In `getLeadArtifacts`, after `const areas = (m?.areas ?? {}) as Record<string, unknown>;` (line 43), compute plan sqft:
```ts
    const parsedSketch = roofSketchSchema.safeParse((areas as { sketch?: unknown }).sketch);
    const planSqft = parsedSketch.success ? Math.round(summarizeSketch(parsedSketch.data).totalPlanSqft) : null;
```

Add `planSqft` to the returned measurement object (after `squares:` line 50):
```ts
            squares: typeof areas.squares === "number" ? areas.squares : null,
            planSqft,
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @savvy/db exec vitest run tests/lead-artifacts.test.ts`
Expected: PASS — including the existing two tests (the roofr measurement yields `planSqft: null` since it has no sketch).

- [ ] **Step 5: Render the plan-area Field on the card**

In `apps/web/src/app/(app)/leads/[id]/LeadArtifacts.tsx`, in the Measurement `<dl>`, add after the `Pitch` Field (line ~37):

```tsx
            <Field label="Plan area" value={m.planSqft != null ? `${m.planSqft.toLocaleString()} sqft` : "—"} />
```

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @savvy/db typecheck && pnpm --filter @savvy/web typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/db/src/lifecycle/lead-artifacts.ts packages/db/tests/lead-artifacts.test.ts "apps/web/src/app/(app)/leads/[id]/LeadArtifacts.tsx"
git commit -m "feat(sketch): slice 3 — surface plan (footprint) area on the lead card"
```

---

### Final verification (after all tasks)

- [ ] **Full core + db suites green:**
  Run: `pnpm --filter @savvy/core exec vitest run && pnpm --filter @savvy/db exec vitest run`
  Expected: all pass. (Per repo gotcha, `health-sweep`/`break-glass`/`ops-rollup`/`storm-cert-carryover` may fail at *teardown* on the shared local DB — not real; they pass in isolation and on CI.)
- [ ] **Typecheck + lint clean:** `pnpm typecheck && pnpm lint`
- [ ] **Manual smoke (optional, real app):** draw two facets, toggle one off ventilation → live "Required NFA" halves; open the report → Ventilation section lists ridge/box/turbine with sensible quantities; the lead card shows a Plan area value.
- [ ] **Push branch + open PR** targeting `worktree-sketch-tool-slice-2` (stacked, like #164 → #162). Retarget to `main` after the slice-2 stack lands.

## Self-review notes

- **Spec coverage:** `ventilated` field (Task 1) · `ventilationSummary`/NFA/÷300/ridge-only/exhaust products (Task 1) · editor toggle + readout (Task 2) · report section + plan row (Task 3) · lead card plan sqft (Task 4). Intake products / hips / ÷150 explicitly deferred per spec — no task, by design.
- **Type consistency:** `ventilationSummary` / `VentExhaustOption` / `EXHAUST_PRODUCTS` / `VentProductSpec` names are identical across Tasks 1–4; `planSqft` name identical in the db type, projection, test, and component.
- **Fixture math:** two 30×20 facets ⇒ plan 1200, NFA 1200/300 = 4.0 sqft = 576 sq in, exhaust target 288; shingle-over ridge 30 LF × 18 = 540 (meets); box ceil(288/50) = 6. All reconcile.
