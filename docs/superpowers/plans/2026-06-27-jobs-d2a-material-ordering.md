# Jobs D2a — Material Ordering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn an accepted estimate's `material` line items into a trackable `material_order` (a bill of materials) shown on the job cockpit, with a delivery date aligned to the crew install appointment, generated automatically on `estimate/accepted` and manually via a button.

**Architecture:** One `material_order` table with a jsonb `lineItems` array (mirrors `estimate`/`invoice`). Pure BOM logic lives in `@savvy/core` (status enum, line projection, subtotal, delivery-date math, delivery flag). DB lifecycle functions generate/advance orders. An Inngest function auto-generates on `estimate/accepted` (idempotent per estimate). A `MaterialsPanel` on the cockpit shows lines + subtotal + status + delivery flag, with a manual "Generate from estimate" action.

**Tech Stack:** TypeScript, Drizzle ORM + Postgres (RLS), Inngest, Next.js App Router (server actions), Vitest (core + db), Playwright (web e2e). pnpm + Turborepo monorepo.

## Global Constraints

- **Tenant isolation on every table + query.** The new `material_order` table has `tenant_id` and `tenantIsolation()` RLS. All lifecycle reads/writes go through `withTenant(tenantId, …)`.
- **List-price BOM, not cost.** The order subtotal uses price-book `unitPriceCents`. **Do NOT write it to `job.costCents`** — keep E-margin honest.
- **`DELIVERY_BUFFER_DAYS = 2`.** `neededByAt` = install date − 2 days; null when no crew appointment is scheduled.
- **Idempotency:** one `material_order` per `estimateId` (unique column); re-generating returns the existing row.
- **Material lines only:** a BOM line is an `EstimateLineItem` with `category === "material"`.
- **No `.js` extensions** in core/web/db **source** imports (Turbopack); **db `.test.ts` files DO use `.js`** import extensions. Inside `packages/core`, import `z` from `"./schemas"`.
- **`apps/web` is NOT in the vitest workspace** — web logic is verified by Playwright e2e only; pure logic must live in `@savvy/core`.
- **`packages/core/src/index.ts` is append-only `export *`** — add the new line at the end.
- Definition of done: `pnpm test && pnpm typecheck && pnpm lint` all green before PR; PR opened with `gh pr create --base main`.

---

## File Structure

**Create:**
- `packages/core/src/material-order.ts` — status enum, `MaterialOrderLine` type, pure helpers.
- `packages/core/src/material-order.test.ts` — unit tests.
- `packages/db/src/schema/procurement.ts` — `material_order` table.
- `packages/db/src/lifecycle/material-order.ts` — `createMaterialOrderFromEstimate`, `setMaterialOrderStatus`, `getJobInstallDate`.
- `packages/db/src/lifecycle/material-order.test.ts` — db tests (real Postgres).
- `packages/agents/src/functions/material-order.ts` — Inngest function on `estimate/accepted`.
- `apps/web/src/lib/material-queries.ts` — `listMaterialOrdersForJob`, `getJobInstallDateForJob`.
- `apps/web/src/lib/material-actions.ts` — `generateMaterialOrderAction`, `advanceMaterialOrderStatusAction`.
- `apps/web/src/app/(app)/jobs/[id]/MaterialsPanel.tsx` — cockpit client panel.
- `apps/web/tests/e2e/materials.spec.ts` — e2e.

**Modify:**
- `packages/core/src/index.ts` — append `export * from "./material-order"`.
- `packages/db/src/schema/enums.ts` — add `materialOrderStatusEnum`.
- `packages/db/src/schema/index.ts` — add `export * from "./procurement"`.
- `packages/db/src/index.ts` — export the three lifecycle functions.
- `packages/agents/src/index.ts` — import/export/register the new function.
- `apps/web/src/app/(app)/jobs/[id]/page.tsx` — fetch + render `<MaterialsPanel>`.
- `docs/jobs-pipeline.md` — add a Materials section.

---

## Task 1: Core — status enum, line type, and pure helpers

**Files:**
- Create: `packages/core/src/material-order.ts`
- Test: `packages/core/src/material-order.test.ts`
- Modify: `packages/core/src/index.ts` (append export)

**Interfaces:**
- Consumes: `EstimateLineItem` from `./estimate-engine`; `PriceBookUnit` from `./enums`.
- Produces:
  - `MATERIAL_ORDER_STATUS: readonly ["draft","ordered","delivered","canceled"]`
  - `type MaterialOrderStatus = (typeof MATERIAL_ORDER_STATUS)[number]`
  - `type MaterialOrderLine = { key: string; name: string; quantity: number; unit: PriceBookUnit; unitPriceCents: number; amountCents: number }`
  - `DELIVERY_BUFFER_DAYS: number` (= 2)
  - `materialLinesFromEstimate(lineItems: EstimateLineItem[]): MaterialOrderLine[]`
  - `materialOrderSubtotalCents(lines: MaterialOrderLine[]): number`
  - `neededByFromInstall(installAt: Date | null, bufferDays?: number): Date | null`
  - `materialDeliveryFlag(input: { neededByAt: Date | null; installAt: Date | null }): "none" | "no_install" | "misaligned"`

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/material-order.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import type { EstimateLineItem } from "./estimate-engine";
import {
  MATERIAL_ORDER_STATUS,
  DELIVERY_BUFFER_DAYS,
  materialLinesFromEstimate,
  materialOrderSubtotalCents,
  neededByFromInstall,
  materialDeliveryFlag,
  type MaterialOrderLine,
} from "./material-order";

const lineItems: EstimateLineItem[] = [
  { key: "shingles", name: "Architectural shingles", category: "material", unit: "square", quantity: 30, unitPriceCents: 12000, amountCents: 360000 },
  { key: "underlayment", name: "Synthetic underlayment", category: "material", unit: "square", quantity: 30, unitPriceCents: 2000, amountCents: 60000 },
  { key: "labor", name: "Tear-off + install", category: "labor", unit: "square", quantity: 30, unitPriceCents: 9000, amountCents: 270000 },
  { key: "ridgevent", name: "Ridge vent", category: "accessory", unit: "lf", quantity: 40, unitPriceCents: 800, amountCents: 32000 },
];

describe("MATERIAL_ORDER_STATUS", () => {
  it("is the four-state lifecycle", () => {
    expect(MATERIAL_ORDER_STATUS).toEqual(["draft", "ordered", "delivered", "canceled"]);
  });
});

describe("materialLinesFromEstimate", () => {
  it("keeps only material lines and projects the BOM fields", () => {
    const lines = materialLinesFromEstimate(lineItems);
    expect(lines.map((l) => l.key)).toEqual(["shingles", "underlayment"]);
    expect(lines[0]).toEqual({
      key: "shingles", name: "Architectural shingles", quantity: 30,
      unit: "square", unitPriceCents: 12000, amountCents: 360000,
    } satisfies MaterialOrderLine);
  });
  it("returns [] when there are no material lines", () => {
    expect(materialLinesFromEstimate([lineItems[2]!])).toEqual([]);
  });
});

describe("materialOrderSubtotalCents", () => {
  it("sums line amountCents", () => {
    expect(materialOrderSubtotalCents(materialLinesFromEstimate(lineItems))).toBe(420000);
  });
  it("is 0 for no lines", () => {
    expect(materialOrderSubtotalCents([])).toBe(0);
  });
});

describe("neededByFromInstall", () => {
  it("subtracts the buffer days from the install date", () => {
    const install = new Date("2026-07-10T00:00:00.000Z");
    expect(neededByFromInstall(install)).toEqual(new Date("2026-07-08T00:00:00.000Z"));
    expect(DELIVERY_BUFFER_DAYS).toBe(2);
  });
  it("returns null when there is no install date", () => {
    expect(neededByFromInstall(null)).toBeNull();
  });
});

describe("materialDeliveryFlag", () => {
  it("no_install when nothing is scheduled", () => {
    expect(materialDeliveryFlag({ neededByAt: null, installAt: null })).toBe("no_install");
  });
  it("no_install when there is no needed-by even if install exists", () => {
    expect(materialDeliveryFlag({ neededByAt: null, installAt: new Date("2026-07-10T00:00:00Z") })).toBe("no_install");
  });
  it("misaligned when delivery target is after the install date", () => {
    expect(materialDeliveryFlag({
      neededByAt: new Date("2026-07-11T00:00:00Z"),
      installAt: new Date("2026-07-10T00:00:00Z"),
    })).toBe("misaligned");
  });
  it("none when delivery lands on or before install", () => {
    expect(materialDeliveryFlag({
      neededByAt: new Date("2026-07-08T00:00:00Z"),
      installAt: new Date("2026-07-10T00:00:00Z"),
    })).toBe("none");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @savvy/core exec vitest run src/material-order.test.ts`
Expected: FAIL — cannot find module `./material-order`.

- [ ] **Step 3: Write the implementation**

Create `packages/core/src/material-order.ts`:

```typescript
import type { EstimateLineItem } from "./estimate-engine";
import type { PriceBookUnit } from "./enums";

export const MATERIAL_ORDER_STATUS = ["draft", "ordered", "delivered", "canceled"] as const;
export type MaterialOrderStatus = (typeof MATERIAL_ORDER_STATUS)[number];

/** A bill-of-materials line: a projection of an EstimateLineItem (no category/waste/pitch). */
export type MaterialOrderLine = {
  key: string;
  name: string;
  quantity: number;
  unit: PriceBookUnit;
  unitPriceCents: number;
  amountCents: number;
};

/** Days of lead time the supplier needs before the crew install date. */
export const DELIVERY_BUFFER_DAYS = 2;

/** Keep only material lines and drop the non-BOM fields. */
export function materialLinesFromEstimate(lineItems: EstimateLineItem[]): MaterialOrderLine[] {
  return lineItems
    .filter((l) => l.category === "material")
    .map((l) => ({
      key: l.key,
      name: l.name,
      quantity: l.quantity,
      unit: l.unit,
      unitPriceCents: l.unitPriceCents,
      amountCents: l.amountCents,
    }));
}

/** List-price BOM subtotal: sum of line amounts (what the homeowner is charged, NOT cost). */
export function materialOrderSubtotalCents(lines: MaterialOrderLine[]): number {
  return lines.reduce((sum, l) => sum + l.amountCents, 0);
}

/** Delivery target = install date − buffer days. Null when there is no install date. */
export function neededByFromInstall(installAt: Date | null, bufferDays: number = DELIVERY_BUFFER_DAYS): Date | null {
  if (!installAt) return null;
  return new Date(installAt.getTime() - bufferDays * 86_400_000);
}

/** Derived delivery health for the cockpit (not stored). */
export function materialDeliveryFlag(input: { neededByAt: Date | null; installAt: Date | null }): "none" | "no_install" | "misaligned" {
  if (!input.installAt || !input.neededByAt) return "no_install";
  return input.neededByAt.getTime() > input.installAt.getTime() ? "misaligned" : "none";
}
```

- [ ] **Step 4: Append the export**

In `packages/core/src/index.ts`, add at the end:

```typescript
export * from "./material-order";
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @savvy/core exec vitest run src/material-order.test.ts`
Expected: PASS (all cases green).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/material-order.ts packages/core/src/material-order.test.ts packages/core/src/index.ts
git commit -m "feat(core): material-order BOM helpers (lines/subtotal/needed-by/flag)"
```

---

## Task 2: DB schema — `material_order` table + migration

**Files:**
- Modify: `packages/db/src/schema/enums.ts` (add `materialOrderStatusEnum`)
- Create: `packages/db/src/schema/procurement.ts`
- Modify: `packages/db/src/schema/index.ts` (export procurement)

**Interfaces:**
- Consumes: `MATERIAL_ORDER_STATUS`, `MaterialOrderLine` from `@savvy/core`; `idCol`, `createdAt`, `tenantIsolation` from `./_rls`; `tenant` from `./tenancy`; `job` from `./jobs`; `estimate` from `./finance`.
- Produces: `material_order` Drizzle table export; `materialOrderStatusEnum`.

- [ ] **Step 1: Add the pg enum**

In `packages/db/src/schema/enums.ts`, add `MATERIAL_ORDER_STATUS` to the import from `@savvy/core` (the existing destructured import), then add after `stormCertStatusEnum`:

```typescript
export const materialOrderStatusEnum = pgEnum("material_order_status", MATERIAL_ORDER_STATUS);
```

- [ ] **Step 2: Create the table**

Create `packages/db/src/schema/procurement.ts`:

```typescript
import { pgTable, uuid, integer, jsonb, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { idCol, createdAt, tenantIsolation } from "./_rls";
import { tenant } from "./tenancy";
import { job } from "./jobs";
import { estimate } from "./finance";
import { materialOrderStatusEnum } from "./enums";
import type { MaterialOrderLine } from "@savvy/core";

// A bill of materials generated from an accepted estimate's material lines.
// List-price BOM (price-book unit price), NOT supplier cost — do not feed
// job.costCents. One order per estimate (estimate_id unique).
export const materialOrder = pgTable("material_order", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  jobId: uuid("job_id").notNull().references(() => job.id),
  estimateId: uuid("estimate_id").notNull().references(() => estimate.id),
  status: materialOrderStatusEnum("status").notNull().default("draft"),
  lineItems: jsonb("line_items").$type<MaterialOrderLine[]>().default([]).notNull(),
  subtotalCents: integer("subtotal_cents").notNull().default(0),
  neededByAt: timestamp("needed_by_at", { withTimezone: true }),
  orderedAt: timestamp("ordered_at", { withTimezone: true }),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [
  index("material_order_tenant_job_idx").on(t.tenantId, t.jobId),
  index("material_order_tenant_status_idx").on(t.tenantId, t.status),
  uniqueIndex("material_order_estimate_uniq").on(t.estimateId),
  tenantIsolation(),
]);
```

- [ ] **Step 3: Export the schema**

In `packages/db/src/schema/index.ts`, add (keep alphabetical-ish with the others — append is fine):

```typescript
export * from "./procurement";
```

- [ ] **Step 4: Generate the migration**

Run: `pnpm db:generate`
Expected: a new `packages/db/drizzle/00XX_*.sql` file is created.

- [ ] **Step 5: Inspect the migration**

Open the newest file in `packages/db/drizzle/`. Verify it: creates type `material_order_status`, creates table `material_order` with the columns above, the two indexes + the unique index on `estimate_id`, the three FKs, and an `ALTER TABLE material_order ENABLE ROW LEVEL SECURITY` + a `tenant_isolation` policy `TO savvy_app`. If the RLS policy or `ENABLE ROW LEVEL SECURITY` is missing, the `tenantIsolation()` extra was dropped — fix and re-generate.

- [ ] **Step 6: Apply the migration**

Run: `pnpm db:up && pnpm --filter @savvy/db db:migrate`
Expected: migration applies cleanly (idempotent if already applied).

- [ ] **Step 7: Typecheck**

Run: `pnpm --filter @savvy/db typecheck`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add packages/db/src/schema/enums.ts packages/db/src/schema/procurement.ts packages/db/src/schema/index.ts packages/db/drizzle/
git commit -m "feat(db): material_order table + material_order_status enum + migration"
```

---

## Task 3: DB lifecycle — generate / advance / install-date

**Files:**
- Create: `packages/db/src/lifecycle/material-order.ts`
- Test: `packages/db/src/lifecycle/material-order.test.ts`
- Modify: `packages/db/src/index.ts` (export the three functions)

**Interfaces:**
- Consumes: `withTenant` from `../tenant`; `materialOrder` from `../schema/procurement`; `estimate` from `../schema/finance`; `appointment` from `../schema/comms`; `materialLinesFromEstimate`, `materialOrderSubtotalCents`, `neededByFromInstall`, `type EstimateLineItem`, `type MaterialOrderStatus` from `@savvy/core`; `and`, `eq`, `asc`, `sql` from `drizzle-orm`.
- Produces:
  - `type MaterialOrderRow = typeof materialOrder.$inferSelect`
  - `getJobInstallDate(tenantId: string, jobId: string): Promise<Date | null>`
  - `createMaterialOrderFromEstimate(input: { tenantId: string; estimateId: string }): Promise<MaterialOrderRow | null>`
  - `setMaterialOrderStatus(input: { tenantId: string; materialOrderId: string; status: MaterialOrderStatus }): Promise<MaterialOrderRow>`

- [ ] **Step 1: Write the failing test**

Create `packages/db/src/lifecycle/material-order.test.ts`:

```typescript
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { adminDb, adminPool } from "../admin-client.js";
import { pool } from "../client.js";
import { tenant, customer, property, job, estimate, appointment, materialOrder } from "../schema/index.js";
import { createMaterialOrderFromEstimate, setMaterialOrderStatus, getJobInstallDate } from "./material-order.js";

let tId: string, custId: string, jobId: string;

const LINE_ITEMS = [
  { key: "shingles", name: "Shingles", category: "material", unit: "square", quantity: 30, unitPriceCents: 12000, amountCents: 360000 },
  { key: "labor", name: "Install", category: "labor", unit: "square", quantity: 30, unitPriceCents: 9000, amountCents: 270000 },
];

beforeAll(async () => {
  const [t] = await adminDb.insert(tenant).values({ name: "MO", publicKey: "mo", clerkOrgId: "org_mo" }).returning();
  tId = t!.id;
  const [c] = await adminDb.insert(customer).values({ tenantId: tId, name: "Mo", email: "mo@x.com" }).returning();
  custId = c!.id;
  const [p] = await adminDb.insert(property).values({ tenantId: tId, customerId: custId, address: "1 Mat St" }).returning();
  const [j] = await adminDb.insert(job).values({ tenantId: tId, customerId: custId, propertyId: p!.id }).returning();
  jobId = j!.id;
});

afterAll(async () => {
  await adminDb.delete(materialOrder).where(eq(materialOrder.tenantId, tId));
  await adminDb.delete(appointment).where(eq(appointment.tenantId, tId));
  await adminDb.delete(estimate).where(eq(estimate.tenantId, tId));
  await adminDb.delete(job).where(eq(job.tenantId, tId));
  await adminDb.delete(property).where(eq(property.tenantId, tId));
  await adminDb.delete(customer).where(eq(customer.tenantId, tId));
  await adminDb.delete(tenant).where(eq(tenant.id, tId));
  await pool.end();
  await adminPool.end();
});

async function newEstimate() {
  const [e] = await adminDb.insert(estimate).values({
    tenantId: tId, jobId, status: "accepted", lineItems: LINE_ITEMS, total: 630000,
  }).returning();
  return e!;
}

describe("createMaterialOrderFromEstimate", () => {
  it("creates a draft order from material lines only, no install -> neededByAt null", async () => {
    const e = await newEstimate();
    const order = await createMaterialOrderFromEstimate({ tenantId: tId, estimateId: e.id });
    expect(order).not.toBeNull();
    expect(order!.status).toBe("draft");
    expect(order!.lineItems.map((l) => l.key)).toEqual(["shingles"]);
    expect(order!.subtotalCents).toBe(360000);
    expect(order!.neededByAt).toBeNull();
  });

  it("is idempotent per estimate (returns the existing order)", async () => {
    const e = await newEstimate();
    const first = await createMaterialOrderFromEstimate({ tenantId: tId, estimateId: e.id });
    const second = await createMaterialOrderFromEstimate({ tenantId: tId, estimateId: e.id });
    expect(second!.id).toBe(first!.id);
    const rows = await adminDb.select().from(materialOrder).where(eq(materialOrder.estimateId, e.id));
    expect(rows.length).toBe(1);
  });

  it("aligns neededByAt to install date minus 2 days", async () => {
    const e = await newEstimate();
    const install = new Date("2026-08-20T15:00:00.000Z");
    await adminDb.insert(appointment).values({
      tenantId: tId, jobId, type: "crew", status: "scheduled",
      startsAt: install, endsAt: new Date(install.getTime() + 3_600_000),
    });
    const order = await createMaterialOrderFromEstimate({ tenantId: tId, estimateId: e.id });
    expect(order!.neededByAt?.toISOString()).toBe(new Date("2026-08-18T15:00:00.000Z").toISOString());
  });

  it("returns null for a missing estimate", async () => {
    expect(await createMaterialOrderFromEstimate({ tenantId: tId, estimateId: "00000000-0000-0000-0000-000000000000" })).toBeNull();
  });
});

describe("setMaterialOrderStatus", () => {
  it("ordered sets orderedAt; delivered sets deliveredAt", async () => {
    const e = await newEstimate();
    const order = await createMaterialOrderFromEstimate({ tenantId: tId, estimateId: e.id });
    const ordered = await setMaterialOrderStatus({ tenantId: tId, materialOrderId: order!.id, status: "ordered" });
    expect(ordered.status).toBe("ordered");
    expect(ordered.orderedAt).not.toBeNull();
    const delivered = await setMaterialOrderStatus({ tenantId: tId, materialOrderId: order!.id, status: "delivered" });
    expect(delivered.status).toBe("delivered");
    expect(delivered.deliveredAt).not.toBeNull();
  });
});

describe("getJobInstallDate", () => {
  it("returns null with no crew appointment", async () => {
    const [c] = await adminDb.insert(customer).values({ tenantId: tId, name: "NoInstall" }).returning();
    const [p] = await adminDb.insert(property).values({ tenantId: tId, customerId: c!.id, address: "9 St" }).returning();
    const [j] = await adminDb.insert(job).values({ tenantId: tId, customerId: c!.id, propertyId: p!.id }).returning();
    expect(await getJobInstallDate(tId, j!.id)).toBeNull();
  });

  it("returns the earliest scheduled crew appointment startsAt", async () => {
    const [c] = await adminDb.insert(customer).values({ tenantId: tId, name: "TwoAppts" }).returning();
    const [p] = await adminDb.insert(property).values({ tenantId: tId, customerId: c!.id, address: "10 St" }).returning();
    const [j] = await adminDb.insert(job).values({ tenantId: tId, customerId: c!.id, propertyId: p!.id }).returning();
    const early = new Date("2026-09-01T12:00:00.000Z");
    const late = new Date("2026-09-05T12:00:00.000Z");
    await adminDb.insert(appointment).values([
      { tenantId: tId, jobId: j!.id, type: "crew", status: "scheduled", startsAt: late, endsAt: new Date(late.getTime() + 3_600_000) },
      { tenantId: tId, jobId: j!.id, type: "crew", status: "scheduled", startsAt: early, endsAt: new Date(early.getTime() + 3_600_000) },
    ]);
    expect((await getJobInstallDate(tId, j!.id))?.toISOString()).toBe(early.toISOString());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @savvy/db exec vitest run src/lifecycle/material-order.test.ts`
Expected: FAIL — cannot find module `./material-order.js`.

- [ ] **Step 3: Write the implementation**

Create `packages/db/src/lifecycle/material-order.ts`:

```typescript
import { withTenant } from "../tenant";
import { materialOrder } from "../schema/procurement";
import { estimate } from "../schema/finance";
import { appointment } from "../schema/comms";
import { and, eq, asc, sql } from "drizzle-orm";
import {
  materialLinesFromEstimate,
  materialOrderSubtotalCents,
  neededByFromInstall,
  type EstimateLineItem,
  type MaterialOrderStatus,
} from "@savvy/core";

export type MaterialOrderRow = typeof materialOrder.$inferSelect;

/** Internal: earliest scheduled crew (install) appointment startsAt for a job, within a tx. */
async function earliestCrewInstallAt(
  tx: Parameters<Parameters<typeof withTenant>[1]>[0],
  jobId: string,
): Promise<Date | null> {
  const [appt] = await tx
    .select({ startsAt: appointment.startsAt })
    .from(appointment)
    .where(and(eq(appointment.jobId, jobId), eq(appointment.type, "crew"), eq(appointment.status, "scheduled")))
    .orderBy(asc(appointment.startsAt))
    .limit(1);
  return appt?.startsAt ?? null;
}

/** Earliest scheduled crew install date for a job (the install date). */
export async function getJobInstallDate(tenantId: string, jobId: string): Promise<Date | null> {
  return withTenant(tenantId, (tx) => earliestCrewInstallAt(tx, jobId));
}

/**
 * Generate a material order from an accepted estimate's material lines.
 * Idempotent per estimate: if one already exists it is returned unchanged.
 * Returns null when the estimate does not exist.
 */
export async function createMaterialOrderFromEstimate(input: {
  tenantId: string; estimateId: string;
}): Promise<MaterialOrderRow | null> {
  return withTenant(input.tenantId, async (tx) => {
    const [est] = await tx.select().from(estimate).where(eq(estimate.id, input.estimateId));
    if (!est) return null;

    const [existing] = await tx.select().from(materialOrder).where(eq(materialOrder.estimateId, input.estimateId));
    if (existing) return existing;

    const lines = materialLinesFromEstimate((est.lineItems ?? []) as EstimateLineItem[]);
    const subtotalCents = materialOrderSubtotalCents(lines);
    const installAt = await earliestCrewInstallAt(tx, est.jobId);
    const neededByAt = neededByFromInstall(installAt);

    const [row] = await tx.insert(materialOrder).values({
      tenantId: input.tenantId,
      jobId: est.jobId,
      estimateId: input.estimateId,
      status: "draft",
      lineItems: lines,
      subtotalCents,
      neededByAt,
    }).returning();
    return row!;
  });
}

/** Advance a material order's status; stamps orderedAt/deliveredAt on the matching transition. */
export async function setMaterialOrderStatus(input: {
  tenantId: string; materialOrderId: string; status: MaterialOrderStatus;
}): Promise<MaterialOrderRow> {
  return withTenant(input.tenantId, async (tx) => {
    const patch: Record<string, unknown> = { status: input.status };
    if (input.status === "ordered") patch.orderedAt = sql`now()`;
    if (input.status === "delivered") patch.deliveredAt = sql`now()`;
    const [row] = await tx.update(materialOrder).set(patch).where(eq(materialOrder.id, input.materialOrderId)).returning();
    return row!;
  });
}
```

- [ ] **Step 4: Export from the db package root**

In `packages/db/src/index.ts`, add near the other lifecycle exports:

```typescript
export { createMaterialOrderFromEstimate, setMaterialOrderStatus, getJobInstallDate, type MaterialOrderRow } from "./lifecycle/material-order";
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @savvy/db exec vitest run src/lifecycle/material-order.test.ts`
Expected: PASS. (Requires the docker DB up + migrated from Task 2. If `ECONNREFUSED`, run `pnpm db:up && pnpm --filter @savvy/db db:migrate` first.)

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/lifecycle/material-order.ts packages/db/src/lifecycle/material-order.test.ts packages/db/src/index.ts
git commit -m "feat(db): createMaterialOrderFromEstimate/setMaterialOrderStatus/getJobInstallDate"
```

---

## Task 4: Agents — auto-generate on `estimate/accepted`

**Files:**
- Create: `packages/agents/src/functions/material-order.ts`
- Modify: `packages/agents/src/index.ts` (import + export + add to `functions` array)

**Interfaces:**
- Consumes: `createMaterialOrderFromEstimate` from `@savvy/db`; `inngest` from `../client`; event `"estimate/accepted": { data: { tenantId: string; estimateId: string } }`.
- Produces: `createMaterialOrderOnAccepted` Inngest function.

- [ ] **Step 1: Write the function**

Create `packages/agents/src/functions/material-order.ts` (mirror `estimateAcceptedAdvanceJob` in `functions/estimate-sign.ts`):

```typescript
import { createMaterialOrderFromEstimate } from "@savvy/db";
import { inngest } from "../client";

// Auto-generate the material order (BOM) when an estimate is accepted.
// Idempotent: createMaterialOrderFromEstimate returns the existing order on replay.
export const createMaterialOrderOnAccepted = inngest.createFunction(
  { id: "create-material-order-on-accepted", concurrency: { limit: 5 } },
  { event: "estimate/accepted" },
  async ({ event, step }) =>
    step.run("create-material-order", () =>
      createMaterialOrderFromEstimate({ tenantId: event.data.tenantId, estimateId: event.data.estimateId }),
    ),
);
```

- [ ] **Step 2: Register the function**

In `packages/agents/src/index.ts`:
1. Add an import alongside the others:
   ```typescript
   import { createMaterialOrderOnAccepted } from "./functions/material-order";
   ```
2. Add an export alongside the others:
   ```typescript
   export { createMaterialOrderOnAccepted } from "./functions/material-order";
   ```
3. Add it to the `functions` array (append before the closing `]`):
   ```typescript
   createMaterialOrderOnAccepted,
   ```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @savvy/agents typecheck`
Expected: clean. (`estimate/accepted` already has another consumer — a second one is fine.)

- [ ] **Step 4: Commit**

```bash
git add packages/agents/src/functions/material-order.ts packages/agents/src/index.ts
git commit -m "feat(agents): auto-generate material order on estimate/accepted (idempotent)"
```

---

## Task 5: Web — queries, actions, MaterialsPanel, cockpit wiring

**Files:**
- Create: `apps/web/src/lib/material-queries.ts`
- Create: `apps/web/src/lib/material-actions.ts`
- Create: `apps/web/src/app/(app)/jobs/[id]/MaterialsPanel.tsx`
- Modify: `apps/web/src/app/(app)/jobs/[id]/page.tsx` (fetch + render)
- Test: `apps/web/tests/e2e/materials.spec.ts`

**Interfaces:**
- Consumes: Task 3's `listMaterialOrdersForJob`/`getJobInstallDate` via `@savvy/db`; `materialDeliveryFlag` from `@savvy/core`; `getTenantId` from `./tenant`; existing cockpit `Card`/`StatusBadge`/`fmtUsd` components.
- Produces: `MaterialsPanel` component; `generateMaterialOrderAction`, `advanceMaterialOrderStatusAction` server actions.

- [ ] **Step 1: Create the query module**

Create `apps/web/src/lib/material-queries.ts`:

```typescript
import "server-only";
import { withTenant, materialOrder, eq, desc, getJobInstallDate } from "@savvy/db";
import { getTenantId } from "./tenant";

export async function listMaterialOrdersForJob(jobId: string) {
  const tenantId = await getTenantId();
  return withTenant(tenantId, (tx) =>
    tx.select().from(materialOrder).where(eq(materialOrder.jobId, jobId)).orderBy(desc(materialOrder.createdAt)),
  );
}

export async function getJobInstallDateForJob(jobId: string) {
  const tenantId = await getTenantId();
  return getJobInstallDate(tenantId, jobId);
}
```

- [ ] **Step 2: Create the server actions**

Create `apps/web/src/lib/material-actions.ts`:

```typescript
"use server";
import { revalidatePath } from "next/cache";
import { withTenant, estimate, job, and, eq, desc, createMaterialOrderFromEstimate, setMaterialOrderStatus } from "@savvy/db";
import type { MaterialOrderStatus } from "@savvy/core";
import { getTenantId } from "./tenant";

/** Generate a material order from the job's latest accepted estimate. */
export async function generateMaterialOrderAction(input: { jobId: string }) {
  const tenantId = await getTenantId();
  const est = await withTenant(tenantId, async (tx) => {
    const [e] = await tx.select({ id: estimate.id })
      .from(estimate)
      .where(and(eq(estimate.jobId, input.jobId), eq(estimate.status, "accepted")))
      .orderBy(desc(estimate.acceptedAt))
      .limit(1);
    return e ?? null;
  });
  if (!est) return { error: "no_accepted_estimate" as const };
  const order = await createMaterialOrderFromEstimate({ tenantId, estimateId: est.id });
  if (!order) return { error: "no_accepted_estimate" as const };
  revalidatePath(`/jobs/${input.jobId}`);
  return { ok: true as const, id: order.id };
}

export async function advanceMaterialOrderStatusAction(input: {
  materialOrderId: string; jobId: string; status: MaterialOrderStatus;
}) {
  const tenantId = await getTenantId();
  await setMaterialOrderStatus({ tenantId, materialOrderId: input.materialOrderId, status: input.status });
  revalidatePath(`/jobs/${input.jobId}`);
  return { ok: true as const };
}
```

Note: `job` is imported only if needed; remove it if lint flags it unused. Keep imports minimal — the action only needs `estimate`.

- [ ] **Step 3: Create the MaterialsPanel client component**

Create `apps/web/src/app/(app)/jobs/[id]/MaterialsPanel.tsx`:

```tsx
"use client";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/cockpit/StatusBadge";
import { fmtUsd } from "@/lib/format";
import { generateMaterialOrderAction, advanceMaterialOrderStatusAction } from "@/lib/material-actions";

export type MaterialsPanelLine = { key: string; name: string; quantity: number; unit: string; amountCents: number };
export type MaterialsPanelOrder = {
  id: string;
  status: string;
  subtotalCents: number;
  neededByISO: string | null;
  lines: MaterialsPanelLine[];
  flag: "none" | "no_install" | "misaligned";
};

const FLAG_COPY: Record<MaterialsPanelOrder["flag"], string | null> = {
  none: null,
  no_install: "No install scheduled — set a crew date to align delivery.",
  misaligned: "⚠ Delivery target is after the install date.",
};

const NEXT_STATUS: Record<string, "ordered" | "delivered" | null> = {
  draft: "ordered",
  ordered: "delivered",
  delivered: null,
  canceled: null,
};

export function MaterialsPanel({ jobId, orders }: { jobId: string; orders: MaterialsPanelOrder[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();

  function handleGenerate() {
    start(async () => {
      await generateMaterialOrderAction({ jobId });
      router.refresh();
    });
  }
  function handleAdvance(materialOrderId: string, status: "ordered" | "delivered") {
    start(async () => {
      await advanceMaterialOrderStatusAction({ materialOrderId, jobId, status });
      router.refresh();
    });
  }

  return (
    <div className="space-y-4" data-testid="materials-panel">
      <Button size="sm" variant="outline" disabled={pending} onClick={handleGenerate} data-testid="generate-material-order-btn">
        {pending ? "Working…" : "Generate from estimate"}
      </Button>

      {orders.length === 0 && (
        <p className="text-sm" style={{ color: "var(--text-faint)" }}>
          No material order yet. Generate one from the accepted estimate.
        </p>
      )}

      {orders.map((o) => {
        const next = NEXT_STATUS[o.status] ?? null;
        const flagCopy = FLAG_COPY[o.flag];
        return (
          <div key={o.id} className="rounded-md border border-border p-3 space-y-2" data-testid="material-order">
            <div className="flex items-center justify-between">
              <StatusBadge status={o.status} />
              <span className="mono font-medium text-accent-gold" data-testid="material-order-subtotal">{fmtUsd(o.subtotalCents)}</span>
            </div>
            <ul className="space-y-1 text-sm">
              {o.lines.map((l) => (
                <li key={l.key} className="flex items-center justify-between" data-testid="material-order-line">
                  <span style={{ color: "var(--text-muted)" }}>{l.name} · {l.quantity} {l.unit}</span>
                  <span className="mono">{fmtUsd(l.amountCents)}</span>
                </li>
              ))}
            </ul>
            {flagCopy && (
              <p className="text-xs" data-testid="material-order-flag" style={{ color: "var(--text-faint)" }}>{flagCopy}</p>
            )}
            {next && (
              <Button size="sm" variant="outline" disabled={pending} onClick={() => handleAdvance(o.id, next)} data-testid="advance-material-order-btn">
                {next === "ordered" ? "Mark ordered" : "Mark delivered"}
              </Button>
            )}
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 4: Wire the panel into the cockpit page**

In `apps/web/src/app/(app)/jobs/[id]/page.tsx`:

1. Add imports near the other cockpit imports (top of file):
   ```typescript
   import { listMaterialOrdersForJob, getJobInstallDateForJob } from "@/lib/material-queries";
   import { MaterialsPanel, type MaterialsPanelOrder } from "./MaterialsPanel";
   import { materialDeliveryFlag } from "@savvy/core";
   ```

2. Add the two fetches to the existing `Promise.all` (the one that loads `estimates`, `measurement`, `changeOrders`, `checkins`):
   ```typescript
   const [estimates, measurement, changeOrders, checkins, materialOrders, installDate] = await Promise.all([
     listEstimatesForJob(id),
     getLatestMeasurementForJob(id),
     listChangeOrdersForJob(id),
     getJobCheckins(tenantId, id),
     listMaterialOrdersForJob(id),
     getJobInstallDateForJob(id),
   ]);
   ```

3. After the fetches, serialize the orders + compute the delivery flag server-side:
   ```typescript
   const materialOrdersForClient: MaterialsPanelOrder[] = materialOrders.map((o) => ({
     id: o.id,
     status: o.status,
     subtotalCents: o.subtotalCents,
     neededByISO: o.neededByAt ? o.neededByAt.toISOString() : null,
     lines: o.lineItems.map((l) => ({ key: l.key, name: l.name, quantity: l.quantity, unit: l.unit, amountCents: l.amountCents })),
     flag: materialDeliveryFlag({ neededByAt: o.neededByAt ?? null, installAt: installDate }),
   }));
   ```

4. Add a Materials `<Card>` immediately after the Estimates `</Card>` (before the Change orders card):
   ```tsx
   {/* Materials section */}
   <Card>
     <CardHeader><CardTitle>Materials</CardTitle></CardHeader>
     <CardContent>
       <MaterialsPanel jobId={id} orders={materialOrdersForClient} />
     </CardContent>
   </Card>
   ```

- [ ] **Step 5: Typecheck the web app**

Run: `pnpm --filter web typecheck`
Expected: clean. (If `job`/other imports in `material-actions.ts` are unused, remove them.)

- [ ] **Step 6: Write the e2e test**

Create `apps/web/tests/e2e/materials.spec.ts`:

```typescript
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { adminDb, customer, property, job, estimate, appointment, materialOrder, eq } from "@savvy/db";

const { id: tenantId } = JSON.parse(readFileSync("/tmp/savvy-e2e-tenant.json", "utf8")) as { id: string };

const LINE_ITEMS = [
  { key: "shingles", name: "Shingles", category: "material", unit: "square", quantity: 30, unitPriceCents: 12000, amountCents: 360000 },
  { key: "labor", name: "Install", category: "labor", unit: "square", quantity: 30, unitPriceCents: 9000, amountCents: 270000 },
];

async function waitFor<T>(fn: () => Promise<T | undefined>, ms = 15_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 300));
  }
}

test("materials: generate from estimate -> shows material line only -> advance status", async ({ page }) => {
  const stamp = randomUUID().slice(0, 8);
  const [cust] = await adminDb.insert(customer).values({ tenantId, name: `Mat ${stamp}`, email: `mat-${stamp}@e2e.test` }).returning();
  const [prop] = await adminDb.insert(property).values({ tenantId, customerId: cust!.id, address: `${stamp} Mat Way` }).returning();
  const [j] = await adminDb.insert(job).values({ tenantId, customerId: cust!.id, propertyId: prop!.id, type: "retail", stage: "production" }).returning();
  const jobId = j!.id;
  await adminDb.insert(estimate).values({ tenantId, jobId, status: "accepted", lineItems: LINE_ITEMS, total: 630000, acceptedAt: new Date() });
  const install = new Date(Date.now() + 10 * 86_400_000);
  await adminDb.insert(appointment).values({ tenantId, jobId, type: "crew", status: "scheduled", startsAt: install, endsAt: new Date(install.getTime() + 3_600_000) });

  await page.goto(`/jobs/${jobId}`);
  await expect(page.getByTestId("job-detail")).toBeVisible();
  await page.getByTestId("generate-material-order-btn").click();

  const order = await waitFor(async () => {
    const [row] = await adminDb.select().from(materialOrder).where(eq(materialOrder.jobId, jobId));
    return row ?? undefined;
  });
  expect(order.lineItems.length).toBe(1);
  expect(order.lineItems[0]!.key).toBe("shingles");
  expect(order.subtotalCents).toBe(360000);
  expect(order.neededByAt).not.toBeNull();

  await expect(page.getByTestId("material-order")).toBeVisible();
  await expect(page.getByTestId("material-order-line")).toHaveCount(1);

  await page.getByTestId("advance-material-order-btn").click();
  await waitFor(async () => {
    const [row] = await adminDb.select().from(materialOrder).where(eq(materialOrder.id, order.id));
    return row?.status === "ordered" && row.orderedAt ? row : undefined;
  });
});
```

- [ ] **Step 7: Run the e2e test**

Setup (once): `pnpm db:up && pnpm --filter @savvy/db db:migrate`, then from `apps/web`:
```bash
npx tsx tests/e2e/create-tenant.ts
export TEST_TENANT_ID=$(node -e "console.log(require('/tmp/savvy-e2e-tenant.json').id)")
./node_modules/.bin/playwright test tests/e2e/materials.spec.ts
```
Expected: PASS. (An Inngest `ECONNREFUSED` log is benign — the manual Generate action writes synchronously.)

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/lib/material-queries.ts apps/web/src/lib/material-actions.ts "apps/web/src/app/(app)/jobs/[id]/MaterialsPanel.tsx" "apps/web/src/app/(app)/jobs/[id]/page.tsx" apps/web/tests/e2e/materials.spec.ts
git commit -m "feat(web): materials panel on job cockpit (generate + lines + status + delivery flag)"
```

---

## Task 6: Docs + full verification

**Files:**
- Modify: `docs/jobs-pipeline.md` (add a Materials section)

- [ ] **Step 1: Document the feature**

Append a section to `docs/jobs-pipeline.md`:

```markdown
## Materials (D2a — material ordering)

When an estimate is **accepted**, a `material_order` (bill of materials) is
generated from its `category:"material"` line items — automatically via the
`create-material-order-on-accepted` Inngest function, or manually with the
**Generate from estimate** button on the job cockpit's Materials card.

- **One order per estimate** (`estimate_id` is unique; re-generating returns the
  existing order).
- The order subtotal is a **list-price BOM** (price-book unit price, what the
  homeowner is charged) — it is deliberately **not** written to `job.costCents`,
  so the cockpit margin stays honest. True supplier cost is D2c.
- **`neededByAt`** = the crew install date − `DELIVERY_BUFFER_DAYS` (2). The
  install date is the earliest `appointment` with `type='crew'` and
  `status='scheduled'`. The cockpit shows a delivery flag: *no install
  scheduled* or *delivery after install*.
- Status lifecycle: `draft → ordered → delivered` (or `canceled`), advanced
  from the cockpit.
```

- [ ] **Step 2: Full test suite**

Run: `pnpm test`
Expected: all packages green (core + db). Note the prior baseline was 596 tests; this adds core + db cases.

- [ ] **Step 3: Typecheck + lint**

Run: `pnpm typecheck && pnpm lint`
Expected: typecheck clean, lint 0 errors.

- [ ] **Step 4: Commit**

```bash
git add docs/jobs-pipeline.md
git commit -m "docs(jobs): document material ordering (D2a)"
```

- [ ] **Step 5: Open the PR**

```bash
git push -u origin jobs-d2
gh pr create --base main --title "feat(jobs): D2a — material ordering" --body "<summary>"
```

---

## Self-Review notes

- **Spec coverage:** (1) `material_order` table + `createMaterialOrderFromEstimate` → Tasks 2+3. (2) Materials panel on cockpit → Task 5. (3) Delivery date aligned to install + misalignment flag → Task 1 (`neededByFromInstall`, `materialDeliveryFlag`), Task 3 (`getJobInstallDate`, wiring), Task 5 (display). (4) Auto-generate on `estimate/accepted` + manual button → Task 4 (Inngest) + Task 5 (button). All four D2a parts covered.
- **List-price-not-cost guarantee:** no task writes to `job.costCents`. Confirmed.
- **Type consistency:** `MaterialOrderLine`/`MaterialOrderStatus` defined in Task 1, consumed by Tasks 2/3/5 with the same names. `MaterialOrderRow` defined in Task 3, used in Task 3 only. `materialDeliveryFlag` signature `{ neededByAt, installAt }` consistent between Task 1 (def) and Task 5 (call).
- **Idempotency:** unique `estimate_id` (Task 2) + early-return-existing (Task 3) + Inngest replay-safe (Task 4).
