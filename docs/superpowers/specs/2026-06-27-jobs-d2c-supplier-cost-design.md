# Jobs D2c — Supplier material cost → honest margin (design)

**Date:** 2026-06-27
**Slice:** Jobs build-order item D2c. Stacked on **D2a** (PR #60 / branch `jobs-d2`):
needs the `material_order` table.

## Goal

Give the price book a **supplier cost** per item, carry that cost onto the
material order generated from an estimate, and write the real material cost to
`job.costCents` — so the cockpit margin (and the commission basis) reflect true
cost instead of always reading "(none recorded)".

## Why now

D2a deliberately kept the material-order subtotal (a list-price BOM) **out of**
`job.costCents`, noting "true material cost needs supplier pricing = D2c."
Today **nothing writes `job.costCents`**, so `computeJobMargin` always reports
`costKnown: false` and the cockpit shows margin = revenue. `commission.ts` also
uses `job.costCents` as its basis (`amountPaid − costCents`), so populating it
makes commissions accurate too. D2c is the first real cost signal.

## Design decisions (locked; labels per Brett's response-quality rule)

- **[ASSUMED] Supplier cost lives on `price_book_item`.** Add a per-unit
  `unitCostCents` column (integer, not null, default 0), editable in the
  existing price-book settings UI. A full supplier/SKU catalog (multiple
  suppliers, SKUs, real-time pricing) is **out of scope** — future work.
- **[INFERRED] Cost travels on the material order.** `MaterialOrderLine` gains
  optional `unitCostCents` + `lineCostCents`; `material_order` gains
  `cost_subtotal_cents`. Computed at generation by joining the estimate's
  material lines to the price book **by `key`** (`lineCostCents = quantity ×
  unitCostCents`; `costSubtotalCents = Σ lineCostCents`).
- **[ASSUMED] When cost hits margin.** On every `setMaterialOrderStatus`,
  recompute `job.costCents = Σ cost_subtotal_cents` of that job's material
  orders whose status ∈ `{ordered, delivered}`. This is **recompute, not
  increment** → idempotent, and it **reverts** when an order is canceled.
  Material is currently the only contributor to `job.costCents`; this is
  documented so a future labor-cost source knows to make the total additive.
- **[ASSUMED] Seed costs.** `DEFAULT_PRICE_BOOK` gets a `unitCostCents` per item
  (~65% of list for material/accessory; labor cost = list price) so margin is
  immediately meaningful before a tenant edits anything. These are placeholders
  the tenant overrides — same convention as the existing list prices.

## Why list-price stays separate from cost

`unitPriceCents` (what the homeowner is charged) drives the estimate and the
material-order subtotal. `unitCostCents` (what the company pays the supplier)
drives `job.costCents`. Keeping them as two columns is what makes margin
meaningful: `margin = revenue(list) − cost(supplier)`.

## Data model changes

- `price_book_item`: **+ `unit_cost_cents` integer not null default 0**.
- `material_order`: **+ `cost_subtotal_cents` integer not null default 0**.
- `MaterialOrderLine` (core type): **+ `unitCostCents?: number`**, **+
  `lineCostCents?: number`** (optional → existing D2a behavior/tests unaffected;
  cost is attached by the lifecycle, not by `materialLinesFromEstimate`).
- `EnginePriceBookItem` (core): **+ `unitCostCents?: number`** (optional; the
  estimate engine ignores it — keeps the price-book row type aligned).

## Surfaces

- **Core (`@savvy/core`):** seed `unitCostCents`, extend the two types, add a
  pure `attachMaterialCosts(lines, costByKey)` helper. Unit-tested.
- **DB (`@savvy/db`):** two additive columns + migration; lifecycle enriches
  orders with cost and recomputes `job.costCents` on status change. Tested
  against Postgres.
- **Web (`apps/web`):** a "Supplier cost" field in the price-book settings
  editor (+ the action); the cockpit margin card now shows real cost (already
  wired — it just becomes non-null), and the Materials panel shows the order's
  cost subtotal. Verified by Playwright e2e.

## Out of scope (later)

- Supplier/SKU catalog, multiple suppliers, real-time supplier pricing.
- Labor/overhead cost contributors to `job.costCents` (the recompute is written
  so a future contributor can be added additively).
- Cost on accessory lines flowing to orders (D2a BOM = `category:"material"`
  only; accessories are not ordered as materials).

## Non-negotiables touched

- Tenant isolation: both new columns are on already-tenant-scoped tables; all
  reads/writes stay inside `withTenant`.
- No hard-coded model strings (no AI here).
- The recompute never double-counts (idempotent by construction).
