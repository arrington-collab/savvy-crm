# Jobs D2c — Supplier material cost → honest margin: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-unit supplier cost to the price book, carry it onto the material order generated from an estimate, and write the real material cost to `job.costCents` so the cockpit margin and commission basis reflect true cost.

**Architecture:** A new `unit_cost_cents` column on `price_book_item` and a `cost_subtotal_cents` column on `material_order`. Pure cost-attach logic lives in `@savvy/core`. At generation, the lifecycle joins the estimate's material lines to the price book by `key` to compute line costs. On every material-order status change, `job.costCents` is recomputed (not incremented) as the sum of cost over the job's orders in `{ordered, delivered}` — idempotent and self-reverting. The price-book settings UI gains a supplier-cost field.

**Tech Stack:** TypeScript, Drizzle ORM + Postgres (RLS), Next.js App Router (server actions), Vitest (core + db), Playwright (web e2e). pnpm + Turborepo. **Stacked on branch `jobs-d2` (D2a / PR #60).**

## Global Constraints

- **Tenant isolation:** both new columns are on already-tenant-scoped tables; every read/write stays inside `withTenant`. No raw cross-tenant query.
- **List price ≠ cost:** `unitPriceCents` (charged) drives revenue/estimate; `unitCostCents` (paid to supplier) drives `job.costCents`. Keep them as separate columns.
- **`job.costCents` recompute is idempotent:** `job.costCents = Σ cost_subtotal_cents` of the job's material orders with status ∈ `{ordered, delivered}`. Recompute, never increment. A canceled order drops out of the sum automatically.
- **Material is currently the only `job.costCents` contributor** — document this so a future labor/overhead source makes the total additive rather than overwriting.
- **Backward compatible:** `MaterialOrderLine.unitCostCents`/`lineCostCents` and `EnginePriceBookItem.unitCostCents` are OPTIONAL; `materialLinesFromEstimate` is unchanged (D2a behavior/tests stay green). New columns default to 0.
- **No `.js` extensions** in core/web/db **source** imports; **db `.test.ts` files DO use `.js`**. Inside `packages/core`, import `z` from `"./schemas"`.
- **`apps/web` is NOT in the vitest workspace** — web logic is verified by Playwright e2e only.
- Definition of done: `pnpm test && pnpm typecheck && pnpm lint` all green before PR; PR opened off `jobs-d2` with `gh pr create --base jobs-d2` (retarget to `main` after #60 merges).

---

## File Structure

**Modify:**
- `packages/core/src/price-book.ts` — `unitCostCents` on `DefaultPriceBookItem` + seed values.
- `packages/core/src/estimate-engine.ts` — `unitCostCents?` on `EnginePriceBookItem`.
- `packages/core/src/material-order.ts` — `unitCostCents?`/`lineCostCents?` on `MaterialOrderLine`; new `attachMaterialCosts`.
- `packages/core/src/material-order.test.ts` — tests for `attachMaterialCosts`.
- `packages/db/src/schema/pricing.ts` — `unit_cost_cents` column.
- `packages/db/src/schema/procurement.ts` — `cost_subtotal_cents` column.
- `packages/db/src/lifecycle/material-order.ts` — cost at generation + recompute `job.costCents`.
- `packages/db/src/lifecycle/material-order.test.ts` — cost + recompute tests.
- `apps/web/src/lib/price-book-actions.ts` — `unitCostCents` in update.
- `apps/web/src/lib/price-book-queries.ts` — ensure `unitCostCents` selected (verify).
- `apps/web/src/app/(app)/settings/price-book/PriceBookClient.tsx` — supplier-cost field.
- `apps/web/src/app/(app)/jobs/[id]/MaterialsPanel.tsx` — show cost subtotal.
- `apps/web/src/app/(app)/jobs/[id]/page.tsx` — serialize `costSubtotalCents`.
- `docs/jobs-pipeline.md` — cost/margin note.

**Create:**
- `packages/db/drizzle/00XX_*.sql` — generated migration (two ADD COLUMN).
- `apps/web/tests/e2e/material-cost.spec.ts` — e2e (generate → ordered → real `job.costCents` + margin).

---

## Task 1: Core — supplier cost types, seed, and `attachMaterialCosts`

**Files:**
- Modify: `packages/core/src/price-book.ts`, `packages/core/src/estimate-engine.ts`, `packages/core/src/material-order.ts`
- Test: `packages/core/src/material-order.test.ts`

**Interfaces:**
- Produces:
  - `DefaultPriceBookItem.unitCostCents: number` (+ seed values on all `DEFAULT_PRICE_BOOK` rows)
  - `EnginePriceBookItem.unitCostCents?: number`
  - `MaterialOrderLine.unitCostCents?: number`, `MaterialOrderLine.lineCostCents?: number`
  - `attachMaterialCosts(lines: MaterialOrderLine[], costByKey: Record<string, number>): { lines: MaterialOrderLine[]; costSubtotalCents: number }`

- [ ] **Step 1: Write the failing test**

Append to `packages/core/src/material-order.test.ts` (add `attachMaterialCosts` to the existing import from `./material-order`):

```typescript
describe("attachMaterialCosts", () => {
  const lines = materialLinesFromEstimate([
    { key: "shingles", name: "Shingles", category: "material", unit: "square", quantity: 30, unitPriceCents: 12000, amountCents: 360000 },
    { key: "underlayment", name: "Underlayment", category: "material", unit: "square", quantity: 30, unitPriceCents: 2000, amountCents: 60000 },
  ]);

  it("attaches per-line cost from the cost map and sums the cost subtotal", () => {
    const { lines: costed, costSubtotalCents } = attachMaterialCosts(lines, { shingles: 7800, underlayment: 1300 });
    expect(costed[0]!.unitCostCents).toBe(7800);
    expect(costed[0]!.lineCostCents).toBe(30 * 7800);
    expect(costed[1]!.lineCostCents).toBe(30 * 1300);
    expect(costSubtotalCents).toBe(30 * 7800 + 30 * 1300);
  });

  it("treats a missing key as zero cost", () => {
    const { lines: costed, costSubtotalCents } = attachMaterialCosts(lines, { shingles: 7800 });
    expect(costed[1]!.unitCostCents).toBe(0);
    expect(costed[1]!.lineCostCents).toBe(0);
    expect(costSubtotalCents).toBe(30 * 7800);
  });

  it("is 0 for no lines", () => {
    expect(attachMaterialCosts([], { shingles: 7800 })).toEqual({ lines: [], costSubtotalCents: 0 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @savvy/core exec vitest run src/material-order.test.ts`
Expected: FAIL — `attachMaterialCosts` is not exported.

- [ ] **Step 3: Extend `MaterialOrderLine` + add `attachMaterialCosts`**

In `packages/core/src/material-order.ts`, add the two optional fields to `MaterialOrderLine`:

```typescript
export type MaterialOrderLine = {
  key: string;
  name: string;
  quantity: number;
  unit: PriceBookUnit;
  unitPriceCents: number;
  amountCents: number;
  unitCostCents?: number;
  lineCostCents?: number;
};
```

Add at the end of the file:

```typescript
/** Attach per-unit supplier cost (by line key) and compute the cost subtotal. Missing key → 0. */
export function attachMaterialCosts(
  lines: MaterialOrderLine[],
  costByKey: Record<string, number>,
): { lines: MaterialOrderLine[]; costSubtotalCents: number } {
  const costed = lines.map((l) => {
    const unitCostCents = costByKey[l.key] ?? 0;
    return { ...l, unitCostCents, lineCostCents: l.quantity * unitCostCents };
  });
  const costSubtotalCents = costed.reduce((sum, l) => sum + (l.lineCostCents ?? 0), 0);
  return { lines: costed, costSubtotalCents };
}
```

- [ ] **Step 4: Add `unitCostCents` to the engine + default price-book types**

In `packages/core/src/estimate-engine.ts`, add to `EnginePriceBookItem` (after `unitPriceCents`):

```typescript
  unitCostCents?: number;
```

In `packages/core/src/price-book.ts`, add `unitCostCents: number;` to `DefaultPriceBookItem` (after `unitPriceCents`), and add a `unitCostCents` to every `DEFAULT_PRICE_BOOK` row using these values (≈65% of list for material/accessory; labor cost = list):

| key | unitCostCents |
|---|---|
| field-shingles | 7800 |
| starter-strip | 130 |
| hip-ridge-cap | 260 |
| drip-edge | 100 |
| underlayment | 975 |
| ice-water-shield | 195 |
| valley-metal | 230 |
| step-flashing | 165 |
| pipe-boots | 1625 |
| tear-off | 6000 |
| install | 8000 |

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @savvy/core exec vitest run src/material-order.test.ts`
Expected: PASS (the new `attachMaterialCosts` cases + all existing D2a cases).

- [ ] **Step 6: Typecheck core**

Run: `pnpm --filter @savvy/core typecheck`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/price-book.ts packages/core/src/estimate-engine.ts packages/core/src/material-order.ts packages/core/src/material-order.test.ts
git commit -m "feat(core): price-book unitCostCents + attachMaterialCosts helper"
```

---

## Task 2: DB schema — supplier-cost columns + migration

**Files:**
- Modify: `packages/db/src/schema/pricing.ts`, `packages/db/src/schema/procurement.ts`

- [ ] **Step 1: Add the columns**

In `packages/db/src/schema/pricing.ts`, add to `priceBookItem` after `unitPriceCents`:

```typescript
  unitCostCents: integer("unit_cost_cents").notNull().default(0),
```

In `packages/db/src/schema/procurement.ts`, add to `materialOrder` after `subtotalCents`:

```typescript
  costSubtotalCents: integer("cost_subtotal_cents").notNull().default(0),
```

- [ ] **Step 2: Generate the migration**

Run: `pnpm db:generate`
Expected: a new `packages/db/drizzle/00XX_*.sql` with two `ALTER TABLE ... ADD COLUMN` statements (`price_book_item.unit_cost_cents`, `material_order.cost_subtotal_cents`), both `integer not null default 0`.

- [ ] **Step 3: Inspect the migration**

Open the newest `packages/db/drizzle/*.sql`. Confirm it ONLY adds the two columns (no table drops/recreates, no RLS churn). If it tries to drop/recreate anything, stop and report.

- [ ] **Step 4: Apply the migration**

Run: `pnpm db:up && pnpm --filter @savvy/db db:migrate`
Expected: applies cleanly.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @savvy/db typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/schema/pricing.ts packages/db/src/schema/procurement.ts packages/db/drizzle/
git commit -m "feat(db): price_book_item.unit_cost_cents + material_order.cost_subtotal_cents"
```

---

## Task 3: DB lifecycle — cost at generation + recompute job.costCents

**Files:**
- Modify: `packages/db/src/lifecycle/material-order.ts`
- Test: `packages/db/src/lifecycle/material-order.test.ts`

**Interfaces:**
- Consumes: `attachMaterialCosts` from `@savvy/core`; `priceBookItem` from `../schema/pricing`; `job` from `../schema/jobs`; `inArray` from `drizzle-orm`.
- Produces: `createMaterialOrderFromEstimate` now stores `lineItems` with cost + `costSubtotalCents`; `setMaterialOrderStatus` recomputes `job.costCents`.

- [ ] **Step 1: Write the failing test**

Append to `packages/db/src/lifecycle/material-order.test.ts`. Add `priceBookItem` and `job` to the schema import, and a price-book fixture in `beforeAll` (after the job is created):

```typescript
// In beforeAll, after jobId is set — seed a price-book cost for the test's material key:
await adminDb.insert(priceBookItem).values({
  tenantId: tId, key: "shingles", name: "Shingles", category: "material", unit: "square",
  unitPriceCents: 12000, unitCostCents: 7800,
});
```

Add this describe block:

```typescript
describe("material cost → job.costCents", () => {
  it("stores costSubtotalCents from the price book at generation", async () => {
    const e = await newEstimate();
    const order = await createMaterialOrderFromEstimate({ tenantId: tId, estimateId: e.id });
    // LINE_ITEMS has 30 squares of "shingles" at unitCostCents 7800
    expect(order!.costSubtotalCents).toBe(30 * 7800);
    expect(order!.lineItems[0]!.unitCostCents).toBe(7800);
    expect(order!.lineItems[0]!.lineCostCents).toBe(30 * 7800);
  });

  it("recomputes job.costCents on ordered and reverts on canceled", async () => {
    const e = await newEstimate();
    const order = await createMaterialOrderFromEstimate({ tenantId: tId, estimateId: e.id });
    await setMaterialOrderStatus({ tenantId: tId, materialOrderId: order!.id, status: "ordered" });
    const [j1] = await adminDb.select().from(job).where(eq(job.id, order!.jobId));
    expect(j1!.costCents).toBe(30 * 7800);

    await setMaterialOrderStatus({ tenantId: tId, materialOrderId: order!.id, status: "canceled" });
    const [j2] = await adminDb.select().from(job).where(eq(job.id, order!.jobId));
    expect(j2!.costCents).toBe(0);
  });
});
```

(Note: the existing `newEstimate()`/`jobId` fixtures are shared; both new tests use the same `jobId`. Because `job.costCents` is recomputed as a SUM across the job's `{ordered,delivered}` orders, run order doesn't corrupt the assertions as long as each test advances/reverts its own order. The first test leaves its order in `draft` (not counted); the second orders then cancels (nets 0). If the shared fixture makes the sum ambiguous, create a fresh job+estimate inside the second test instead.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @savvy/db exec vitest run src/lifecycle/material-order.test.ts`
Expected: FAIL — `costSubtotalCents` is 0 / `job.costCents` not updated (cost not yet wired).

- [ ] **Step 3: Wire cost into generation**

In `packages/db/src/lifecycle/material-order.ts`:

1. Extend imports:
```typescript
import { materialOrder } from "../schema/procurement";
import { estimate } from "../schema/finance";
import { appointment } from "../schema/comms";
import { priceBookItem } from "../schema/pricing";
import { job } from "../schema/jobs";
import { and, eq, asc, inArray, sql } from "drizzle-orm";
import {
  materialLinesFromEstimate,
  materialOrderSubtotalCents,
  attachMaterialCosts,
  neededByFromInstall,
  type EstimateLineItem,
  type MaterialOrderStatus,
} from "@savvy/core";
```

2. In `createMaterialOrderFromEstimate`, after computing `subtotalCents` and before the insert, build the cost map and enrich the lines:
```typescript
    const subtotalCents = materialOrderSubtotalCents(lines);
    const pb = await tx.select({ key: priceBookItem.key, unitCostCents: priceBookItem.unitCostCents }).from(priceBookItem);
    const costByKey = Object.fromEntries(pb.map((p) => [p.key, p.unitCostCents]));
    const { lines: costedLines, costSubtotalCents } = attachMaterialCosts(lines, costByKey);
    const installAt = await earliestCrewInstallAt(tx, est.jobId);
    const neededByAt = neededByFromInstall(installAt);
```

3. Change the insert `.values({...})` to use `costedLines` + `costSubtotalCents`:
```typescript
      lineItems: costedLines,
      subtotalCents,
      costSubtotalCents,
      neededByAt,
```

- [ ] **Step 4: Add the recompute helper + call it on status change**

Add an internal helper (near `earliestCrewInstallAt`):

```typescript
/** Recompute job.costCents as the sum of material-order cost in {ordered,delivered}. Idempotent. */
async function recomputeJobMaterialCost(
  tx: Parameters<Parameters<typeof withTenant>[1]>[0],
  jobId: string,
): Promise<void> {
  const [agg] = await tx
    .select({ total: sql<number>`coalesce(sum(${materialOrder.costSubtotalCents}), 0)::int` })
    .from(materialOrder)
    .where(and(eq(materialOrder.jobId, jobId), inArray(materialOrder.status, ["ordered", "delivered"])));
  await tx.update(job).set({ costCents: agg?.total ?? 0 }).where(eq(job.id, jobId));
}
```

In `setMaterialOrderStatus`, after the not-found guard, recompute before returning:

```typescript
    if (!row) throw new Error(`material order ${input.materialOrderId} not found`);
    await recomputeJobMaterialCost(tx, row.jobId);
    return row;
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @savvy/db exec vitest run src/lifecycle/material-order.test.ts`
Expected: PASS (new cost tests + all existing D2a tests). If the shared-fixture sum makes the revert assertion flaky, switch the second test to a fresh job+estimate as the test note says.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/lifecycle/material-order.ts packages/db/src/lifecycle/material-order.test.ts
git commit -m "feat(db): material-order cost at generation + recompute job.costCents on status"
```

---

## Task 4: Web — supplier-cost field in the price-book editor

**Files:**
- Modify: `apps/web/src/lib/price-book-actions.ts`, `apps/web/src/lib/price-book-queries.ts`, `apps/web/src/app/(app)/settings/price-book/PriceBookClient.tsx`

**Interfaces:**
- Consumes: the `priceBookItem.unitCostCents` column.
- Produces: `updatePriceBookItem` accepts `unitCostCents`; the editor lets a user set it.

- [ ] **Step 1: Add `unitCostCents` to the update action**

In `apps/web/src/lib/price-book-actions.ts`, add `unitCostCents: number;` to the `updatePriceBookItem` input type and `unitCostCents: input.unitCostCents,` to the `.set({...})` object.

- [ ] **Step 2: Verify the query returns the column**

Read `apps/web/src/lib/price-book-queries.ts`. If it uses `tx.select()` (full row) it already returns `unitCostCents` — no change. If it uses an explicit column projection, add `unitCostCents: priceBookItem.unitCostCents` to it.

- [ ] **Step 3: Add the field to the editor**

Read `apps/web/src/app/(app)/settings/price-book/PriceBookClient.tsx`. Find where `unitPriceCents` is edited (a number input bound to per-row state) and the save handler that calls `updatePriceBookItem`. Add a parallel **"Supplier cost"** number input bound to a `unitCostCents` value (dollars in the UI, cents in the payload — mirror exactly how `unitPriceCents` converts), and include `unitCostCents` in the `updatePriceBookItem({...})` call. Use the same label/markup style and the dark-mode-safe tokens already in the file. Give the input `data-testid="pb-cost-input"`.

- [ ] **Step 4: Typecheck + lint the web app**

Run: `pnpm --filter web typecheck && pnpm --filter web lint`
Expected: typecheck clean; no new lint errors (remove any unused import you introduce).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/price-book-actions.ts apps/web/src/lib/price-book-queries.ts "apps/web/src/app/(app)/settings/price-book/PriceBookClient.tsx"
git commit -m "feat(web): supplier-cost field in the price-book editor"
```

---

## Task 5: Web — show cost on the Materials panel + e2e for real margin

**Files:**
- Modify: `apps/web/src/app/(app)/jobs/[id]/MaterialsPanel.tsx`, `apps/web/src/app/(app)/jobs/[id]/page.tsx`
- Test: `apps/web/tests/e2e/material-cost.spec.ts`

**Interfaces:**
- Consumes: `materialOrder.costSubtotalCents`; the now-populated `job.costCents`.
- Produces: the panel shows each order's cost subtotal; e2e proves `job.costCents` + the margin card.

- [ ] **Step 1: Serialize cost into the panel props**

In `apps/web/src/app/(app)/jobs/[id]/page.tsx`, add `costSubtotalCents: o.costSubtotalCents,` to the `materialOrdersForClient` mapping (the object passed per order).

- [ ] **Step 2: Render cost in the panel**

In `apps/web/src/app/(app)/jobs/[id]/MaterialsPanel.tsx`:
1. Add `costSubtotalCents: number;` to `MaterialsPanelOrder`.
2. Under the order's subtotal line, add a cost line (dark-mode-safe token):
```tsx
            <div className="flex items-center justify-between text-xs" data-testid="material-order-cost" style={{ color: "var(--text-faint)" }}>
              <span>Supplier cost</span>
              <span className="mono">{fmtUsd(o.costSubtotalCents)}</span>
            </div>
```
Place it directly after the `<div className="flex items-center justify-between">…subtotal…</div>` block, inside the same order card.

- [ ] **Step 3: Write the e2e**

Create `apps/web/tests/e2e/material-cost.spec.ts`:

```typescript
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { adminDb, customer, property, job, estimate, priceBookItem, materialOrder, eq } from "@savvy/db";

const { id: tenantId } = JSON.parse(readFileSync("/tmp/savvy-e2e-tenant.json", "utf8")) as { id: string };

async function waitFor<T>(fn: () => Promise<T | undefined>, ms = 15_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 300));
  }
}

test("material cost: generate -> mark ordered -> job.costCents + margin reflect supplier cost", async ({ page }) => {
  const stamp = randomUUID().slice(0, 8);
  const [cust] = await adminDb.insert(customer).values({ tenantId, name: `Cost ${stamp}`, email: `cost-${stamp}@e2e.test` }).returning();
  const [prop] = await adminDb.insert(property).values({ tenantId, customerId: cust!.id, address: `${stamp} Cost Way` }).returning();
  const [j] = await adminDb.insert(job).values({ tenantId, customerId: cust!.id, propertyId: prop!.id, type: "retail", stage: "production", valueFinal: 630000 }).returning();
  const jobId = j!.id;
  // Price-book cost for the material key used below (unique key per run to avoid the tenant unique index).
  const key = `shingles-${stamp}`;
  await adminDb.insert(priceBookItem).values({ tenantId, key, name: "Shingles", category: "material", unit: "square", unitPriceCents: 12000, unitCostCents: 7800 });
  await adminDb.insert(estimate).values({
    tenantId, jobId, status: "accepted", total: 630000, acceptedAt: new Date(),
    lineItems: [
      { key, name: "Shingles", category: "material", unit: "square", quantity: 30, unitPriceCents: 12000, amountCents: 360000 },
      { key: "labor", name: "Install", category: "labor", unit: "square", quantity: 30, unitPriceCents: 9000, amountCents: 270000 },
    ],
  });

  await page.goto(`/jobs/${jobId}`);
  await expect(page.getByTestId("job-detail")).toBeVisible();
  await page.getByTestId("generate-material-order-btn").click();
  const order = await waitFor(async () => {
    const [row] = await adminDb.select().from(materialOrder).where(eq(materialOrder.jobId, jobId));
    return row ?? undefined;
  });
  expect(order.costSubtotalCents).toBe(30 * 7800);

  await page.getByTestId("advance-material-order-btn").click();
  const jobAfter = await waitFor(async () => {
    const [row] = await adminDb.select().from(job).where(eq(job.id, jobId));
    return row?.costCents === 30 * 7800 ? row : undefined;
  });
  expect(jobAfter.costCents).toBe(234000);

  // Margin card now shows real cost (revenue 6300 − cost 2340).
  await page.reload();
  await expect(page.getByTestId("job-margin")).toBeVisible();
  await expect(page.getByTestId("material-order-cost")).toBeVisible();
});
```

- [ ] **Step 4: Run the e2e**

Setup: `pnpm db:up && pnpm --filter @savvy/db db:migrate`, then from `apps/web`:
```bash
npx tsx tests/e2e/create-tenant.ts
export TEST_TENANT_ID=$(node -e "console.log(require('/tmp/savvy-e2e-tenant.json').id)")
./node_modules/.bin/playwright test tests/e2e/material-cost.spec.ts
```
Expected: PASS. (Inngest `ECONNREFUSED` is benign — the manual Generate + advance actions write synchronously.)

- [ ] **Step 5: Typecheck + lint**

Run: `pnpm --filter web typecheck && pnpm --filter web lint`
Expected: clean / no new errors.

- [ ] **Step 6: Commit**

```bash
git add "apps/web/src/app/(app)/jobs/[id]/MaterialsPanel.tsx" "apps/web/src/app/(app)/jobs/[id]/page.tsx" apps/web/tests/e2e/material-cost.spec.ts
git commit -m "feat(web): show supplier cost on materials panel + e2e for real job margin"
```

---

## Task 6: Docs + full verification

**Files:**
- Modify: `docs/jobs-pipeline.md`

- [ ] **Step 1: Document the cost/margin behavior**

Append to the Materials section of `docs/jobs-pipeline.md`:

```markdown
### Supplier cost → margin (D2c)

Each price-book item carries a **supplier cost** (`unit_cost_cents`) alongside
its list price (`unit_price_cents`), editable in **Settings → Price book**. When
a material order is generated, each material line is matched to the price book by
`key` and stamped with `unitCostCents` + `lineCostCents`; the order stores a
`cost_subtotal_cents`.

When a material order is marked **ordered** (or **delivered**), the job's
`cost_cents` is recomputed as the **sum** of `cost_subtotal_cents` across that
job's orders in `{ordered, delivered}` — so the cockpit **Money & margin** card
shows a real margin (`revenue − supplier cost`) and the commission basis
(`amount_paid − cost_cents`) becomes accurate. Canceling an order drops it from
the sum automatically (recompute, never increment). Material is currently the
only contributor to `job.cost_cents`.
```

- [ ] **Step 2: Full test suite**

Run: `pnpm test`
Expected: all packages green (core + db cost tests added).

- [ ] **Step 3: Typecheck + lint**

Run: `pnpm typecheck && pnpm lint`
Expected: typecheck clean; lint 0 errors.

- [ ] **Step 4: Commit**

```bash
git add docs/jobs-pipeline.md
git commit -m "docs(jobs): document supplier cost → margin (D2c)"
```

- [ ] **Step 5: Open the stacked PR**

```bash
git push -u origin jobs-d2c
gh pr create --base jobs-d2 --title "feat(jobs): D2c — supplier material cost → honest margin" --body "<summary; note: stacked on #60, retarget to main after it merges>"
```

---

## Self-Review notes

- **Spec coverage:** (1) supplier cost on price book → Task 1 (type+seed) + Task 2 (column) + Task 4 (editor). (2) cost on the material order → Task 1 (`attachMaterialCosts`) + Task 2 (`cost_subtotal_cents`) + Task 3 (generation). (3) write `job.costCents` → Task 3 (recompute on status). (4) honest margin surfaced → Task 5 (panel cost + e2e asserting `job.costCents` + margin card). All covered.
- **Backward compatibility:** `materialLinesFromEstimate` unchanged; new line/engine fields optional; new columns default 0 → D2a tests stay green. Confirmed.
- **Idempotency / revert:** `recomputeJobMaterialCost` is a SUM recompute filtered to `{ordered,delivered}` → re-running is stable and canceling reverts. Confirmed.
- **Type consistency:** `attachMaterialCosts` signature `(lines, costByKey) → { lines, costSubtotalCents }` is identical in Task 1 (def) and Task 3 (call). `unitCostCents`/`lineCostCents` names consistent across core, db, and web.
