# Material-Delivery Exceptions (D2b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface material-delivery risk (D2a's `materialDeliveryFlag`) as a fifth vector in slice J's Exception Queue, so a misaligned or unscheduled material delivery appears in the tenant-wide `/exceptions` "needs you" worklist.

**Architecture:** Add a 5th exception vector to the pure `buildExceptionQueue` (`@savvy/core`), reusing the existing `materialDeliveryFlag` helper as the single source of truth. The web data layer (`exception-queries.ts`) gathers draft/ordered material orders + each job's current earliest crew-install date as a 5th inline drizzle query, exactly like the existing four. No new table, no new db lifecycle function, no new config.

**Tech Stack:** TypeScript, Drizzle ORM (Postgres + RLS), Vitest (core unit), Playwright (web e2e), Next.js App Router.

## Global Constraints

- **`.js` import rule:** db `.test.ts` files USE `.js` extensions on relative imports; core/web/db **source** files use NO `.js` (Turbopack). Inside `packages/core`, import other core modules with a plain relative path (e.g. `"./material-order"`).
- **apps/web is NOT in the vitest workspace** — verify the web layer via `pnpm typecheck` + Playwright e2e only. Put pure logic in `@savvy/core` (unit-tested).
- **`materialDeliveries` is a REQUIRED field** on `ExceptionQueueInput` (consistent with the other four vectors). This means every `buildExceptionQueue` caller must pass it — typecheck enforces this; find all callers.
- **Reuse `materialDeliveryFlag`** from `packages/core/src/material-order.ts` — do NOT reimplement the misaligned/no_install rule.
- **Severity:** `misaligned → "high"`, `no_install → "medium"`. **Statuses gathered:** `draft` and `ordered` only.
- **Never assert on `queue.total` in e2e** — the `/exceptions` page aggregates ALL tenant rows (shared e2e tenant); scope assertions to the stamped customer names you seed.
- **Tenant isolation:** the new query runs inside the existing `withTenant(tenantId, tx => …)` in `getExceptionQueue` — no RLS change, no new table.
- Focused test commands:
  - core → `pnpm --filter @savvy/core exec vitest run src/exception-queue.test.ts`
  - typecheck → `pnpm typecheck`
  - e2e → from `apps/web`: `npx tsx tests/e2e/create-tenant.ts && export TEST_TENANT_ID=$(node -e "console.log(require('/tmp/savvy-e2e-tenant.json').id)") && ./node_modules/.bin/playwright test tests/e2e/material-exceptions.spec.ts`
- Final gate: `pnpm test && pnpm typecheck && pnpm lint` all green.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `packages/core/src/exception-queue.ts` | 5th vector: `material_delivery` kind + `MaterialDeliveryInput` + loop | Modify |
| `packages/core/src/exception-queue.test.ts` | unit tests for the new vector + add field to existing inputs | Modify |
| `apps/web/src/lib/exception-queries.ts` | 5th inline query (material orders + crew-install subquery) → `materialDeliveries` | Modify |
| `apps/web/src/app/(app)/exceptions/page.tsx` | `KIND_LABEL` entry `material_delivery → "Materials"` | Modify |
| `apps/web/tests/e2e/material-exceptions.spec.ts` | e2e: seed misaligned + no-install orders, assert rows | Create |
| `docs/jobs-pipeline.md` | document the material-delivery exception vector | Modify |

---

## Task 1: Core — `material_delivery` exception vector (haiku)

**Files:**
- Modify: `packages/core/src/exception-queue.ts`
- Test: `packages/core/src/exception-queue.test.ts`

**Interfaces:**
- Consumes: `materialDeliveryFlag` from `./material-order`.
- Produces:
  - `ExceptionKind` gains `"material_delivery"`.
  - `MaterialDeliveryInput = { materialOrderId: string; jobId: string; customerName: string | null; neededByAt: Date | null; installAt: Date | null; createdAt: Date }`.
  - `ExceptionQueueInput` gains required `materialDeliveries: MaterialDeliveryInput[]`.

- [ ] **Step 1: Write the failing tests**

In `packages/core/src/exception-queue.test.ts`, first add `materialDeliveries: []` to EVERY existing `buildExceptionQueue({...})` call so the existing tests still compile (the field is required). Then append a new `describe` block:

```ts
describe("buildExceptionQueue material_delivery vector", () => {
  const base = { atRiskJobs: [], overdueInvoices: [], missedAppointments: [], overdueTasks: [] };
  const install = new Date("2026-07-10T17:00:00Z");

  it("emits a high item when the order is misaligned (neededBy after install)", () => {
    const q = buildExceptionQueue({
      ...base,
      materialDeliveries: [{
        materialOrderId: "mo1", jobId: "j1", customerName: "Misa Mary",
        neededByAt: new Date("2026-07-11T17:00:00Z"), installAt: install, createdAt: new Date("2026-07-01T00:00:00Z"),
      }],
    });
    const row = q.items.find((i) => i.kind === "material_delivery");
    expect(row).toBeTruthy();
    expect(row!.severity).toBe("high");
    expect(row!.title).toBe("Misa Mary");
    expect(row!.detail).toBe("Materials arrive after install");
    expect(row!.href).toBe("/jobs/j1");
    expect(row!.occurredAt).toEqual(install);
    expect(q.counts.material_delivery).toBe(1);
  });

  it("emits a medium item when there is no scheduled install", () => {
    const created = new Date("2026-07-02T00:00:00Z");
    const q = buildExceptionQueue({
      ...base,
      materialDeliveries: [{
        materialOrderId: "mo2", jobId: "j2", customerName: "Noin Ned",
        neededByAt: new Date("2026-07-09T17:00:00Z"), installAt: null, createdAt: created,
      }],
    });
    const row = q.items.find((i) => i.kind === "material_delivery");
    expect(row!.severity).toBe("medium");
    expect(row!.detail).toBe("No install scheduled for materials");
    expect(row!.occurredAt).toEqual(created);
  });

  it("omits an aligned order (neededBy on/before install)", () => {
    const q = buildExceptionQueue({
      ...base,
      materialDeliveries: [{
        materialOrderId: "mo3", jobId: "j3", customerName: "Fine Fran",
        neededByAt: new Date("2026-07-08T17:00:00Z"), installAt: install, createdAt: new Date(),
      }],
    });
    expect(q.items.some((i) => i.kind === "material_delivery")).toBe(false);
    expect(q.counts.material_delivery).toBe(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @savvy/core exec vitest run src/exception-queue.test.ts`
Expected: FAIL — `material_delivery` not assignable / `materialDeliveries` missing.

- [ ] **Step 3: Implement the vector**

In `packages/core/src/exception-queue.ts`:

(a) add the import at the top:

```ts
import { materialDeliveryFlag } from "./material-order";
```

(b) extend the kind union and `KINDS`:

```ts
export type ExceptionKind = "job_at_risk" | "invoice_overdue" | "appointment_missed" | "task_overdue" | "material_delivery";
```
```ts
const KINDS: ExceptionKind[] = ["job_at_risk", "invoice_overdue", "appointment_missed", "task_overdue", "material_delivery"];
```

(c) add the input type (next to the other `*Input` types):

```ts
export type MaterialDeliveryInput = { materialOrderId: string; jobId: string; customerName: string | null; neededByAt: Date | null; installAt: Date | null; createdAt: Date };
```

(d) add the field to `ExceptionQueueInput`:

```ts
export type ExceptionQueueInput = {
  atRiskJobs: AtRiskJobInput[];
  overdueInvoices: OverdueInvoiceInput[];
  missedAppointments: MissedAppointmentInput[];
  overdueTasks: OverdueTaskInput[];
  materialDeliveries: MaterialDeliveryInput[];
};
```

(e) add the loop AFTER the `overdueTasks` loop and BEFORE the `sevRank`/`items.sort` block:

```ts
  for (const m of input.materialDeliveries) {
    const flag = materialDeliveryFlag({ neededByAt: m.neededByAt, installAt: m.installAt });
    if (flag === "none") continue;
    const misaligned = flag === "misaligned";
    items.push({
      kind: "material_delivery",
      severity: misaligned ? "high" : "medium",
      title: m.customerName ?? "—",
      detail: misaligned ? "Materials arrive after install" : "No install scheduled for materials",
      href: `/jobs/${m.jobId}`,
      occurredAt: misaligned ? m.installAt : m.createdAt,
    });
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @savvy/core exec vitest run src/exception-queue.test.ts`
Expected: PASS (existing + 3 new). Output pristine.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/exception-queue.ts packages/core/src/exception-queue.test.ts
git commit -m "feat(core): material_delivery exception vector in buildExceptionQueue"
```

---

## Task 2: Web — gather material-delivery risks + page label (sonnet)

**Files:**
- Modify: `apps/web/src/lib/exception-queries.ts`
- Modify: `apps/web/src/app/(app)/exceptions/page.tsx`

**Interfaces:**
- Consumes: `MaterialDeliveryInput` shape (Task 1); `materialOrder`, `job`, `customer`, `appointment` from `@savvy/db`.
- Produces: `getExceptionQueue()` now passes a populated `materialDeliveries` to `buildExceptionQueue`.

- [ ] **Step 1: Add the 5th query in `getExceptionQueue`**

In `apps/web/src/lib/exception-queries.ts`:

(a) add `materialOrder` to the `@savvy/db` import (the line already imports `withTenant, job, invoice, appointment, jobTask, customer, tenant, eq, or, sql`):

```ts
import { withTenant, job, invoice, appointment, jobTask, customer, tenant, materialOrder, eq, or, sql } from "@savvy/db";
```

(b) add `MaterialDeliveryInput` to the `@savvy/core` type import on the next line (it currently imports `parseJobsConfig, deriveJobHealth, buildExceptionQueue, type JobStage, type JobType, type ExceptionQueue`):

```ts
import { parseJobsConfig, deriveJobHealth, buildExceptionQueue, type JobStage, type JobType, type ExceptionQueue, type MaterialDeliveryInput } from "@savvy/core";
```

(c) add this query block AFTER the `overdueTasks` block and BEFORE the final `return buildExceptionQueue(...)`:

```ts
    // --- material-delivery risk (draft/ordered orders vs current crew-install date) ---
    const moRows = await tx
      .select({
        id: materialOrder.id,
        jobId: materialOrder.jobId,
        neededByAt: materialOrder.neededByAt,
        createdAt: materialOrder.createdAt,
        customerName: customer.name,
        installAt: sql<string | null>`(select min(starts_at) from appointment where job_id = ${materialOrder.jobId} and type = 'crew' and status = 'scheduled')`,
      })
      .from(materialOrder)
      .leftJoin(job, eq(job.id, materialOrder.jobId))
      .leftJoin(customer, eq(customer.id, job.customerId))
      .where(or(eq(materialOrder.status, "draft"), eq(materialOrder.status, "ordered")));
    const materialDeliveries: MaterialDeliveryInput[] = moRows.map((r) => ({
      materialOrderId: r.id,
      jobId: r.jobId,
      customerName: r.customerName,
      neededByAt: r.neededByAt,
      installAt: r.installAt ? new Date(r.installAt) : null,
      createdAt: r.createdAt,
    }));
```

(d) update the final return to pass the new vector:

```ts
    return buildExceptionQueue({ atRiskJobs, overdueInvoices, missedAppointments, overdueTasks, materialDeliveries });
```

- [ ] **Step 2: Add the page label**

In `apps/web/src/app/(app)/exceptions/page.tsx`, add the entry to `KIND_LABEL`:

```ts
const KIND_LABEL: Record<string, string> = {
  job_at_risk: "Job at risk",
  invoice_overdue: "Invoice overdue",
  appointment_missed: "Appointment",
  task_overdue: "Task overdue",
  material_delivery: "Materials",
};
```

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: PASS — proves `materialDeliveries` is supplied everywhere `buildExceptionQueue` is called, and the query row types map cleanly to `MaterialDeliveryInput`.

Note: if `pnpm typecheck` reports another `buildExceptionQueue` caller missing `materialDeliveries`, that caller must also be updated to pass it (grep `buildExceptionQueue` across the repo). The only expected callers are `exception-queries.ts` and the core test.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/lib/exception-queries.ts "apps/web/src/app/(app)/exceptions/page.tsx"
git commit -m "feat(web): gather material-delivery risks into the exception queue + Materials label"
```

---

## Task 3: e2e + docs + full verification (sonnet)

**Files:**
- Create: `apps/web/tests/e2e/material-exceptions.spec.ts`
- Modify: `docs/jobs-pipeline.md`

- [ ] **Step 1: Write the e2e spec**

Create `apps/web/tests/e2e/material-exceptions.spec.ts`. It seeds two material orders via adminDb (mirror `materials.spec.ts` imports/seeding and `doc-gating.spec.ts` adminDb style), then asserts the `/exceptions` page shows a `Materials` row for each. Assertions are scoped to the stamped customer names — never to `queue.total`.

```ts
/**
 * e2e: material-delivery exceptions (D2b).
 *
 * Seeds (a) a MISALIGNED order — a scheduled crew appointment at T plus a
 * material_order whose neededByAt is T+1d (so the delivery target is after the
 * install) — and (b) a NO-INSTALL order — a material_order on a job with no crew
 * appointment. Then asserts /exceptions renders a "Materials" exception row for
 * each seeded (stamped) customer with the right detail + severity.
 *
 * Rows are seeded via adminDb (no R2 / no UI). Assertions scope to the stamped
 * customer names because the page aggregates ALL tenant rows.
 */
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { adminDb, customer, property, job, estimate, appointment, materialOrder, eq } from "@savvy/db";

const { id: tenantId } = JSON.parse(readFileSync("/tmp/savvy-e2e-tenant.json", "utf8")) as { id: string };

const LINE_ITEMS = [
  { key: "shingles", name: "Shingles", category: "material", unit: "square", quantity: 30, unitPriceCents: 12000, amountCents: 360000 },
];

/** Seed a job + accepted estimate, return jobId + customerName. */
async function seedJob(stamp: string, label: string): Promise<{ jobId: string; estimateId: string; name: string }> {
  const name = `${label} ${stamp}`;
  const [cust] = await adminDb.insert(customer).values({ tenantId, name, email: `${label}-${stamp}@e2e.test` }).returning();
  const [prop] = await adminDb.insert(property).values({ tenantId, customerId: cust!.id, address: `${stamp} ${label} Way` }).returning();
  const [j] = await adminDb.insert(job).values({ tenantId, customerId: cust!.id, propertyId: prop!.id, type: "retail", stage: "production" }).returning();
  const [est] = await adminDb.insert(estimate).values({ tenantId, jobId: j!.id, status: "accepted", lineItems: LINE_ITEMS, total: 360000, acceptedAt: new Date() }).returning();
  return { jobId: j!.id, estimateId: est!.id, name };
}

test("material exceptions: misaligned and no-install orders surface on /exceptions", async ({ page }) => {
  const stamp = randomUUID().slice(0, 8);

  // (a) MISALIGNED: crew install at T, materials needed by T+1d (after install).
  const misa = await seedJob(stamp, "Misaligned");
  const install = new Date(Date.now() + 8 * 86_400_000);
  await adminDb.insert(appointment).values({ tenantId, jobId: misa.jobId, type: "crew", status: "scheduled", startsAt: install, endsAt: new Date(install.getTime() + 3_600_000) });
  await adminDb.insert(materialOrder).values({
    tenantId, jobId: misa.jobId, estimateId: misa.estimateId, status: "ordered",
    lineItems: LINE_ITEMS, subtotalCents: 360000, neededByAt: new Date(install.getTime() + 86_400_000),
  });

  // (b) NO-INSTALL: material order, no crew appointment.
  const noin = await seedJob(stamp, "NoInstall");
  await adminDb.insert(materialOrder).values({
    tenantId, jobId: noin.jobId, estimateId: noin.estimateId, status: "draft",
    lineItems: LINE_ITEMS, subtotalCents: 360000, neededByAt: new Date(Date.now() + 5 * 86_400_000),
  });

  await page.goto("/exceptions");
  await expect(page.getByTestId("exceptions-page")).toBeVisible();

  // Misaligned row: high severity, "Materials arrive after install".
  const misaRow = page.locator('[data-testid="exception-row"]', { hasText: misa.name });
  await expect(misaRow).toContainText("Materials");
  await expect(misaRow).toContainText("Materials arrive after install");
  await expect(misaRow).toHaveAttribute("data-severity", "high");

  // No-install row: medium severity, "No install scheduled for materials".
  const noinRow = page.locator('[data-testid="exception-row"]', { hasText: noin.name });
  await expect(noinRow).toContainText("No install scheduled for materials");
  await expect(noinRow).toHaveAttribute("data-severity", "medium");
});
```

- [ ] **Step 2: Run the e2e**

Run from `apps/web`:
```bash
npx tsx tests/e2e/create-tenant.ts
export TEST_TENANT_ID=$(node -e "console.log(require('/tmp/savvy-e2e-tenant.json').id)")
./node_modules/.bin/playwright test tests/e2e/material-exceptions.spec.ts
```
Expected: PASS (1 test). (Inngest `ECONNREFUSED` warnings are benign — all seeding is synchronous adminDb.)
If the DB isn't up (`ECONNREFUSED` to Postgres): `pnpm db:up && pnpm --filter @savvy/db db:migrate` from the worktree root first.

- [ ] **Step 3: Document the vector**

In `docs/jobs-pipeline.md`, find the Exception Queue section (slice J — search for "Exception" / `buildExceptionQueue`) and add a short paragraph describing the material-delivery vector. Match the surrounding tone/markdown. Use this content:

```markdown
**Material delivery (D2b).** A fifth vector flags `material_order` rows (status `draft`/`ordered`)
whose delivery timing is at risk, reusing D2a's `materialDeliveryFlag`. A `misaligned` order — its
snapshotted `neededByAt` is now **after** the job's current earliest scheduled crew install (e.g.
the install was moved up after ordering) — surfaces as a **high** `material_delivery` exception
("Materials arrive after install"). An order with materials but **no** scheduled crew install
surfaces as **medium** ("No install scheduled for materials"). `none` (delivery on/before install)
is omitted. Like the invoice/job dual-path, a job may appear both here and as `job_at_risk`.
```

- [ ] **Step 4: Commit docs + e2e**

```bash
git add "apps/web/tests/e2e/material-exceptions.spec.ts" docs/jobs-pipeline.md
git commit -m "test(e2e): material-delivery exceptions + docs"
```

- [ ] **Step 5: Full verification gate**

Run from the worktree root:
```bash
pnpm test && pnpm typecheck && pnpm lint
```
Expected: all green — full suite (≥651 tests: prior 648 + 3 new core tests), typecheck clean, lint 0 errors.
(If the db suite hits `ECONNREFUSED`: `pnpm db:up && pnpm --filter @savvy/db db:migrate`, then re-run `pnpm test`.)

---

## Self-Review notes

- **Spec coverage:** core vector (Task 1) · web gather + label (Task 2) · e2e + docs + verification (Task 3). All spec sections map to a task.
- **Type consistency:** `material_delivery` / `MaterialDeliveryInput` / `materialDeliveries` / severity (`high`/`medium`) / detail strings used identically across core, web, and e2e assertions.
- **No new table / no RLS change / no config** — the query reads existing `material_order` + `appointment` inside the existing `withTenant` tx.
- **Reuses `materialDeliveryFlag`** — no duplicated detection logic; core test exercises all three flag branches.
- **e2e scoping** — assertions target stamped customer names, never `queue.total`, so they're robust on the shared e2e tenant.
