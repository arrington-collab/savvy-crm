# Phase 6C — Change Orders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** During production, a rep captures a scope change as a priced **change order**; the homeowner signs it via DocuSeal; on signature a durable workflow bumps the job's contract value by the delta and creates a draft supplemental invoice.

**Architecture:** Reuses the estimate-signing flow (Phase 7) and the unified DocuSeal gateway + webhook (6B/7). A `change_order` table mirrors `estimate`. The single `/api/docuseal/webhook` route gains a third branch (after estimate + esign_request) routing by submission id. On the `change_order/accepted` event, an idempotent Inngest fn (`changeOrderAccepted`) adjusts `job.valueFinal` and inserts a draft supplemental invoice. Line items reuse `EstimateLineItem`; the editor reuses the Phase 7 estimate editor pattern.

**Tech Stack:** Next.js 16 (App Router) server actions + route handlers · Drizzle + Postgres RLS · Inngest · DocuSeal (unified `httpDocuseal`) · Vitest + Playwright · pnpm + Turborepo.

**Branch:** `feat/phase6c-change-orders` (already created off current `main`, which includes Phases 7 + 8; latest migration is `0009`).

**DB env for db/agents tests + migrations:**
```bash
export DATABASE_URL=postgres://savvy_app:savvy_app@localhost:5432/savvy
export DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/savvy
```

**Repo gotchas to respect throughout:**
- Import drizzle ops (`eq`,`and`,`sql`,`desc`) + tables from `@savvy/db`; `z` + helpers + types from `@savvy/core`. Never from `drizzle-orm`/`zod` directly. **No `.js`** on SOURCE relative imports; `@savvy/db` TEST files (`packages/db/.../*.test.ts`) DO use `.js` (e.g. `../schema/index.js`, `./change-order.js`).
- `noUncheckedIndexedAccess` is ON — `arr[i]?.x` / `.at()` / `!` after a guard.
- Do outbound HTTP (DocuSeal) OUTSIDE the `withTenant` transaction.
- `"use server"` actions are public endpoints — verify tenant ownership server-side (every query is `withTenant`-scoped; `tenant.settings` reads use `adminDb`).
- New tenant tables MUST get `tenantIsolation()` AND an isolation test case.
- Inngest serializes Date→ISO across `step.run` — re-hydrate with `new Date(x)`. `agent_run.status` is free text (`ok`).
- `TabsTrigger` renders a plain `<button>` (no `role="tab"`) — e2e uses `getByRole("button", {name})`.
- `gh pr create` MUST pass `--base main`.
- After a workspace dep add, run `pnpm install` at root.

**Gate before each commit (repo root):** `pnpm typecheck && pnpm lint && pnpm test`

---

## File Structure

**Created:**
- `packages/core/src/change-order.ts` — `computeChangeOrderTotal` (pure).
- `packages/db/src/lifecycle/change-order.ts` — `createChangeOrder`, `sendChangeOrder`, `markChangeOrderBySubmission`, `approveChangeOrder`.
- `packages/db/src/lifecycle/change-order.test.ts` — integration tests.
- `packages/agents/src/functions/change-order.ts` — `changeOrderAccepted` Inngest fn (+ thin helper already in `@savvy/db`).
- `packages/agents/src/functions/change-order.test.ts` — integration test.
- `apps/web/src/lib/change-order-queries.ts` — `listChangeOrdersForJob`, `getChangeOrder`.
- `apps/web/src/lib/change-order-actions.ts` — `createChangeOrderAction`, `updateChangeOrderLineItemsAction`, `sendChangeOrderForSignatureAction`.
- `apps/web/src/app/(app)/jobs/[id]/change-orders/[changeOrderId]/page.tsx` — editor route.
- `apps/web/src/app/(app)/jobs/[id]/change-orders/[changeOrderId]/ChangeOrderEditor.tsx` — editor (client).
- `apps/web/src/app/(app)/jobs/[id]/ChangeOrdersSection.tsx` — "+ Create change order" button (client).
- `apps/web/tests/e2e/change-order.spec.ts` — e2e.

**Modified:**
- `packages/core/src/index.ts` — export change-order.
- `packages/db/src/schema/finance.ts` — add `change_order` table.
- `packages/db/src/index.ts` — export change-order lifecycle fns.
- `packages/db/tests/isolation.test.ts` — `change_order` isolation case.
- `packages/db/drizzle/0010_*.sql` — generated.
- `packages/agents/src/client.ts` — `change_order/accepted` event.
- `packages/agents/src/index.ts` — register `changeOrderAccepted`.
- `apps/web/src/app/api/docuseal/webhook/route.ts` — third branch.
- `apps/web/src/app/(app)/jobs/[id]/page.tsx` — Change orders section.
- `apps/web/playwright.config.ts` — add `DOCUSEAL_TEMPLATE_CHANGE_ORDER`.
- `.env.example` — document `DOCUSEAL_TEMPLATE_CHANGE_ORDER`.

---

## Task 1: Core — `computeChangeOrderTotal`

**Files:** Create `packages/core/src/change-order.ts` + `packages/core/src/change-order.test.ts`; Modify `packages/core/src/index.ts`.

- [ ] **Step 1: Write the failing test** — `packages/core/src/change-order.test.ts`:

```typescript
import { test, expect } from "vitest";
import { computeChangeOrderTotal } from "./change-order";

test("sums amountCents into subtotal === total", () => {
  const r = computeChangeOrderTotal([{ amountCents: 12000 }, { amountCents: 8000 }]);
  expect(r).toEqual({ subtotal: 20000, total: 20000 });
});

test("empty lines -> zero", () => {
  expect(computeChangeOrderTotal([])).toEqual({ subtotal: 0, total: 0 });
});

test("supports a negative (credit) line", () => {
  const r = computeChangeOrderTotal([{ amountCents: 10000 }, { amountCents: -3000 }]);
  expect(r).toEqual({ subtotal: 7000, total: 7000 });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `pnpm --filter @savvy/core exec vitest run src/change-order.test.ts`
Expected: FAIL — `Cannot find module './change-order'`.

- [ ] **Step 3: Implement** — `packages/core/src/change-order.ts`:

```typescript
/**
 * Change-order line items reuse @savvy/core's EstimateLineItem shape; only the
 * sum is needed here. A change order has no separate tax line (the delta is the
 * figure that adjusts the contract and is invoiced), so subtotal === total.
 */
export function computeChangeOrderTotal(lines: { amountCents: number }[]): { subtotal: number; total: number } {
  const subtotal = lines.reduce((s, l) => s + l.amountCents, 0);
  return { subtotal, total: subtotal };
}
```

- [ ] **Step 4: Export** — in `packages/core/src/index.ts`, add after the last existing `export * from "./..."` line:

```typescript
export * from "./change-order";
```

- [ ] **Step 5: Run — expect PASS (3 tests)**

Run: `pnpm --filter @savvy/core exec vitest run src/change-order.test.ts`

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/change-order.ts packages/core/src/change-order.test.ts packages/core/src/index.ts
git commit -m "feat(core): computeChangeOrderTotal"
```

---

## Task 2: DB — `change_order` table + migration `0010`

**Files:** Modify `packages/db/src/schema/finance.ts`; generate `packages/db/drizzle/0010_*.sql`.

- [ ] **Step 1: Add the table** — at the END of `packages/db/src/schema/finance.ts`, append (the imports `pgTable, uuid, text, integer, timestamp, jsonb, index, uniqueIndex, boolean` — confirm `boolean` is imported from `"drizzle-orm/pg-core"`; ADD it if missing; `idCol, createdAt, tenantIsolation, tenant, job, customer, invoice` are already in this file):

```typescript
// Change orders (Phase 6C). A priced mid-production delta on a job, signed via
// DocuSeal. docusealSubmissionId is globally unique within the single Savvy
// instance; the (tenant, submission) unique index makes the webhook idempotent.
export const changeOrder = pgTable("change_order", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  jobId: uuid("job_id").notNull().references(() => job.id),
  customerId: uuid("customer_id").notNull().references(() => customer.id),
  reason: text("reason"),
  status: text("status").notNull().default("draft"), // draft|sent|approved|declined|voided
  lineItems: jsonb("line_items").$type<unknown[]>().default([]).notNull(),
  subtotal: integer("subtotal"),
  total: integer("total"),
  docusealSubmissionId: text("docuseal_submission_id"),
  signingUrl: text("signing_url"),
  invoiceId: uuid("invoice_id").references(() => invoice.id),
  applied: boolean("applied").notNull().default(false),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [
  index("change_order_tenant_job_idx").on(t.tenantId, t.jobId),
  uniqueIndex("change_order_submission_uniq").on(t.tenantId, t.docusealSubmissionId),
  tenantIsolation(),
]);
```

Note: `invoice` is defined ABOVE in this same file, so the `references(() => invoice.id)` resolves. `boolean` may not yet be imported — check line 1 and add it.

- [ ] **Step 2: Generate the migration**

Run: `pnpm --filter @savvy/db db:generate`
Expected: new `packages/db/drizzle/0010_*.sql` with `CREATE TABLE ... "change_order"`.

- [ ] **Step 3: Verify the SQL**

Run: `cat packages/db/drizzle/0010_*.sql`
Confirm: `CREATE TABLE "change_order"`, `change_order_submission_uniq` (UNIQUE), `change_order_tenant_job_idx`, FKs to tenant/job/customer/invoice, `ENABLE ROW LEVEL SECURITY`, `CREATE POLICY "tenant_isolation" ON "change_order"`. If RLS/policy missing, the `tenantIsolation()` call was dropped — fix Step 1 + regenerate.

- [ ] **Step 4: Apply + typecheck**

```bash
pnpm --filter @savvy/db db:migrate
pnpm --filter @savvy/db typecheck
```
Expected: clean apply; typecheck PASS (table auto-exports via `export * from "./finance"`).

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/schema/finance.ts packages/db/drizzle/
git commit -m "feat(db): add change_order table + migration 0010"
```

---

## Task 3: DB — RLS isolation test for `change_order`

**Files:** Modify `packages/db/tests/isolation.test.ts`.

- [ ] **Step 1: Add `changeOrder` to the test's `@savvy/db` import** (the import block destructures table names; add `changeOrder`).

- [ ] **Step 2: Add the isolation test** — inside the main `describe(...)`, next to the `esign_request` case (uses the existing module-level `tenantAId`, `tenantBId`, `jobBId`, `custBId` from `beforeAll`):

```typescript
it("SELECT on change_order is tenant-scoped (A cannot see B's change orders)", async () => {
  const [co] = await adminDb
    .insert(changeOrder)
    .values({
      tenantId: tenantBId,
      jobId: jobBId,
      customerId: custBId,
      reason: "extra decking",
      status: "sent",
      lineItems: [],
      total: 50000,
      docusealSubmissionId: "co_sub_b_iso_1",
    })
    .returning();
  try {
    const rows = await withTenant(tenantAId, (tx) => tx.select().from(changeOrder));
    expect(rows.some((r) => r.tenantId === tenantBId)).toBe(false);
  } finally {
    await adminDb.delete(changeOrder).where(eq(changeOrder.id, co!.id));
  }
});
```

- [ ] **Step 3: Run — expect the full isolation suite PASS**

Run: `pnpm --filter @savvy/db exec vitest run tests/isolation.test.ts`

- [ ] **Step 4: Commit**

```bash
git add packages/db/tests/isolation.test.ts
git commit -m "test(db): change_order RLS isolation"
```

---

## Task 4: DB — `createChangeOrder` + `sendChangeOrder`

**Files:** Create `packages/db/src/lifecycle/change-order.ts` + `packages/db/src/lifecycle/change-order.test.ts`; Modify `packages/db/src/index.ts`.

- [ ] **Step 1: Write the failing test** — `packages/db/src/lifecycle/change-order.test.ts` (mirror `packages/db/src/lifecycle/esign.test.ts` import style — `.js` suffixes, tables from `../schema/index.js`):

```typescript
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { adminDb, adminPool } from "../admin-client.js";
import { pool } from "../client.js";
import { tenant, customer, property, job, changeOrder } from "../schema/index.js";
import { createChangeOrder, sendChangeOrder } from "./change-order.js";

let tId: string, custId: string, jobId: string;

beforeAll(async () => {
  const [t] = await adminDb.insert(tenant).values({ name: "CO", publicKey: "co", clerkOrgId: "org_co" }).returning();
  tId = t!.id;
  const [c] = await adminDb.insert(customer).values({ tenantId: tId, name: "Pat", email: "pat@x.com" }).returning();
  custId = c!.id;
  const [p] = await adminDb.insert(property).values({ tenantId: tId, customerId: custId, address: "1 Main St" }).returning();
  const [j] = await adminDb.insert(job).values({ tenantId: tId, customerId: custId, propertyId: p!.id }).returning();
  jobId = j!.id;
});

afterAll(async () => {
  await adminDb.delete(changeOrder).where(eq(changeOrder.tenantId, tId));
  await adminDb.delete(job).where(eq(job.tenantId, tId));
  await adminDb.delete(property).where(eq(property.tenantId, tId));
  await adminDb.delete(customer).where(eq(customer.tenantId, tId));
  await adminDb.delete(tenant).where(eq(tenant.id, tId));
  await pool.end();
  await adminPool.end();
});

describe("createChangeOrder", () => {
  it("inserts a draft with computed subtotal/total", async () => {
    const co = await createChangeOrder({
      tenantId: tId, jobId, customerId: custId, reason: "extra vents",
      lineItems: [{ amountCents: 12000 }, { amountCents: 8000 }],
    });
    expect(co.status).toBe("draft");
    expect(co.total).toBe(20000);
    expect(co.subtotal).toBe(20000);
  });
});

describe("sendChangeOrder", () => {
  it("records submission id + url and flips to sent", async () => {
    const co = await createChangeOrder({ tenantId: tId, jobId, customerId: custId, reason: "r", lineItems: [{ amountCents: 5000 }] });
    await sendChangeOrder({ tenantId: tId, changeOrderId: co.id, docusealSubmissionId: "co_sub_send", signingUrl: "https://x/s/1" });
    const [row] = await adminDb.select().from(changeOrder).where(eq(changeOrder.id, co.id));
    expect(row!.status).toBe("sent");
    expect(row!.docusealSubmissionId).toBe("co_sub_send");
    expect(row!.signingUrl).toBe("https://x/s/1");
    expect(row!.sentAt).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (`Cannot find module './change-order.js'`)

Run: `pnpm --filter @savvy/db exec vitest run src/lifecycle/change-order.test.ts`

- [ ] **Step 3: Implement** — `packages/db/src/lifecycle/change-order.ts` (SOURCE file — no `.js`; check neighbor `esign.ts`/`invoices.ts` for exact import paths):

```typescript
import { eq, sql } from "drizzle-orm";
import { adminDb } from "../admin-client";
import { withTenant } from "../tenant";
import { changeOrder, job, invoice } from "../schema/index";
import { computeChangeOrderTotal } from "@savvy/core";

type CoRow = typeof changeOrder.$inferSelect;

export async function createChangeOrder(input: {
  tenantId: string;
  jobId: string;
  customerId: string;
  reason?: string;
  lineItems: { amountCents: number }[];
}): Promise<CoRow> {
  const { subtotal, total } = computeChangeOrderTotal(input.lineItems);
  return withTenant(input.tenantId, async (tx) => {
    const [row] = await tx
      .insert(changeOrder)
      .values({
        tenantId: input.tenantId,
        jobId: input.jobId,
        customerId: input.customerId,
        reason: input.reason ?? null,
        status: "draft",
        lineItems: input.lineItems,
        subtotal,
        total,
      })
      .returning();
    return row!;
  });
}

export async function sendChangeOrder(input: {
  tenantId: string;
  changeOrderId: string;
  docusealSubmissionId: string;
  signingUrl: string;
}): Promise<void> {
  await withTenant(input.tenantId, (tx) =>
    tx
      .update(changeOrder)
      .set({ status: "sent", sentAt: sql`now()`, docusealSubmissionId: input.docusealSubmissionId, signingUrl: input.signingUrl })
      .where(eq(changeOrder.id, input.changeOrderId)),
  );
}
```

(`adminDb`, `job`, `invoice` are imported now because Task 5 adds functions to this same file that use them. If lint flags an unused import at this step, add them in Task 5 instead — but the file will need them shortly.)

- [ ] **Step 4: Export** — in `packages/db/src/index.ts`, add after `export { markEsignBySubmission } from "./lifecycle/esign";`:

```typescript
export { createChangeOrder, sendChangeOrder } from "./lifecycle/change-order";
```

- [ ] **Step 5: Run — expect PASS (2 tests)**

Run: `pnpm --filter @savvy/db exec vitest run src/lifecycle/change-order.test.ts`

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/lifecycle/change-order.ts packages/db/src/lifecycle/change-order.test.ts packages/db/src/index.ts
git commit -m "feat(db): createChangeOrder + sendChangeOrder"
```

---

## Task 5: DB — `markChangeOrderBySubmission` + `approveChangeOrder`

**Files:** Modify `packages/db/src/lifecycle/change-order.ts`, `packages/db/src/lifecycle/change-order.test.ts`, `packages/db/src/index.ts`.

- [ ] **Step 1: Add failing tests** — append inside `packages/db/src/lifecycle/change-order.test.ts` (add `invoice` to the `../schema/index.js` import and `markChangeOrderBySubmission, approveChangeOrder` to the `./change-order.js` import):

```typescript
describe("markChangeOrderBySubmission", () => {
  it("flips a sent change order to approved + approvedAt; idempotent on replay", async () => {
    const co = await createChangeOrder({ tenantId: tId, jobId, customerId: custId, reason: "r", lineItems: [{ amountCents: 9000 }] });
    await sendChangeOrder({ tenantId: tId, changeOrderId: co.id, docusealSubmissionId: "co_mark_1", signingUrl: "u" });

    const first = await markChangeOrderBySubmission({ submissionId: "co_mark_1" });
    expect(first?.changed).toBe(true);
    expect(first?.tenantId).toBe(tId);
    const [row] = await adminDb.select().from(changeOrder).where(eq(changeOrder.id, co.id));
    expect(row!.status).toBe("approved");
    expect(row!.approvedAt).not.toBeNull();

    const second = await markChangeOrderBySubmission({ submissionId: "co_mark_1" });
    expect(second?.changed).toBe(false);
  });

  it("returns null for an unknown submission", async () => {
    expect(await markChangeOrderBySubmission({ submissionId: "nope" })).toBeNull();
  });
});

describe("approveChangeOrder", () => {
  it("bumps job.valueFinal by total + creates ONE draft invoice (total>0); idempotent", async () => {
    // fresh job so valueFinal math is isolated
    const [c2] = await adminDb.insert(customer).values({ tenantId: tId, name: "C2", email: "c2@x.com" }).returning();
    const [p2] = await adminDb.insert(property).values({ tenantId: tId, customerId: c2!.id, address: "2 St" }).returning();
    const [j2] = await adminDb.insert(job).values({ tenantId: tId, customerId: c2!.id, propertyId: p2!.id, valueFinal: 100000 }).returning();
    const co = await createChangeOrder({ tenantId: tId, jobId: j2!.id, customerId: c2!.id, reason: "r", lineItems: [{ amountCents: 25000 }] });

    const r1 = await approveChangeOrder({ tenantId: tId, changeOrderId: co.id });
    expect(r1.invoiceCreated).toBe(true);
    const [jobAfter] = await adminDb.select().from(job).where(eq(job.id, j2!.id));
    expect(jobAfter!.valueFinal).toBe(125000);
    const invs = await adminDb.select().from(invoice).where(eq(invoice.jobId, j2!.id));
    expect(invs.length).toBe(1);
    expect(invs[0]!.amountDue).toBe(25000);
    expect(invs[0]!.status).toBe("draft");
    const [coAfter] = await adminDb.select().from(changeOrder).where(eq(changeOrder.id, co.id));
    expect(coAfter!.applied).toBe(true);
    expect(coAfter!.invoiceId).toBe(invs[0]!.id);

    // idempotent replay: no second invoice, no double bump
    const r2 = await approveChangeOrder({ tenantId: tId, changeOrderId: co.id });
    expect(r2.invoiceCreated).toBe(false);
    const [jobAfter2] = await adminDb.select().from(job).where(eq(job.id, j2!.id));
    expect(jobAfter2!.valueFinal).toBe(125000);
    const invs2 = await adminDb.select().from(invoice).where(eq(invoice.jobId, j2!.id));
    expect(invs2.length).toBe(1);
  });

  it("credit/zero delta bumps value but creates no invoice", async () => {
    const [c3] = await adminDb.insert(customer).values({ tenantId: tId, name: "C3" }).returning();
    const [p3] = await adminDb.insert(property).values({ tenantId: tId, customerId: c3!.id, address: "3 St" }).returning();
    const [j3] = await adminDb.insert(job).values({ tenantId: tId, customerId: c3!.id, propertyId: p3!.id, valueFinal: 100000 }).returning();
    const co = await createChangeOrder({ tenantId: tId, jobId: j3!.id, customerId: c3!.id, reason: "credit", lineItems: [{ amountCents: -5000 }] });
    const r = await approveChangeOrder({ tenantId: tId, changeOrderId: co.id });
    expect(r.invoiceCreated).toBe(false);
    const [jobAfter] = await adminDb.select().from(job).where(eq(job.id, j3!.id));
    expect(jobAfter!.valueFinal).toBe(95000);
    const invs = await adminDb.select().from(invoice).where(eq(invoice.jobId, j3!.id));
    expect(invs.length).toBe(0);
  });
});
```

Add `invoice` to the afterAll teardown BEFORE the job delete: `await adminDb.delete(invoice).where(eq(invoice.tenantId, tId));` (place it before `delete(job)`; import `invoice` in the test).

- [ ] **Step 2: Run — expect FAIL** (functions not exported)

Run: `pnpm --filter @savvy/db exec vitest run src/lifecycle/change-order.test.ts`

- [ ] **Step 3: Implement** — append to `packages/db/src/lifecycle/change-order.ts`:

```typescript
/**
 * Webhook-side status flip (mirrors markEsignBySubmission). No tenant session, so
 * resolve the tenant by the globally-unique submission id via adminDb, then flip
 * sent -> approved inside withTenant. Idempotent: a terminal row returns changed:false.
 */
export async function markChangeOrderBySubmission(input: {
  submissionId: string;
}): Promise<{ tenantId: string; changeOrderId: string; changed: boolean } | null> {
  const [row] = await adminDb
    .select({ id: changeOrder.id, tenantId: changeOrder.tenantId, status: changeOrder.status })
    .from(changeOrder)
    .where(eq(changeOrder.docusealSubmissionId, input.submissionId))
    .limit(1);
  if (!row) return null;
  if (row.status === "approved" || row.status === "declined" || row.status === "voided") {
    return { tenantId: row.tenantId, changeOrderId: row.id, changed: false };
  }
  await withTenant(row.tenantId, (tx) =>
    tx.update(changeOrder).set({ status: "approved", approvedAt: new Date() }).where(eq(changeOrder.id, row.id)),
  );
  return { tenantId: row.tenantId, changeOrderId: row.id, changed: true };
}

/**
 * Durable money mutation (status already approved). Idempotent via `applied`:
 * bump job.valueFinal by the delta, and when total>0 insert a DRAFT supplemental
 * invoice (mirrors createInvoiceFromEstimate). All in one tx.
 */
export async function approveChangeOrder(input: {
  tenantId: string;
  changeOrderId: string;
}): Promise<{ invoiceCreated: boolean }> {
  return withTenant(input.tenantId, async (tx) => {
    const [co] = await tx.select().from(changeOrder).where(eq(changeOrder.id, input.changeOrderId));
    if (!co || co.applied) return { invoiceCreated: false };
    const total = co.total ?? 0;

    const [j] = await tx.select().from(job).where(eq(job.id, co.jobId));
    const base = j?.valueFinal ?? j?.valueEstimate ?? 0;
    await tx.update(job).set({ valueFinal: base + total }).where(eq(job.id, co.jobId));

    let invoiceId: string | null = null;
    if (total > 0) {
      const [inv] = await tx
        .insert(invoice)
        .values({
          tenantId: input.tenantId,
          jobId: co.jobId,
          customerId: co.customerId,
          lineItems: co.lineItems as unknown[],
          amountDue: total,
          status: "draft",
        })
        .returning({ id: invoice.id });
      invoiceId = inv!.id;
    }

    await tx.update(changeOrder).set({ applied: true, invoiceId }).where(eq(changeOrder.id, co.id));
    return { invoiceCreated: invoiceId !== null };
  });
}
```

- [ ] **Step 4: Export** — update the `packages/db/src/index.ts` line from Task 4 to:

```typescript
export { createChangeOrder, sendChangeOrder, markChangeOrderBySubmission, approveChangeOrder } from "./lifecycle/change-order";
```

- [ ] **Step 5: Run — expect PASS (all change-order lifecycle tests)**

Run: `pnpm --filter @savvy/db exec vitest run src/lifecycle/change-order.test.ts`
Then typecheck: `pnpm --filter @savvy/db typecheck`

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/lifecycle/change-order.ts packages/db/src/lifecycle/change-order.test.ts packages/db/src/index.ts
git commit -m "feat(db): markChangeOrderBySubmission + approveChangeOrder"
```

---

## Task 6: Agents — `change_order/accepted` event + `changeOrderAccepted`

**Files:** Modify `packages/agents/src/client.ts`, `packages/agents/src/index.ts`; Create `packages/agents/src/functions/change-order.ts` + `packages/agents/src/functions/change-order.test.ts`.

- [ ] **Step 1: Register the event** — in `packages/agents/src/client.ts`, add to the `Events` type (after `"estimate/accepted"`):

```typescript
  "change_order/accepted": { data: { changeOrderId: string; tenantId: string } };
```

- [ ] **Step 2: Write the failing integration test** — `packages/agents/src/functions/change-order.test.ts` (mirror `estimate-sign.test.ts`; imports from `@savvy/db` without `.js`):

```typescript
import { describe, it, expect } from "vitest";
import { adminDb, withTenant, eq, tenant, customer, property, job, invoice, changeOrder, createChangeOrder } from "@savvy/db";
import { applyAcceptedChangeOrder } from "./change-order";

async function seed(total: number): Promise<{ tenantId: string; jobId: string; changeOrderId: string }> {
  const [t] = await adminDb.insert(tenant).values({ name: "COA", publicKey: `pk-${crypto.randomUUID()}`, clerkOrgId: `org-${crypto.randomUUID()}` }).returning();
  const [c] = await adminDb.insert(customer).values({ tenantId: t!.id, name: "Sam", email: "sam@x.com" }).returning();
  const [p] = await adminDb.insert(property).values({ tenantId: t!.id, customerId: c!.id, address: "9 St" }).returning();
  const [j] = await adminDb.insert(job).values({ tenantId: t!.id, customerId: c!.id, propertyId: p!.id, valueFinal: 100000 }).returning();
  const co = await createChangeOrder({ tenantId: t!.id, jobId: j!.id, customerId: c!.id, reason: "r", lineItems: [{ amountCents: total }] });
  return { tenantId: t!.id, jobId: j!.id, changeOrderId: co.id };
}

describe("applyAcceptedChangeOrder", () => {
  it("approves once (value bump + draft invoice) and is idempotent", async () => {
    const { tenantId, jobId, changeOrderId } = await seed(30000);
    const r1 = await applyAcceptedChangeOrder(tenantId, changeOrderId);
    expect(r1.invoiceCreated).toBe(true);
    const [j1] = await withTenant(tenantId, (tx) => tx.select().from(job).where(eq(job.id, jobId)));
    expect(j1!.valueFinal).toBe(130000);
    const invs = await adminDb.select().from(invoice).where(eq(invoice.jobId, jobId));
    expect(invs.length).toBe(1);

    const r2 = await applyAcceptedChangeOrder(tenantId, changeOrderId);
    expect(r2.invoiceCreated).toBe(false);
    const invs2 = await adminDb.select().from(invoice).where(eq(invoice.jobId, jobId));
    expect(invs2.length).toBe(1);
  });
});
```

- [ ] **Step 3: Run — expect FAIL**

Run: `pnpm --filter @savvy/agents exec vitest run src/functions/change-order.test.ts`

- [ ] **Step 4: Implement** — `packages/agents/src/functions/change-order.ts`:

```typescript
import { withTenant, eq, agentRun, approveChangeOrder } from "@savvy/db";
import { inngest } from "../client";

/** Thin wrapper so the Inngest fn stays a one-liner and the test can call the work directly. */
export async function applyAcceptedChangeOrder(tenantId: string, changeOrderId: string): Promise<{ invoiceCreated: boolean }> {
  const res = await approveChangeOrder({ tenantId, changeOrderId });
  await withTenant(tenantId, (tx) =>
    tx.insert(agentRun).values({ tenantId, agent: "finance", status: "ok", modelUsed: null }),
  );
  return res;
}

export const changeOrderAccepted = inngest.createFunction(
  { id: "change-order-accepted", concurrency: { limit: 10 } },
  { event: "change_order/accepted" },
  async ({ event, step }) =>
    step.run("apply", () => applyAcceptedChangeOrder(event.data.tenantId, event.data.changeOrderId)),
);
```

VERIFY: `agentRun` is exported from `@savvy/db` and its columns (`tenantId, agent, status, modelUsed`) match — check a neighbor (`lead-intake.ts` writes `agentRun`). Adjust the `.values({...})` to the real required columns if needed (e.g. it may also accept `inngestRunId: event.id ?? null`).

- [ ] **Step 5: Register the fn** — in `packages/agents/src/index.ts`: add the import, the re-export, and append `changeOrderAccepted` to the `functions` array.

- [ ] **Step 6: Run — expect PASS; typecheck**

```bash
pnpm --filter @savvy/agents exec vitest run src/functions/change-order.test.ts
pnpm --filter @savvy/agents typecheck
```

- [ ] **Step 7: Commit**

```bash
git add packages/agents/src/client.ts packages/agents/src/functions/change-order.ts packages/agents/src/functions/change-order.test.ts packages/agents/src/index.ts
git commit -m "feat(agents): changeOrderAccepted applies the delta + draft invoice"
```

---

## Task 7: Web — webhook third branch

**Files:** Modify `apps/web/src/app/api/docuseal/webhook/route.ts`.

- [ ] **Step 1: Restructure the route to handle three branches cleanly.** Replace the file body of `apps/web/src/app/api/docuseal/webhook/route.ts` with:

```typescript
import { NextResponse } from "next/server";
import { adminDb, estimate, esignRequest, changeOrder, markEsignBySubmission, markChangeOrderBySubmission, eq } from "@savvy/db";
import { httpDocuseal } from "@savvy/integrations";
import { inngest } from "@savvy/agents";

export const runtime = "nodejs"; // node:crypto for HMAC signature verification

// Single inbound URL for the Savvy-owned DocuSeal instance. Verify the HMAC
// signature once, parse the event, then route by what the submission belongs to:
//   - estimate (P7)        -> estimate/accepted (advances job to approved)
//   - esign_request (6B)   -> esign/completed (stores signed PDF)
//   - change_order (6C)    -> change_order/accepted (bumps valueFinal + draft invoice)
export async function POST(req: Request): Promise<NextResponse> {
  const raw = await req.text();
  const sig = req.headers.get("x-docuseal-signature");
  if (!httpDocuseal.verifyWebhook(raw, sig)) {
    return new NextResponse("bad signature", { status: 401 });
  }

  let payload: unknown = null;
  try {
    payload = JSON.parse(raw);
  } catch {
    return new NextResponse("bad payload", { status: 400 });
  }

  const ev = httpDocuseal.parseEvent(payload);
  if (!ev || ev.status !== "completed") return NextResponse.json({ ok: true });

  // Estimate signing (Phase 7).
  const [est] = await adminDb.select().from(estimate).where(eq(estimate.docusealSubmissionId, ev.submissionId));
  if (est) {
    if (est.status !== "accepted") {
      try {
        await inngest.send({ name: "estimate/accepted", data: { tenantId: est.tenantId, estimateId: est.id } });
      } catch (e) {
        console.error(e);
      }
    }
    return NextResponse.json({ ok: true });
  }

  // Closeout signing (Phase 6B).
  const esign = await markEsignBySubmission({ submissionId: ev.submissionId, status: "completed" });
  if (esign) {
    if (esign.changed) {
      try {
        await inngest.send({ name: "esign/completed", data: { requestId: esign.requestId, tenantId: esign.tenantId } });
      } catch (e) {
        console.error(e);
      }
    }
    return NextResponse.json({ ok: true });
  }

  // Change-order signing (Phase 6C).
  const co = await markChangeOrderBySubmission({ submissionId: ev.submissionId });
  if (co && co.changed) {
    try {
      await inngest.send({ name: "change_order/accepted", data: { changeOrderId: co.changeOrderId, tenantId: co.tenantId } });
    } catch (e) {
      console.error(e);
    }
  }
  return NextResponse.json({ ok: true });
}
```

(Note: this also tightens the esign branch to `return` after a match instead of falling through — the original fell through to the final 200; behaviour is unchanged for estimate/esign, just clearer, and required so an esign match doesn't also run the change-order lookup. `changeOrder` import is added but only used via `markChangeOrderBySubmission`; if eslint flags the unused `changeOrder` table import, remove it — only the lifecycle fn is needed.)

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @savvy/web typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/app/api/docuseal/webhook/route.ts
git commit -m "feat(web): route change-order signatures in the DocuSeal webhook"
```

---

## Task 8: Web — queries + actions

**Files:** Create `apps/web/src/lib/change-order-queries.ts` + `apps/web/src/lib/change-order-actions.ts`.

- [ ] **Step 1: Queries** — `apps/web/src/lib/change-order-queries.ts` (mirror `estimate-queries.ts`):

```typescript
import "server-only";
import { withTenant, changeOrder, eq, desc } from "@savvy/db";
import { getTenantId } from "./tenant";

export async function listChangeOrdersForJob(jobId: string) {
  const tenantId = await getTenantId();
  return withTenant(tenantId, (tx) =>
    tx.select().from(changeOrder).where(eq(changeOrder.jobId, jobId)).orderBy(desc(changeOrder.createdAt)),
  );
}

export async function getChangeOrder(changeOrderId: string) {
  const tenantId = await getTenantId();
  const [row] = await withTenant(tenantId, (tx) =>
    tx.select().from(changeOrder).where(eq(changeOrder.id, changeOrderId)),
  );
  return row ?? null;
}
```

- [ ] **Step 2: Actions** — `apps/web/src/lib/change-order-actions.ts` (mirror `estimate-actions.ts` + `esign-actions.ts`'s `defaultDocuseal()` fake-fallback + typed error union):

```typescript
"use server";
import { revalidatePath } from "next/cache";
import { withTenant, adminDb, tenant, job, customer, property, changeOrder, createChangeOrder, sendChangeOrder, eq } from "@savvy/db";
import { computeChangeOrderTotal, type EstimateLineItem } from "@savvy/core";
import { httpDocuseal, makeFakeDocuseal } from "@savvy/integrations";
import { getTenantId } from "./tenant";

/** Real gateway when DocuSeal is configured; fake (fail-soft) otherwise (dev/e2e). */
const docuseal = () => (process.env.DOCUSEAL_API_KEY ? httpDocuseal : makeFakeDocuseal());

export async function createChangeOrderAction(input: { jobId: string; reason: string; lineItems: EstimateLineItem[] }) {
  const tenantId = await getTenantId();
  const found = await withTenant(tenantId, async (tx) => {
    const [j] = await tx.select({ id: job.id, customerId: job.customerId }).from(job).where(eq(job.id, input.jobId));
    return j ?? null;
  });
  if (!found) return { error: "not_found" as const };
  const co = await createChangeOrder({
    tenantId, jobId: input.jobId, customerId: found.customerId, reason: input.reason, lineItems: input.lineItems,
  });
  revalidatePath(`/jobs/${input.jobId}`);
  return { ok: true as const, id: co.id };
}

export async function updateChangeOrderLineItemsAction(input: { changeOrderId: string; jobId: string; lineItems: EstimateLineItem[] }) {
  const tenantId = await getTenantId();
  const { subtotal, total } = computeChangeOrderTotal(input.lineItems);
  await withTenant(tenantId, (tx) =>
    tx.update(changeOrder).set({ lineItems: input.lineItems, subtotal, total }).where(eq(changeOrder.id, input.changeOrderId)),
  );
  revalidatePath(`/jobs/${input.jobId}/change-orders/${input.changeOrderId}`);
}

type SendResult =
  | { ok: true; signingUrl: string }
  | { error: "not_found" | "no_customer_email" | "no_template" | "docuseal_failed" };

export async function sendChangeOrderForSignatureAction(changeOrderId: string, jobId: string): Promise<SendResult> {
  const tenantId = await getTenantId();
  const ctx = await withTenant(tenantId, async (tx) => {
    const [co] = await tx.select().from(changeOrder).where(eq(changeOrder.id, changeOrderId));
    if (!co) return null;
    const [c] = await tx.select({ name: customer.name, email: customer.email }).from(customer).where(eq(customer.id, co.customerId));
    const [j] = await tx.select({ propertyId: job.propertyId }).from(job).where(eq(job.id, co.jobId));
    const [p] = j ? await tx.select({ address: property.address }).from(property).where(eq(property.id, j.propertyId)) : [undefined];
    return { co, c, address: p?.address ?? "" };
  });
  if (!ctx) return { error: "not_found" };
  if (!ctx.c?.email) return { error: "no_customer_email" };

  const [t] = await adminDb.select({ settings: tenant.settings }).from(tenant).where(eq(tenant.id, tenantId));
  const templateId =
    ((t?.settings as { esign?: { templates?: { change_order?: string } } } | undefined)?.esign?.templates?.change_order)
    || (process.env.DOCUSEAL_TEMPLATE_CHANGE_ORDER ?? "");
  if (!templateId) return { error: "no_template" };

  const total = ctx.co.total ?? 0;
  const fields = [
    { name: "customer_name", default_value: ctx.c.name },
    { name: "property_address", default_value: ctx.address },
    { name: "date", default_value: new Date().toISOString().slice(0, 10) },
    { name: "amount", default_value: `$${(total / 100).toFixed(2)}` },
    { name: "reason", default_value: ctx.co.reason ?? "" },
  ];

  let submission: { submissionId: string; signingUrl: string };
  try {
    submission = await docuseal().createClosoutSubmission({
      templateId,
      signer: { name: ctx.c.name, email: ctx.c.email },
      fields,
      metadata: { tenantId, jobId, docType: "change_order" },
    });
  } catch {
    return { error: "docuseal_failed" };
  }

  await sendChangeOrder({ tenantId, changeOrderId, docusealSubmissionId: submission.submissionId, signingUrl: submission.signingUrl });
  revalidatePath(`/jobs/${jobId}/change-orders/${changeOrderId}`);
  return { ok: true, signingUrl: submission.signingUrl };
}
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @savvy/web typecheck`
Expected: PASS. (Confirm `EstimateLineItem` is exported from `@savvy/core`; `property` from `@savvy/db`.)

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/lib/change-order-queries.ts apps/web/src/lib/change-order-actions.ts
git commit -m "feat(web): change-order queries + create/send actions"
```

---

## Task 9: Web — change-order editor + route

**Files:** Create `apps/web/src/app/(app)/jobs/[id]/change-orders/[changeOrderId]/page.tsx` + `ChangeOrderEditor.tsx`.

- [ ] **Step 1: Editor (client)** — `apps/web/src/app/(app)/jobs/[id]/change-orders/[changeOrderId]/ChangeOrderEditor.tsx`. Mirror `EstimateEditor.tsx` (line-item grid with qty/unit-price/amount + add/remove rows, running total), with a `reason` text input, and "Save" → `updateChangeOrderLineItemsAction`, "Send for signature" → `sendChangeOrderForSignatureAction` (toast on `no_customer_email`/`no_template`/`docuseal_failed`). Use `EstimateLineItem` for the row shape and `computeChangeOrderTotal` for the displayed total. Key pieces:

```tsx
"use client";
import { useState, useTransition } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { EstimateLineItem } from "@savvy/core";
import { updateChangeOrderLineItemsAction, sendChangeOrderForSignatureAction } from "@/lib/change-order-actions";

interface ChangeOrderRow {
  id: string; jobId: string; reason: string | null; status: string;
  lineItems: unknown[]; total: number | null; signingUrl: string | null; docusealSubmissionId: string | null;
}

function fmtUsd(c: number): string { return (c / 100).toLocaleString("en-US", { style: "currency", currency: "USD" }); }

export function ChangeOrderEditor({ changeOrder, jobId }: { changeOrder: ChangeOrderRow; jobId: string }) {
  const [lineItems, setLineItems] = useState<EstimateLineItem[]>((changeOrder.lineItems as EstimateLineItem[]) ?? []);
  const [reason, setReason] = useState(changeOrder.reason ?? "");
  const [savePending, startSave] = useTransition();
  const [sendPending, startSend] = useTransition();
  const totalCents = lineItems.reduce((s, li) => s + li.amountCents, 0);

  function updateQty(i: number, v: string) {
    const qty = parseFloat(v) || 0;
    setLineItems((p) => p.map((li, idx) => idx === i ? { ...li, quantity: qty, amountCents: Math.round(qty * li.unitPriceCents) } : li));
  }
  function updateUnitPrice(i: number, v: string) {
    const cents = Math.round((parseFloat(v) || 0) * 100);
    setLineItems((p) => p.map((li, idx) => idx === i ? { ...li, unitPriceCents: cents, amountCents: Math.round(li.quantity * cents) } : li));
  }
  function addRow() {
    setLineItems((p) => [...p, { key: `manual-${Date.now()}`, name: "New item", category: "other" as EstimateLineItem["category"], unit: "each" as EstimateLineItem["unit"], quantity: 1, unitPriceCents: 0, amountCents: 0 }]);
  }
  function removeRow(i: number) { setLineItems((p) => p.filter((_, idx) => idx !== i)); }
  function handleSave() { startSave(async () => { await updateChangeOrderLineItemsAction({ changeOrderId: changeOrder.id, jobId, lineItems }); }); }
  function handleSend() {
    startSend(async () => {
      const r = await sendChangeOrderForSignatureAction(changeOrder.id, jobId);
      if ("ok" in r) toast.success("Sent for signature.");
      else if (r.error === "no_customer_email") toast.error("Add a customer email first.");
      else if (r.error === "no_template") toast.error("No change-order DocuSeal template configured.");
      else if (r.error === "docuseal_failed") toast.error("DocuSeal is not configured or unreachable.");
      else toast.error("Could not send.");
    });
  }

  return (
    <div data-testid="change-order-editor" className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link href={`/jobs/${jobId}`} className="text-sm text-muted-foreground hover:underline">← Back to job</Link>
        <div className="flex items-center gap-3">
          <span className="text-xs rounded px-2 py-0.5 bg-muted">{changeOrder.status}</span>
          <Button size="sm" variant="outline" disabled={savePending} onClick={handleSave}>{savePending ? "Saving…" : "Save"}</Button>
          <Button size="sm" disabled={sendPending || changeOrder.status !== "draft"} onClick={handleSend} data-testid="send-change-order-btn">
            {sendPending ? "Sending…" : "Send for signature"}
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader><CardTitle>Reason</CardTitle></CardHeader>
        <CardContent>
          <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why is the scope changing?" aria-label="Reason" />
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Line Items</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          {lineItems.map((li, i) => (
            <div key={li.key} data-testid="change-order-line" className="grid grid-cols-[1fr_6rem_6rem_6rem_2.5rem] items-center gap-2">
              <span className="truncate text-sm">{li.name}</span>
              <Input type="number" min={0} step="any" value={li.quantity} onChange={(e) => updateQty(i, e.target.value)} className="h-8 text-sm" aria-label="Quantity" />
              <Input type="number" min={0} step="0.01" value={(li.unitPriceCents / 100).toFixed(2)} onChange={(e) => updateUnitPrice(i, e.target.value)} className="h-8 text-sm" aria-label="Unit price" />
              <span className="text-sm font-medium">{fmtUsd(li.amountCents)}</span>
              <button type="button" onClick={() => removeRow(i)} className="h-8 w-8 rounded text-muted-foreground hover:bg-destructive/10" aria-label="Remove row">×</button>
            </div>
          ))}
          <Button type="button" variant="outline" size="sm" onClick={addRow}>+ Add row</Button>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-4">
          <div className="ml-auto max-w-xs flex justify-between border-t border-border pt-1.5 text-base font-semibold">
            <span>Total</span>
            <span data-testid="change-order-total">{fmtUsd(totalCents)}</span>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
```

Note: `reason` is local-only in this editor for display; persisting an edited reason is via the create action (set at creation). If you want Save to persist `reason` too, extend `updateChangeOrderLineItemsAction` to accept + set `reason` — optional, keep it to line items to match the estimate editor's scope.

- [ ] **Step 2: Route page (server)** — `apps/web/src/app/(app)/jobs/[id]/change-orders/[changeOrderId]/page.tsx` (mirror the estimate editor page — load via `getChangeOrder`, 404 if null, render the editor):

```tsx
import { notFound } from "next/navigation";
import { getChangeOrder } from "@/lib/change-order-queries";
import { ChangeOrderEditor } from "./ChangeOrderEditor";

export default async function ChangeOrderPage({ params }: { params: Promise<{ id: string; changeOrderId: string }> }) {
  const { id, changeOrderId } = await params;
  const co = await getChangeOrder(changeOrderId);
  if (!co) notFound();
  return (
    <div className="mx-auto max-w-3xl p-6">
      <ChangeOrderEditor changeOrder={co} jobId={id} />
    </div>
  );
}
```

(Confirm the estimate editor page's exact wrapper/container classes + `params` Promise shape and match them.)

- [ ] **Step 3: Typecheck + lint**

Run: `pnpm --filter @savvy/web typecheck && pnpm --filter @savvy/web lint`
Expected: PASS, 0 errors. (Confirm `Card`/`Input`/`Button` import paths + `sonner` `toast` match `EstimateEditor.tsx`/`DocsPanel.tsx`.)

- [ ] **Step 4: Commit**

```bash
git add "apps/web/src/app/(app)/jobs/[id]/change-orders"
git commit -m "feat(web): change-order editor + route"
```

---

## Task 10: Web — "Change orders" section on the job page

**Files:** Create `apps/web/src/app/(app)/jobs/[id]/ChangeOrdersSection.tsx`; Modify `apps/web/src/app/(app)/jobs/[id]/page.tsx`.

- [ ] **Step 1: Create-button client component** — `ChangeOrdersSection.tsx`:

```tsx
"use client";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { createChangeOrderAction } from "@/lib/change-order-actions";

export function ChangeOrdersSection({ jobId }: { jobId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  function handleCreate() {
    start(async () => {
      const r = await createChangeOrderAction({ jobId, reason: "", lineItems: [] });
      if ("ok" in r) router.push(`/jobs/${jobId}/change-orders/${r.id}`);
    });
  }
  return (
    <Button size="sm" variant="outline" disabled={pending} onClick={handleCreate} data-testid="create-change-order-btn">
      {pending ? "Creating…" : "+ Create change order"}
    </Button>
  );
}
```

- [ ] **Step 2: Render the section on the job page** — in `apps/web/src/app/(app)/jobs/[id]/page.tsx`:
  (a) import `listChangeOrdersForJob` from `@/lib/change-order-queries` and `ChangeOrdersSection` from `./ChangeOrdersSection`.
  (b) Where the page fetches estimates (the `Promise.all([listEstimatesForJob(id), ...])`), add `listChangeOrdersForJob(id)` to the parallel fetch.
  (c) After the existing Estimates `<Card>`, add a Change-orders `<Card>` (mirror the estimates card markup) — header "Change orders", `<ChangeOrdersSection jobId={id} />`, then a list of `changeOrders` rows each a `<Link href={\`/jobs/${id}/change-orders/${co.id}\`}>` showing reason/total/status (reuse the estimates row markup + the page's `fmtUsd`). Empty state: "No change orders yet."

```tsx
      {/* Change orders section */}
      <Card>
        <CardHeader><CardTitle>Change orders</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <ChangeOrdersSection jobId={id} />
          {changeOrders.length > 0 ? (
            <div className="space-y-2">
              {changeOrders.map((co) => (
                <Link key={co.id} href={`/jobs/${id}/change-orders/${co.id}`} className="block" data-testid="change-order-row">
                  <div className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-sm hover:bg-muted/50 transition-colors">
                    <span className="text-muted-foreground truncate">{co.reason || "Change order"}</span>
                    <div className="flex items-center gap-3">
                      <span className="font-medium">{fmtUsd(co.total)}</span>
                      <span className="inline-flex items-center rounded px-2 py-0.5 text-xs font-medium bg-muted text-muted-foreground">{co.status}</span>
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No change orders yet.</p>
          )}
        </CardContent>
      </Card>
```

(Confirm the page's `fmtUsd` accepts `number | null` like the estimates use; if it takes `number`, pass `co.total ?? 0`.)

- [ ] **Step 3: Typecheck + lint**

Run: `pnpm --filter @savvy/web typecheck && pnpm --filter @savvy/web lint`
Expected: PASS, 0 errors.

- [ ] **Step 4: Commit**

```bash
git add "apps/web/src/app/(app)/jobs/[id]/ChangeOrdersSection.tsx" "apps/web/src/app/(app)/jobs/[id]/page.tsx"
git commit -m "feat(web): change-orders section on job detail"
```

---

## Task 11: e2e + env

**Files:** Create `apps/web/tests/e2e/change-order.spec.ts`; Modify `apps/web/playwright.config.ts`, `.env.example`.

- [ ] **Step 1: Add the change-order template env to the webServer** — in `apps/web/playwright.config.ts`, in the `webServer.env` block (next to `DOCUSEAL_TEMPLATE_LIEN_WAIVER`/`DOCUSEAL_TEMPLATE_CERT`), add:

```typescript
      DOCUSEAL_TEMPLATE_CHANGE_ORDER: "3",
```

(Leave `DOCUSEAL_API_KEY` unset so the fake gateway is used — same as the estimate/esign e2e. The non-empty template id keeps `sendChangeOrderForSignatureAction` from short-circuiting on `no_template`.)

- [ ] **Step 2: Write the e2e** — `apps/web/tests/e2e/change-order.spec.ts` (mirror `estimate.spec.ts`: seed via adminDb, drive the UI, post the `form.completed` webhook, assert downstream via a poll helper):

```typescript
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { adminDb, withTenant, tenant, customer, property, job, changeOrder, invoice, eq } from "@savvy/db";

const { id: tenantId } = JSON.parse(readFileSync("/tmp/savvy-e2e-tenant.json", "utf8")) as { id: string };

async function waitFor<T>(fn: () => Promise<T | undefined>, ms = 30_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 500));
  }
}

test("change order: create -> send -> webhook -> approved + draft invoice", async ({ page, request }) => {
  const stamp = randomUUID().slice(0, 8);
  const [cust] = await adminDb.insert(customer).values({ tenantId, name: `CO Carl ${stamp}`, email: `co-${stamp}@e2e.test` }).returning();
  const [prop] = await adminDb.insert(property).values({ tenantId, customerId: cust!.id, address: `${stamp} CO Way` }).returning();
  const [j] = await adminDb.insert(job).values({ tenantId, customerId: cust!.id, propertyId: prop!.id, type: "retail", stage: "production", valueFinal: 100000 }).returning();
  const jobId = j!.id;

  // create + add a line item via the editor
  await page.goto(`/jobs/${jobId}`);
  await expect(page.getByTestId("job-detail")).toBeVisible();
  await page.getByTestId("create-change-order-btn").click();
  await expect(page.getByTestId("change-order-editor")).toBeVisible();
  await page.getByRole("button", { name: "+ Add row" }).click();
  await page.getByLabel("Unit price").fill("250.00"); // $250
  await page.getByRole("button", { name: "Save" }).click();

  // send for signature -> records a submission id
  await page.getByTestId("send-change-order-btn").click();
  const sent = await waitFor(async () => {
    const [row] = await adminDb.select().from(changeOrder).where(eq(changeOrder.jobId, jobId));
    return row?.status === "sent" && row.docusealSubmissionId ? row : undefined;
  });

  // simulate the DocuSeal form.completed webhook
  const res = await request.post("/api/docuseal/webhook", {
    data: { event_type: "form.completed", data: { submission_id: sent.docusealSubmissionId } },
  });
  expect(res.ok()).toBe(true);

  // approved + valueFinal bumped + draft supplemental invoice
  const approved = await waitFor(async () => {
    const [row] = await adminDb.select().from(changeOrder).where(eq(changeOrder.id, sent.id));
    return row?.status === "approved" && row.applied ? row : undefined;
  });
  expect(approved.approvedAt).not.toBeNull();
  const [jobAfter] = await withTenant(tenantId, (tx) => tx.select().from(job).where(eq(job.id, jobId)));
  expect(jobAfter!.valueFinal).toBe(125000);
  const invs = await adminDb.select().from(invoice).where(eq(invoice.jobId, jobId));
  expect(invs.length).toBe(1);
  expect(invs[0]!.status).toBe("draft");
  expect(invs[0]!.amountDue).toBe(25000);
});
```

(The `getByLabel("Unit price")` targets the single added row's unit-price input. If multiple match, scope with `.first()`. The `changeOrderAccepted` Inngest fn needs the inngest-dev server in the harness — the estimate e2e already relies on it.)

- [ ] **Step 3: Document the env** — in `.env.example`, under the DocuSeal section, add:

```bash
# Change-order signing template (Phase 6C).
DOCUSEAL_TEMPLATE_CHANGE_ORDER=
```

- [ ] **Step 4: Run the e2e (full harness — same pattern as estimate.spec.ts)**

From repo root with Docker Postgres up:
```bash
export DATABASE_URL=postgres://savvy_app:savvy_app@localhost:5432/savvy
export DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/savvy
export AI_STUB_PORT=4010 INNGEST_DEV=1
node apps/web/tests/e2e/ai-stub.mjs &
npx --yes inngest-cli@latest dev -u http://localhost:3000/api/inngest --no-discovery &
pnpm --filter @savvy/web exec tsx tests/e2e/create-tenant.ts
export TEST_TENANT_ID=$(node -e "console.log(require('/tmp/savvy-e2e-tenant.json').id)")
pnpm --filter @savvy/web exec playwright test change-order.spec.ts
```
Expected: PASS. Kill the backgrounded services after. (If inngest-dev is flaky locally, CI runs the full e2e matrix — the DB/agents integration tests in Tasks 5–6 already cover the approval logic deterministically.)

- [ ] **Step 5: Commit**

```bash
git add apps/web/tests/e2e/change-order.spec.ts apps/web/playwright.config.ts .env.example
git commit -m "test(e2e): change order create -> sign -> approved + draft invoice"
```

---

## Task 12: Full gate

- [ ] **Step 1: Relink + gate**

```bash
pnpm install
pnpm typecheck && pnpm lint && pnpm test
```
Expected: typecheck clean; lint 0 errors (pre-existing test-file WARNINGS OK); all tests green (prior suite + new core/db/agents change-order tests).

- [ ] **Step 2: Commit (if `pnpm install` changed the lockfile)**

```bash
git add -A
git commit -m "chore: phase 6C gate green" || echo "nothing to commit"
```

---

## Self-Review — Spec Coverage

| Spec section | Task |
|---|---|
| §2 money effect (value + supplemental invoice) | Task 5 (`approveChangeOrder`) |
| §2 DocuSeal e-sign approval | Tasks 7 (webhook) + 8 (send action) |
| §2 line items: price book + manual, reuse `EstimateLineItem` | Tasks 1, 9 |
| §2 ± deltas (invoice only when total>0) | Task 5 + tests |
| §2 no stage gating | No stage-change code touched (verified) |
| §4 `change_order` table + migration 0010 + unique idempotency | Task 2 |
| §4.1 `applied` flag | Task 2 (column) + Task 5 (guard) |
| §5 `computeChangeOrderTotal` (no tax) | Task 1 |
| §6 createChangeOrder/sendChangeOrder/markChangeOrderBySubmission/approveChangeOrder | Tasks 4, 5 |
| §7 webhook third branch | Task 7 |
| §8 `changeOrderAccepted` durable + idempotent + agent_run | Task 6 |
| §9 send action (email/template/DocuSeal-outside-tx/fake fallback) | Task 8 |
| §10 editor + section UI | Tasks 9, 10 |
| §11 error handling | Tasks 7 (401/no-op), 8 (typed errors) |
| §12 tests (unit/DB/agents/RLS/e2e) | Tasks 1,3,4,5,6,11 |
| §13 DoD (env documented, base main) | Tasks 11, 12 |

**Deliberate refinements vs spec (flagged):**
- Change-order lines reuse `EstimateLineItem` (not a new `ChangeOrderLine` type) so the editor reuses the Phase 7 estimate-editor pattern — DRYer. `computeChangeOrderTotal` sums `amountCents`.
- The supplemental invoice is inserted **directly as a draft** (mirroring `createInvoiceFromEstimate`), NOT via `createInvoice` (whose `{qty, unitAmountCents}` line summing differs) and NOT auto-sent — the rep sends it via `/invoices`. Auto-send is a tracked follow-up.
- The webhook esign branch now `return`s on a match (was fall-through) so an esign match doesn't also run the change-order lookup — behavior for estimate/esign is unchanged.

**Type consistency:** `markChangeOrderBySubmission → { tenantId, changeOrderId, changed }` matches the webhook usage (Task 7). `approveChangeOrder → { invoiceCreated }` matches `applyAcceptedChangeOrder` (Task 6) + the test. `change_order/accepted { changeOrderId, tenantId }` is identical in client.ts (Task 6), the webhook emit (Task 7), and the fn input (Task 6). `EstimateLineItem` is the row shape across Tasks 1/8/9. ✓
