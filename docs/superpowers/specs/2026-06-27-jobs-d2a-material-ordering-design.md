# Jobs D2a — Material Ordering (design)

**Date:** 2026-06-27
**Slice:** Jobs build-order item D2a (material ordering). Greenfield — no
material-order / PO / supplier / BOM entity exists yet.

## Goal

When an estimate is accepted, turn its **material** line items into a
**material order** (a bill of materials) the production team can track:
generate it, view the lines + subtotal + status on the job cockpit, and align
its delivery date to the crew install appointment.

## Why now

A roofing job's production phase can't start without materials on site. The
estimate engine already computed material quantities from the takeoff; D2a
makes that buyable/trackable. D2b (auto-flag misalignment to the needs-you
queue) and D2c (supplier/SKU + real supplier cost) come later.

## Source of truth for the BOM

The **accepted estimate's `lineItems`** where `category === "material"`. The
estimate engine (`generateEstimateLineItems`) already produced
`EstimateLineItem[]` with `quantity`, `unit`, `unitPriceCents`, `amountCents`.
Only `category === "material"` lines become a material order line. (Categories:
`["material","labor","accessory","upgrade"]`; units:
`["square","lf","each","flat"]`.)

## Agreed design decisions (locked)

1. **Single `material_order` table with a jsonb `lineItems` array** — mirror the
   `estimate` / `invoice` convention. No separate line table; no per-line status
   for MVP.
2. **List-price BOM, NOT cost.** The order subtotal uses the price-book
   `unitPriceCents` (what the homeowner is charged), not supplier cost. We do
   **NOT** write it to `job.costCents` — that keeps the E-margin number honest.
   True material cost needs supplier pricing, which is D2c.
3. **`neededByAt` = install date − `DELIVERY_BUFFER_DAYS` (2 days).** Install
   date = the earliest `appointment` for the job with `type='crew'` AND
   `status='scheduled'`, ordered by `startsAt`. If no crew appointment is
   scheduled yet, `neededByAt` is null.
4. **Idempotent: one material order per estimate.** `estimateId` is unique on
   the table; re-generating returns the existing order.
5. **Auto-generate on `estimate/accepted`** via an Inngest function (idempotent),
   **plus** a manual "Generate from estimate" button on the cockpit. The manual
   path is the synchronous one the e2e exercises (Inngest doesn't run in e2e).
6. **Delivery flag** (derived, not stored): `no_install` when there's no
   scheduled crew appointment (or no `neededByAt`), `misaligned` when the
   computed `neededByAt` is after the install date, otherwise `none`.

## Data model — `material_order`

| column | type | notes |
|---|---|---|
| `id` | uuid pk | `idCol()` (uuid v7) |
| `tenant_id` | uuid not null → tenant | RLS |
| `job_id` | uuid not null → job | |
| `estimate_id` | uuid not null → estimate | **unique** (idempotency) |
| `status` | `material_order_status` enum | default `draft` |
| `line_items` | jsonb `MaterialOrderLine[]` | default `[]` |
| `subtotal_cents` | integer not null | default `0`, sum of line `amountCents` |
| `needed_by_at` | timestamptz null | install − 2d, or null |
| `ordered_at` | timestamptz null | set when status → `ordered` |
| `delivered_at` | timestamptz null | set when status → `delivered` |
| `created_at` | timestamptz not null | `createdAt()` |

Indexes: `(tenant_id, job_id)`, `(tenant_id, status)`, unique `(estimate_id)`.
RLS: `tenantIsolation()`.

Enum: `MATERIAL_ORDER_STATUS = ["draft","ordered","delivered","canceled"]`.

`MaterialOrderLine = { key; name; quantity; unit; unitPriceCents; amountCents }`
(a projection of `EstimateLineItem` — drops category/waste/pitch fields).

## Surfaces

- **Core (`@savvy/core`):** status enum, `MaterialOrderLine` type, and pure
  helpers (`materialLinesFromEstimate`, `materialOrderSubtotalCents`,
  `neededByFromInstall`, `materialDeliveryFlag`, `DELIVERY_BUFFER_DAYS`).
  Unit-tested.
- **DB (`@savvy/db`):** schema + migration; lifecycle
  `createMaterialOrderFromEstimate`, `setMaterialOrderStatus`,
  `getJobInstallDate`. Tested against Postgres.
- **Agents (`@savvy/agents`):** Inngest function on `estimate/accepted`.
- **Web (`apps/web`):** `MaterialsPanel` on the job cockpit + a generate /
  advance-status server action. Verified by Playwright e2e.

## Out of scope (later)

- D2b: auto-flag delivery misalignment into the needs-you / exception queue.
- D2c: supplier + SKU mapping, real supplier cost, writing true cost to margin.
- Per-line ordering status, partial deliveries, multiple suppliers per order.

## Non-negotiables touched

- Tenant isolation: `tenant_id` + `tenantIsolation()` RLS on the new table.
- No hard-coded model strings (no AI in this slice).
- New config (`DELIVERY_BUFFER_DAYS`) is a core constant for now, not a parser.
