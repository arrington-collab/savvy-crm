# Phase 5A — Finance Money Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A tenant connects Stripe (Connect Standard), creates/sends invoices (direct or from an accepted estimate), the customer pays via Stripe Checkout (card/ACH) on the tenant's account, and a signature-verified idempotent webhook reconciles the payment → invoice `paid`.

**Architecture:** Savvy owns the invoice (pure total math in `@savvy/core`, transactional lifecycle in `@savvy/db`). Stripe is wrapped behind a `StripeGateway` interface in `@savvy/integrations` (+ `makeFakeStripe`). Connect uses Stripe's own OAuth with an HMAC `state`. Reconciliation is webhook-driven; idempotency is a DB unique index. Money is integer cents throughout.

**Tech Stack:** Next.js 16, Drizzle + Postgres (RLS), Inngest, Stripe (Connect Standard + Checkout + webhooks), Vitest + Playwright.

**Spec:** `docs/superpowers/specs/2026-06-10-phase5a-finance-money-path-design.md`

## Conventions (read once)
- Imports: drizzle operators + tables from `@savvy/db`; `z` from `@savvy/core`; senders/gateways from `@savvy/integrations`. Never import `drizzle-orm`/`zod`/`stripe` directly in app/agent source.
- **No `.js`** on relative imports in SOURCE. In-package **db test files** DO use `.js`.
- Every tenant DB access goes through `withTenant(tenantId, tx => …)`. Reading the `tenant` row inside `withTenant` is allowed (savvy_app has SELECT, not UPDATE — Phase 4 reminders does this). Writing `tenant` uses `adminDb`.
- DB env for migrate/test:
  ```bash
  export DATABASE_URL=postgres://savvy_app:savvy_app@localhost:5432/savvy
  export DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/savvy
  ```
- Money is **integer cents** everywhere; format to dollars only in UI.
- Static gate after each task: `pnpm typecheck && pnpm lint && pnpm test`. Append-to-existing-test-file imports go at the TOP (a mid-file `import` causes TS2300).

## File structure (created / modified)

| File | Responsibility |
|---|---|
| `packages/core/src/enums.ts` (M) | `INVOICE_STATUS`, `PAYMENT_METHOD` + types |
| `packages/core/src/finance.ts` (C) | `LineItem`, `computeInvoiceTotal`, `formatInvoiceNumber`, `parseFinanceConfig` |
| `packages/core/src/index.ts` (M) | export `./finance` |
| `packages/db/src/schema/enums.ts` (M) | `invoiceStatusEnum`, `paymentMethodEnum` |
| `packages/db/src/schema/finance.ts` (M) | invoice: enum status + customerId + checkout/pi ids + number index; payment: enum method + stripePaymentId unique index |
| `packages/db/src/schema/tenancy.ts` (M) | `tenant.stripeAccountId` |
| `packages/db/drizzle/0004_*.sql` (C) | enums + text→enum conversions + columns + indexes |
| `packages/db/src/lifecycle/invoices.ts` (C) | `createInvoice`, `createInvoiceFromEstimate`, `sendInvoice`, `voidInvoice`, `recordStripePayment`, `StripeNotConnectedError` |
| `packages/db/tests/invoices.test.ts` (C) | lifecycle + idempotency + RLS |
| `packages/integrations/src/stripe.ts` (C) | `StripeGateway`, `stripeGateway`, `makeFakeStripe` |
| `packages/integrations/src/index.ts` (M) | export stripe |
| `packages/agents/src/client.ts` (M) | `invoice/sent`, `invoice/paid` events |
| `apps/web/src/lib/finance-queries.ts` (C) | invoice list/detail reads |
| `apps/web/src/lib/finance-actions.ts` (C) | create/send/void/from-estimate + `createCheckoutForInvoice` |
| `apps/web/src/lib/stripe-connection.ts` (C) | `getStripeConnection` |
| `apps/web/src/app/api/stripe/connect/start/route.ts` (C) | Connect OAuth start |
| `apps/web/src/app/api/stripe/connect/callback/route.ts` (C) | Connect OAuth callback |
| `apps/web/src/app/api/stripe/webhook/route.ts` (C) | reconciliation webhook |
| `apps/web/src/middleware.ts` (M) | add `/api/stripe/webhook` to PUBLIC |
| `apps/web/src/app/(app)/invoices/*` (C) | list + detail + create UI |
| `apps/web/src/app/(app)/settings/payments/*` (C) | Connect Stripe button + status |
| `.env.example` (M) | Stripe env |
| `apps/web/tests/e2e/finance.spec.ts` (C) | e2e money path |

---

## Task 1: Invoice + payment enums in `@savvy/core`

**Files:** Modify `packages/core/src/enums.ts`; Test `packages/core/src/enums.test.ts`

- [ ] **Step 1: Failing test** — append to `packages/core/src/enums.test.ts` (add `INVOICE_STATUS, PAYMENT_METHOD` to the EXISTING top `./enums` import; do NOT add a mid-file import):

```ts
test("finance enums", () => {
  expect(INVOICE_STATUS).toEqual(["draft", "sent", "paid", "overdue", "void"]);
  expect(PAYMENT_METHOD).toEqual(["card", "ach", "check", "insurance", "mortgage"]);
});
```

- [ ] **Step 2: Run, expect fail** — `pnpm --filter @savvy/core exec vitest run enums` → FAIL.

- [ ] **Step 3: Implement** — append to `packages/core/src/enums.ts`:

```ts
// --- Phase 5 (finance) ---
export const INVOICE_STATUS = ["draft", "sent", "paid", "overdue", "void"] as const;
export const PAYMENT_METHOD = ["card", "ach", "check", "insurance", "mortgage"] as const;
export type InvoiceStatus = (typeof INVOICE_STATUS)[number];
export type PaymentMethod = (typeof PAYMENT_METHOD)[number];
```

- [ ] **Step 4: Run, expect pass** — same command → PASS.

- [ ] **Step 5: Commit**
```bash
git add packages/core/src/enums.ts packages/core/src/enums.test.ts
git commit -m "feat(core): invoice status + payment method enums"
```

---

## Task 2: Finance pure helpers + config (`@savvy/core`)

**Files:** Create `packages/core/src/finance.ts`; Modify `packages/core/src/index.ts`; Test `packages/core/src/finance.test.ts`

- [ ] **Step 1: Failing test** — `packages/core/src/finance.test.ts`:

```ts
import { test, expect } from "vitest";
import { computeInvoiceTotal, formatInvoiceNumber, parseFinanceConfig } from "./finance";

test("computeInvoiceTotal sums qty*unitAmountCents", () => {
  expect(computeInvoiceTotal([])).toBe(0);
  expect(computeInvoiceTotal([{ description: "Roof", qty: 2, unitAmountCents: 150000 }])).toBe(300000);
  expect(computeInvoiceTotal([
    { description: "A", qty: 1, unitAmountCents: 999 },
    { description: "B", qty: 3, unitAmountCents: 100 },
  ])).toBe(1299);
});

test("formatInvoiceNumber zero-pads to 6", () => {
  expect(formatInvoiceNumber("INV-", 123)).toBe("INV-000123");
  expect(formatInvoiceNumber("INV-", 1)).toBe("INV-000001");
});

test("parseFinanceConfig fills defaults", () => {
  expect(parseFinanceConfig(undefined)).toEqual({ netDays: 14, invoiceNumberPrefix: "INV-" });
  expect(parseFinanceConfig({ netDays: 30 })).toEqual({ netDays: 30, invoiceNumberPrefix: "INV-" });
});
```

- [ ] **Step 2: Run, expect fail** — `pnpm --filter @savvy/core exec vitest run finance` → FAIL.

- [ ] **Step 3: Implement** — `packages/core/src/finance.ts`:

```ts
import { z } from "./schemas";

export type LineItem = { description: string; qty: number; unitAmountCents: number };

export function computeInvoiceTotal(items: LineItem[]): number {
  return items.reduce((sum, i) => sum + i.qty * i.unitAmountCents, 0);
}

export function formatInvoiceNumber(prefix: string, seq: number): string {
  return `${prefix}${String(seq).padStart(6, "0")}`;
}

const financeSchema = z.object({
  netDays: z.number().int().positive().default(14),
  invoiceNumberPrefix: z.string().default("INV-"),
});

export type FinanceConfig = { netDays: number; invoiceNumberPrefix: string };

export function parseFinanceConfig(raw: unknown): FinanceConfig {
  return financeSchema.parse(raw ?? {});
}
```

- [ ] **Step 4:** add to `packages/core/src/index.ts`: `export * from "./finance";`

- [ ] **Step 5: Run, expect pass** — same command → PASS. Then `pnpm --filter @savvy/core typecheck`.

- [ ] **Step 6: Commit**
```bash
git add packages/core/src/finance.ts packages/core/src/finance.test.ts packages/core/src/index.ts
git commit -m "feat(core): invoice total + number formatting + finance config"
```

---

## Task 3: Finance schema changes (`@savvy/db`)

**Files:** Modify `packages/db/src/schema/enums.ts`, `packages/db/src/schema/finance.ts`, `packages/db/src/schema/tenancy.ts`

> Schema edits only — NO migration generation (Task 4), NO test.

- [ ] **Step 1: Enums** — in `packages/db/src/schema/enums.ts` add `INVOICE_STATUS, PAYMENT_METHOD` to the `@savvy/core` import and append:
```ts
export const invoiceStatusEnum = pgEnum("invoice_status", INVOICE_STATUS);
export const paymentMethodEnum = pgEnum("payment_method", PAYMENT_METHOD);
```

- [ ] **Step 2: tenant** — in `packages/db/src/schema/tenancy.ts` add to the `tenant` table columns:
```ts
stripeAccountId: text("stripe_account_id"),
```
(`text` is already imported there.)

- [ ] **Step 3: invoice + payment** — in `packages/db/src/schema/finance.ts`:
  - Add to imports: `uniqueIndex` from `drizzle-orm/pg-core`; `invoiceStatusEnum, paymentMethodEnum` from `./enums`; `sql` from `drizzle-orm`; `customer` from `./crm`.
  - Replace the `invoice` table:
```ts
export const invoice = pgTable("invoice", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  jobId: uuid("job_id").notNull().references(() => job.id),
  customerId: uuid("customer_id").references(() => customer.id),
  number: text("number"),
  status: invoiceStatusEnum("status").notNull().default("draft"),
  lineItems: jsonb("line_items").$type<unknown[]>().default([]).notNull(),
  amountDue: integer("amount_due"),
  amountPaid: integer("amount_paid").default(0).notNull(),
  dueAt: timestamp("due_at", { withTimezone: true }),
  stripeCheckoutSessionId: text("stripe_checkout_session_id"),
  stripePaymentIntentId: text("stripe_payment_intent_id"),
  stripeInvoiceId: text("stripe_invoice_id"),
  qboId: text("qbo_id"),
  createdAt: createdAt(),
}, (t) => [
  index("invoice_tenant_status_idx").on(t.tenantId, t.status),
  uniqueIndex("invoice_tenant_number_uniq").on(t.tenantId, t.number).where(sql`number IS NOT NULL`),
  tenantIsolation(),
]);
```
  - Replace the `payment` table:
```ts
export const payment = pgTable("payment", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  invoiceId: uuid("invoice_id").notNull().references(() => invoice.id),
  method: paymentMethodEnum("method").notNull(),
  amount: integer("amount").notNull(),
  stripePaymentId: text("stripe_payment_id"),
  receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index("payment_tenant_invoice_idx").on(t.tenantId, t.invoiceId),
  uniqueIndex("payment_stripe_pmt_uniq").on(t.tenantId, t.stripePaymentId).where(sql`stripe_payment_id IS NOT NULL`),
  tenantIsolation(),
]);
```

- [ ] **Step 4: Typecheck** — `pnpm --filter @savvy/db typecheck` → PASS.

- [ ] **Step 5: Commit**
```bash
git add packages/db/src/schema/enums.ts packages/db/src/schema/finance.ts packages/db/src/schema/tenancy.ts
git commit -m "feat(db): finance schema — invoice/payment enums + stripe cols + idempotency indexes"
```

---

## Task 4: Migration 0004 + integration test

**Files:** Create `packages/db/drizzle/0004_*.sql`; Create `packages/db/tests/invoices.test.ts` (constraint part)

> The `invoice.status` / `payment.method` text→enum conversions need hand-fixes drizzle-kit omits (same as Phase 4 migration 0003: `USING col::enum`, and for a column WITH a default: drop default → alter type USING → restore default). Local volume is disposable.

- [ ] **Step 1: Generate** —
```bash
export DATABASE_URL=postgres://savvy_app:savvy_app@localhost:5432/savvy DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/savvy
pnpm db:up
pnpm db:generate
```
If it hangs on a prompt >20s, Ctrl-C and report BLOCKED with the prompt text.

- [ ] **Step 2: Hand-fix the generated `0004_*.sql`** — ensure the enum-conversion statements are:
```sql
-- invoice.status: drop default, cast with USING, restore default
ALTER TABLE "invoice" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "invoice" ALTER COLUMN "status" SET DATA TYPE invoice_status USING status::invoice_status;
ALTER TABLE "invoice" ALTER COLUMN "status" SET DEFAULT 'draft';
-- payment.method: no default, just cast with USING
ALTER TABLE "payment" ALTER COLUMN "method" SET DATA TYPE payment_method USING method::payment_method;
```
(Drizzle-kit emits the `CREATE TYPE`, the new columns, and the indexes; you only add the `USING`/default dance if it didn't. Verify the file applies cleanly.)

- [ ] **Step 3: Reset + migrate** —
```bash
export DATABASE_URL=postgres://savvy_app:savvy_app@localhost:5432/savvy DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/savvy
docker compose down -v && docker compose up -d && sleep 4
pnpm db:migrate
```
Expect clean apply.

- [ ] **Step 4: Constraint test** — create `packages/db/tests/invoices.test.ts` (mirror `appointments.test.ts`; `.js` imports; reuse `./helpers.js` `makeTenant`/`makeJobWithCustomer`). Just the idempotency-index test for now:
```ts
import { describe, it, expect, beforeAll } from "vitest";
import { withTenant } from "../src/tenant.js";
import { invoice, payment } from "../src/schema/finance.js";
import { makeTenant, makeJobWithCustomer } from "./helpers.js";

describe("payment idempotency index", () => {
  let tenantId: string, jobId: string, invoiceId: string;
  beforeAll(async () => {
    ({ tenantId } = await makeTenant());
    ({ jobId } = await makeJobWithCustomer(tenantId));
    invoiceId = await withTenant(tenantId, async (tx) => {
      const [inv] = await tx.insert(invoice).values({ tenantId, jobId, amountDue: 10000 }).returning({ id: invoice.id });
      return inv!.id;
    });
  });

  it("rejects a duplicate stripe_payment_id for the same tenant", async () => {
    await withTenant(tenantId, (tx) => tx.insert(payment).values({
      tenantId, invoiceId, method: "card", amount: 10000, stripePaymentId: "pi_dup",
    }));
    await expect(
      withTenant(tenantId, (tx) => tx.insert(payment).values({
        tenantId, invoiceId, method: "card", amount: 10000, stripePaymentId: "pi_dup",
      })),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("allows multiple null stripe_payment_id (manual payments)", async () => {
    await withTenant(tenantId, (tx) => tx.insert(payment).values({ tenantId, invoiceId, method: "check", amount: 100 }));
    await expect(
      withTenant(tenantId, (tx) => tx.insert(payment).values({ tenantId, invoiceId, method: "check", amount: 200 })),
    ).resolves.toBeDefined();
  });
});
```

- [ ] **Step 5: Run + verify whole db suite** —
```bash
export DATABASE_URL=... DATABASE_ADMIN_URL=...
pnpm --filter @savvy/db exec vitest run
```
Expect all green (isolation, lifecycle, appointments, stop-drip, invoices).

- [ ] **Step 6: Commit**
```bash
git add packages/db/drizzle packages/db/tests/invoices.test.ts
git commit -m "feat(db): migration 0004 — finance enums, stripe cols, payment idempotency index"
```

---

## Task 5: Invoice lifecycle helpers (`@savvy/db`)

**Files:** Create `packages/db/src/lifecycle/invoices.ts`; Modify `packages/db/src/index.ts`; extend `packages/db/tests/invoices.test.ts`

- [ ] **Step 1: Failing tests** — append to `packages/db/tests/invoices.test.ts` (add the lifecycle import at top, `.js`):
```ts
import {
  createInvoice, createInvoiceFromEstimate, sendInvoice, voidInvoice,
  recordStripePayment, StripeNotConnectedError,
} from "../src/lifecycle/invoices.js";
import { estimate } from "../src/schema/finance.js";
import { tenant } from "../src/schema/tenancy.js";
import { adminDb } from "../src/admin-client.js";
import { eq } from "drizzle-orm";

describe("invoice lifecycle", () => {
  let tenantId: string, jobId: string;
  beforeAll(async () => {
    ({ tenantId } = await makeTenant());
    ({ jobId } = await makeJobWithCustomer(tenantId));
  });

  it("createInvoice computes amountDue from line items", async () => {
    const inv = await createInvoice({ tenantId, jobId, lineItems: [
      { description: "Roof", qty: 1, unitAmountCents: 500000 },
      { description: "Gutters", qty: 2, unitAmountCents: 25000 },
    ]});
    expect(inv.amountDue).toBe(550000);
    expect(inv.status).toBe("draft");
  });

  it("sendInvoice blocks without a connected Stripe account", async () => {
    const inv = await createInvoice({ tenantId, jobId, lineItems: [{ description: "X", qty: 1, unitAmountCents: 100 }] });
    await expect(sendInvoice({ tenantId, invoiceId: inv.id })).rejects.toBeInstanceOf(StripeNotConnectedError);
  });

  it("sendInvoice assigns sequential number + due date once Stripe connected", async () => {
    await adminDb.update(tenant).set({ stripeAccountId: "acct_test" }).where(eq(tenant.id, tenantId));
    const a = await createInvoice({ tenantId, jobId, lineItems: [{ description: "A", qty: 1, unitAmountCents: 100 }] });
    const b = await createInvoice({ tenantId, jobId, lineItems: [{ description: "B", qty: 1, unitAmountCents: 100 }] });
    const sa = await sendInvoice({ tenantId, invoiceId: a.id });
    const sb = await sendInvoice({ tenantId, invoiceId: b.id });
    expect(sa.number).toMatch(/^INV-\d{6}$/);
    expect(sb.number).not.toBe(sa.number);
    expect(sa.status).toBe("sent");
    expect(sa.dueAt).toBeTruthy();
  });

  it("recordStripePayment is idempotent and flips to paid when fully paid", async () => {
    const inv = await createInvoice({ tenantId, jobId, lineItems: [{ description: "P", qty: 1, unitAmountCents: 10000 }] });
    const r1 = await recordStripePayment({ tenantId, invoiceId: inv.id, stripePaymentId: "pi_1", method: "card", amountCents: 10000 });
    expect(r1).toEqual({ alreadyRecorded: false, nowPaid: true });
    const r2 = await recordStripePayment({ tenantId, invoiceId: inv.id, stripePaymentId: "pi_1", method: "card", amountCents: 10000 });
    expect(r2.alreadyRecorded).toBe(true);
  });

  it("partial payment keeps status sent", async () => {
    const inv = await createInvoice({ tenantId, jobId, lineItems: [{ description: "Q", qty: 1, unitAmountCents: 10000 }] });
    const r = await recordStripePayment({ tenantId, invoiceId: inv.id, stripePaymentId: "pi_partial", method: "ach", amountCents: 4000 });
    expect(r.nowPaid).toBe(false);
  });

  it("createInvoiceFromEstimate copies items and accepts the estimate", async () => {
    const estId = await withTenant(tenantId, async (tx) => {
      const [e] = await tx.insert(estimate).values({
        tenantId, jobId, status: "sent",
        lineItems: [{ description: "Est", qty: 1, unitAmountCents: 0 }], total: 777,
      }).returning({ id: estimate.id });
      return e!.id;
    });
    const inv = await createInvoiceFromEstimate({ tenantId, estimateId: estId });
    expect(inv.amountDue).toBe(777);
    const e = await withTenant(tenantId, async (tx) => (await tx.select().from(estimate).where(eq(estimate.id, estId)))[0]);
    expect(e!.status).toBe("accepted");
  });

  it("voidInvoice sets void", async () => {
    const inv = await createInvoice({ tenantId, jobId, lineItems: [{ description: "V", qty: 1, unitAmountCents: 1 }] });
    await voidInvoice({ tenantId, invoiceId: inv.id });
  });
});
```

- [ ] **Step 2: Run, expect fail** — `pnpm --filter @savvy/db exec vitest run invoices` → FAIL (module not found).

- [ ] **Step 3: Implement** — `packages/db/src/lifecycle/invoices.ts`:
```ts
import { withTenant } from "../tenant";
import { invoice, payment, estimate } from "../schema/finance";
import { job } from "../schema/jobs";
import { tenant } from "../schema/tenancy";
import { and, eq, sql } from "drizzle-orm";
import { computeInvoiceTotal, formatInvoiceNumber, parseFinanceConfig, type LineItem } from "@savvy/core";
import type { PaymentMethod } from "@savvy/core";

export class StripeNotConnectedError extends Error {
  constructor() { super("stripe_not_connected"); this.name = "StripeNotConnectedError"; }
}

type InvoiceRow = typeof invoice.$inferSelect;

export async function createInvoice(input: {
  tenantId: string; jobId: string; lineItems: LineItem[];
}): Promise<InvoiceRow> {
  return withTenant(input.tenantId, async (tx) => {
    const [j] = await tx.select().from(job).where(eq(job.id, input.jobId));
    const amountDue = computeInvoiceTotal(input.lineItems);
    const [row] = await tx.insert(invoice).values({
      tenantId: input.tenantId, jobId: input.jobId, customerId: j?.customerId ?? null,
      lineItems: input.lineItems, amountDue, status: "draft",
    }).returning();
    return row!;
  });
}

export async function createInvoiceFromEstimate(input: {
  tenantId: string; estimateId: string;
}): Promise<InvoiceRow> {
  return withTenant(input.tenantId, async (tx) => {
    const [e] = await tx.select().from(estimate).where(eq(estimate.id, input.estimateId));
    if (!e) throw new Error("estimate not found");
    const [j] = await tx.select().from(job).where(eq(job.id, e.jobId));
    const [row] = await tx.insert(invoice).values({
      tenantId: input.tenantId, jobId: e.jobId, customerId: j?.customerId ?? null,
      lineItems: e.lineItems as unknown[], amountDue: e.total ?? 0, status: "draft",
    }).returning();
    await tx.update(estimate).set({ status: "accepted" }).where(eq(estimate.id, input.estimateId));
    return row!;
  });
}

export async function sendInvoice(input: { tenantId: string; invoiceId: string }): Promise<InvoiceRow> {
  return withTenant(input.tenantId, async (tx) => {
    const [t] = await tx.select().from(tenant).where(eq(tenant.id, input.tenantId));
    if (!t?.stripeAccountId) throw new StripeNotConnectedError();
    const cfg = parseFinanceConfig((t.settings as { finance?: unknown })?.finance);
    // Serialize per-tenant number assignment so concurrent sends can't collide.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${input.tenantId}))`);
    const [{ cnt }] = await tx.select({ cnt: sql<number>`count(*)::int` }).from(invoice)
      .where(and(eq(invoice.tenantId, input.tenantId), sql`number is not null`));
    const number = formatInvoiceNumber(cfg.invoiceNumberPrefix, cnt + 1);
    const dueAt = new Date(Date.now() + cfg.netDays * 86400_000);
    const [row] = await tx.update(invoice)
      .set({ number, dueAt, status: "sent" })
      .where(and(eq(invoice.id, input.invoiceId), eq(invoice.status, "draft")))
      .returning();
    return row!;
  });
}

export async function voidInvoice(input: { tenantId: string; invoiceId: string }): Promise<void> {
  await withTenant(input.tenantId, (tx) => tx.update(invoice).set({ status: "void" }).where(eq(invoice.id, input.invoiceId)));
}

export async function recordStripePayment(input: {
  tenantId: string; invoiceId: string; stripePaymentId: string;
  method: PaymentMethod; amountCents: number;
}): Promise<{ alreadyRecorded: boolean; nowPaid: boolean }> {
  return withTenant(input.tenantId, async (tx) => {
    // Idempotency: bail if this stripe payment is already recorded.
    const dup = await tx.select({ id: payment.id }).from(payment)
      .where(and(eq(payment.tenantId, input.tenantId), eq(payment.stripePaymentId, input.stripePaymentId)));
    if (dup.length > 0) return { alreadyRecorded: true, nowPaid: false };

    await tx.insert(payment).values({
      tenantId: input.tenantId, invoiceId: input.invoiceId, method: input.method,
      amount: input.amountCents, stripePaymentId: input.stripePaymentId,
    });
    const [inv] = await tx.select().from(invoice).where(eq(invoice.id, input.invoiceId));
    const amountPaid = (inv?.amountPaid ?? 0) + input.amountCents;
    const nowPaid = amountPaid >= (inv?.amountDue ?? 0);
    await tx.update(invoice).set({
      amountPaid, ...(nowPaid ? { status: "paid" as const, stripePaymentIntentId: input.stripePaymentId } : {}),
    }).where(eq(invoice.id, input.invoiceId));
    return { alreadyRecorded: false, nowPaid };
  });
}
```
> The unique index on `(tenant_id, stripe_payment_id)` is the race backstop; the in-tx `dup` check returns a friendly `alreadyRecorded` for the common (sequential webhook retry) case. If two webhooks race past the check, the second insert hits `23505` — the webhook route (Task 10) catches it and treats it as already-recorded.

- [ ] **Step 4: Export** — add to `packages/db/src/index.ts`:
```ts
export {
  createInvoice, createInvoiceFromEstimate, sendInvoice, voidInvoice,
  recordStripePayment, StripeNotConnectedError,
} from "./lifecycle/invoices";
```

- [ ] **Step 5: Run, expect pass** — `pnpm --filter @savvy/db exec vitest run invoices` → PASS (all). Then `pnpm --filter @savvy/db typecheck`.

- [ ] **Step 6: Commit**
```bash
git add packages/db/src/lifecycle/invoices.ts packages/db/src/index.ts packages/db/tests/invoices.test.ts
git commit -m "feat(db): invoice lifecycle (create/from-estimate/send/void/record-payment)"
```

---

## Task 6: Stripe gateway (`@savvy/integrations`)

**Files:** Create `packages/integrations/src/stripe.ts`; Modify `packages/integrations/src/index.ts`, `packages/integrations/package.json`, `.env.example`; Test `packages/integrations/src/stripe.test.ts`

- [ ] **Step 1: Add the `stripe` dependency**
```bash
cd /Users/arrington/Sites/savvy-crm
pnpm --filter @savvy/integrations add stripe
```
(This updates `packages/integrations/package.json` + `pnpm-lock.yaml` — commit both.)

- [ ] **Step 2: Failing test** — `packages/integrations/src/stripe.test.ts`:
```ts
import { test, expect } from "vitest";
import { makeFakeStripe } from "./stripe";

test("fake stripe creates a checkout session + parses webhook events", async () => {
  const fake = makeFakeStripe();
  const s = await fake.createCheckoutSession({
    connectedAccountId: "acct_1", amountCents: 50000, invoiceId: "inv1", tenantId: "t1",
    description: "INV-000001", successUrl: "https://x/ok", cancelUrl: "https://x/no",
  });
  expect(s.id).toMatch(/^cs_fake_/);
  expect(s.url).toContain("http");
  expect(fake.calls[0]).toMatchObject({ op: "checkout", connectedAccountId: "acct_1", amountCents: 50000 });

  const evt = fake.constructWebhookEvent(JSON.stringify({ type: "checkout.session.completed", data: { object: { id: "cs_1" } } }), "sig");
  expect(evt.type).toBe("checkout.session.completed");
});
```

- [ ] **Step 3: Run, expect fail** — `pnpm --filter @savvy/integrations exec vitest run stripe` → FAIL.

- [ ] **Step 4: Implement** — `packages/integrations/src/stripe.ts`:
```ts
import Stripe from "stripe";

export type StripeEventLite = { type: string; account?: string; data: { object: Record<string, unknown> } };

export interface StripeGateway {
  oauthToken(code: string): Promise<{ stripeUserId: string }>;
  createCheckoutSession(o: {
    connectedAccountId: string; amountCents: number; currency?: string;
    invoiceId: string; tenantId: string; description: string;
    successUrl: string; cancelUrl: string; customerEmail?: string;
  }): Promise<{ id: string; url: string; paymentIntentId: string | null }>;
  constructWebhookEvent(rawBody: string, signature: string): StripeEventLite;
}

function client(): Stripe {
  return new Stripe(process.env.STRIPE_SECRET_KEY ?? "", { apiVersion: "2024-06-20" });
}

export const stripeGateway: StripeGateway = {
  async oauthToken(code) {
    const res = await client().oauth.token({ grant_type: "authorization_code", code });
    return { stripeUserId: res.stripe_user_id as string };
  },
  async createCheckoutSession(o) {
    const session = await client().checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card", "us_bank_account"],
      line_items: [{
        quantity: 1,
        price_data: { currency: o.currency ?? "usd", unit_amount: o.amountCents, product_data: { name: o.description } },
      }],
      metadata: { invoiceId: o.invoiceId, tenantId: o.tenantId },
      payment_intent_data: { metadata: { invoiceId: o.invoiceId, tenantId: o.tenantId } },
      success_url: o.successUrl, cancel_url: o.cancelUrl,
      ...(o.customerEmail ? { customer_email: o.customerEmail } : {}),
    }, { stripeAccount: o.connectedAccountId });
    return { id: session.id, url: session.url ?? "", paymentIntentId: (session.payment_intent as string | null) ?? null };
  },
  constructWebhookEvent(rawBody, signature) {
    const evt = client().webhooks.constructEvent(rawBody, signature, process.env.STRIPE_WEBHOOK_SECRET ?? "");
    return { type: evt.type, account: (evt as { account?: string }).account, data: { object: evt.data.object as Record<string, unknown> } };
  },
};

export function makeFakeStripe(): StripeGateway & { calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  let n = 0;
  return {
    calls,
    async oauthToken(code) { calls.push({ op: "oauth", code }); return { stripeUserId: `acct_fake_${++n}` }; },
    async createCheckoutSession(o) {
      calls.push({ op: "checkout", ...o });
      const id = `cs_fake_${++n}`;
      return { id, url: `https://checkout.stripe.test/${id}`, paymentIntentId: `pi_fake_${n}` };
    },
    constructWebhookEvent(rawBody) {
      calls.push({ op: "webhook" });
      return JSON.parse(rawBody) as StripeEventLite;
    },
  };
}
```

- [ ] **Step 5: Export + env** — add to `packages/integrations/src/index.ts`:
```ts
export { stripeGateway, makeFakeStripe, type StripeGateway, type StripeEventLite } from "./stripe";
```
Append to `.env.example`:
```
# Stripe (Connect Standard) — Phase 5A
STRIPE_SECRET_KEY=
STRIPE_CONNECT_CLIENT_ID=
STRIPE_WEBHOOK_SECRET=
```

- [ ] **Step 6: Run + typecheck** — `pnpm --filter @savvy/integrations exec vitest run stripe` → PASS; `pnpm --filter @savvy/integrations typecheck`.
> If the installed `stripe` types reject `apiVersion: "2024-06-20"`, use the version string the types expect (the error message names it) — keep everything else identical.

- [ ] **Step 7: Commit**
```bash
git add packages/integrations/src/stripe.ts packages/integrations/src/index.ts packages/integrations/package.json pnpm-lock.yaml .env.example
git commit -m "feat(integrations): Stripe gateway (Connect oauth + Checkout + webhook) + fake"
```

---

## Task 7: Finance events on the Inngest client

**Files:** Modify `packages/agents/src/client.ts`

- [ ] **Step 1: Add events** — inside the `Events` type:
```ts
"invoice/sent": { data: { invoiceId: string; tenantId: string } };
"invoice/paid": { data: { invoiceId: string; tenantId: string } };
```

- [ ] **Step 2: Typecheck** — `pnpm --filter @savvy/agents typecheck` → PASS.

- [ ] **Step 3: Commit**
```bash
git add packages/agents/src/client.ts
git commit -m "feat(agents): invoice/sent + invoice/paid events (consumed by 5B)"
```

---

## Task 8: Stripe Connect onboarding (web)

**Files:** Create `apps/web/src/lib/stripe-connection.ts`, `apps/web/src/app/api/stripe/connect/start/route.ts`, `apps/web/src/app/api/stripe/connect/callback/route.ts`

- [ ] **Step 1: Connection helper** — `apps/web/src/lib/stripe-connection.ts`:
```ts
import "server-only";
import { adminDb, tenant, eq } from "@savvy/db";

export async function getStripeConnection(tenantId: string): Promise<{ connected: boolean; accountId?: string }> {
  const [t] = await adminDb.select().from(tenant).where(eq(tenant.id, tenantId));
  return t?.stripeAccountId ? { connected: true, accountId: t.stripeAccountId } : { connected: false };
}
```

- [ ] **Step 2: Start route** — `apps/web/src/app/api/stripe/connect/start/route.ts`:
```ts
import { NextResponse } from "next/server";
import { signPayloadToken } from "@savvy/core";
import { getTenantId } from "@/lib/tenant";

export const runtime = "nodejs";

export async function GET(): Promise<NextResponse> {
  let tenantId: string;
  try { tenantId = await getTenantId(); } catch { return NextResponse.json({ error: "unauthorized" }, { status: 401 }); }
  const clientId = process.env.STRIPE_CONNECT_CLIENT_ID;
  if (!clientId) return NextResponse.json({ error: "stripe_connect_not_configured" }, { status: 500 });
  const secret = process.env.UNSUBSCRIBE_SECRET ?? "dev-unsubscribe-secret";
  const state = signPayloadToken({ tenantId }, secret);
  const base = process.env.APP_BASE_URL ?? "http://localhost:3000";
  const url = new URL("https://connect.stripe.com/oauth/authorize");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("scope", "read_write");
  url.searchParams.set("state", state);
  url.searchParams.set("redirect_uri", `${base}/api/stripe/connect/callback`);
  return NextResponse.redirect(url.toString());
}
```

- [ ] **Step 3: Callback route** — `apps/web/src/app/api/stripe/connect/callback/route.ts`:
```ts
import { NextResponse } from "next/server";
import { verifyPayloadToken } from "@savvy/core";
import { stripeGateway } from "@savvy/integrations";
import { adminDb, tenant, eq } from "@savvy/db";
import { getTenantId } from "@/lib/tenant";

export const runtime = "nodejs";

export async function GET(req: Request): Promise<NextResponse> {
  const base = process.env.APP_BASE_URL ?? "http://localhost:3000";
  const { searchParams } = new URL(req.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const secret = process.env.UNSUBSCRIBE_SECRET ?? "dev-unsubscribe-secret";
  const payload = state ? verifyPayloadToken<{ tenantId: string }>(state, secret) : null;
  if (!code || !payload) return NextResponse.redirect(`${base}/settings/payments?error=invalid`);

  // Double-check the state's tenant matches the logged-in tenant.
  let tenantId: string;
  try { tenantId = await getTenantId(); } catch { return NextResponse.redirect(`${base}/settings/payments?error=unauthorized`); }
  if (tenantId !== payload.tenantId) return NextResponse.redirect(`${base}/settings/payments?error=mismatch`);

  try {
    const { stripeUserId } = await stripeGateway.oauthToken(code);
    await adminDb.update(tenant).set({ stripeAccountId: stripeUserId }).where(eq(tenant.id, tenantId));
  } catch {
    return NextResponse.redirect(`${base}/settings/payments?error=exchange_failed`);
  }
  return NextResponse.redirect(`${base}/settings/payments?connected=1`);
}
```

- [ ] **Step 4: Typecheck** — `pnpm --filter @savvy/web typecheck` → PASS.

- [ ] **Step 5: Commit**
```bash
git add apps/web/src/lib/stripe-connection.ts apps/web/src/app/api/stripe/connect
git commit -m "feat(web): Stripe Connect onboarding (oauth start + callback, HMAC state)"
```

---

## Task 9: Finance queries + actions (web)

**Files:** Create `apps/web/src/lib/finance-queries.ts`, `apps/web/src/lib/finance-actions.ts`

- [ ] **Step 1: Queries** — `apps/web/src/lib/finance-queries.ts`:
```ts
import "server-only";
import { withTenant, invoice, customer, payment, eq, and, desc } from "@savvy/db";
import { getTenantId } from "./tenant";

export async function listInvoices(filter?: { status?: string }) {
  const tenantId = await getTenantId();
  return withTenant(tenantId, (tx) => tx.select({
    id: invoice.id, number: invoice.number, status: invoice.status,
    amountDue: invoice.amountDue, amountPaid: invoice.amountPaid, dueAt: invoice.dueAt,
    customerName: customer.name,
  }).from(invoice)
    .leftJoin(customer, eq(invoice.customerId, customer.id))
    .where(and(eq(invoice.tenantId, tenantId), ...(filter?.status ? [eq(invoice.status, filter.status as never)] : [])))
    .orderBy(desc(invoice.createdAt)));
}

export async function getInvoice(id: string) {
  const tenantId = await getTenantId();
  return withTenant(tenantId, async (tx) => {
    const [inv] = await tx.select().from(invoice).where(eq(invoice.id, id));
    const pays = await tx.select().from(payment).where(eq(payment.invoiceId, id));
    return inv ? { invoice: inv, payments: pays } : null;
  });
}
```

- [ ] **Step 2: Actions** — `apps/web/src/lib/finance-actions.ts`:
```ts
"use server";
import { revalidatePath } from "next/cache";
import {
  withTenant, invoice, tenant, eq,
  createInvoice, createInvoiceFromEstimate, sendInvoice, voidInvoice, StripeNotConnectedError,
} from "@savvy/db";
import { stripeGateway } from "@savvy/integrations";
import type { LineItem } from "@savvy/core";
import { inngest } from "@savvy/agents";
import { getTenantId } from "./tenant";

export async function createInvoiceAction(jobId: string, lineItems: LineItem[]) {
  const tenantId = await getTenantId();
  const inv = await createInvoice({ tenantId, jobId, lineItems });
  revalidatePath("/invoices");
  return { ok: true as const, id: inv.id };
}

export async function createFromEstimateAction(estimateId: string) {
  const tenantId = await getTenantId();
  const inv = await createInvoiceFromEstimate({ tenantId, estimateId });
  revalidatePath("/invoices");
  return { ok: true as const, id: inv.id };
}

export async function sendInvoiceAction(invoiceId: string) {
  const tenantId = await getTenantId();
  try {
    await sendInvoice({ tenantId, invoiceId });
  } catch (e) {
    if (e instanceof StripeNotConnectedError) return { error: "stripe_not_connected" as const };
    throw e;
  }
  try { await inngest.send({ name: "invoice/sent", data: { invoiceId, tenantId } }); } catch (e) { console.error(e); }
  revalidatePath("/invoices");
  return { ok: true as const };
}

export async function voidInvoiceAction(invoiceId: string) {
  const tenantId = await getTenantId();
  await voidInvoice({ tenantId, invoiceId });
  revalidatePath("/invoices");
  return { ok: true as const };
}

export async function createCheckoutForInvoice(invoiceId: string) {
  const tenantId = await getTenantId();
  const base = process.env.APP_BASE_URL ?? "http://localhost:3000";
  const ctx = await withTenant(tenantId, async (tx) => {
    const [inv] = await tx.select().from(invoice).where(eq(invoice.id, invoiceId));
    const [t] = await tx.select().from(tenant).where(eq(tenant.id, tenantId));
    return { inv, accountId: t?.stripeAccountId ?? null };
  });
  if (!ctx.inv) return { error: "not_found" as const };
  if (!ctx.accountId) return { error: "stripe_not_connected" as const };

  const session = await stripeGateway.createCheckoutSession({
    connectedAccountId: ctx.accountId, amountCents: ctx.inv.amountDue ?? 0,
    invoiceId, tenantId, description: ctx.inv.number ?? "Invoice",
    successUrl: `${base}/invoices/${invoiceId}?paid=1`, cancelUrl: `${base}/invoices/${invoiceId}`,
  });
  await withTenant(tenantId, (tx) => tx.update(invoice)
    .set({ stripeCheckoutSessionId: session.id, ...(session.paymentIntentId ? { stripePaymentIntentId: session.paymentIntentId } : {}) })
    .where(eq(invoice.id, invoiceId)));
  return { ok: true as const, url: session.url };
}
```

- [ ] **Step 3: Typecheck** — `pnpm --filter @savvy/web typecheck` → PASS. (If the `eq(invoice.status, filter.status as never)` cast is unhappy, narrow `filter.status` to the `InvoiceStatus` type imported from `@savvy/core`.)

- [ ] **Step 4: Commit**
```bash
git add apps/web/src/lib/finance-queries.ts apps/web/src/lib/finance-actions.ts
git commit -m "feat(web): finance queries + actions (create/from-estimate/send/void/checkout)"
```

---

## Task 10: Stripe webhook reconciliation route

**Files:** Create `apps/web/src/app/api/stripe/webhook/route.ts`; Modify `apps/web/src/middleware.ts`

- [ ] **Step 1: Make the webhook public** — in `apps/web/src/middleware.ts`, add `/^\/api\/stripe\/webhook$/` to the `PUBLIC` array (the connect start/callback stay Clerk-protected; only the webhook is public).

- [ ] **Step 2: Webhook route** — `apps/web/src/app/api/stripe/webhook/route.ts`:
```ts
import { NextResponse } from "next/server";
import { stripeGateway } from "@savvy/integrations";
import { recordStripePayment } from "@savvy/db";
import { inngest } from "@savvy/agents";

export const runtime = "nodejs";

export async function POST(req: Request): Promise<NextResponse> {
  const raw = await req.text(); // raw body required for signature verification
  const sig = req.headers.get("stripe-signature") ?? "";
  let evt;
  try {
    evt = stripeGateway.constructWebhookEvent(raw, sig);
  } catch {
    return new NextResponse("bad signature", { status: 400 });
  }

  const isSuccess = evt.type === "checkout.session.completed" || evt.type === "checkout.session.async_payment_succeeded";
  if (!isSuccess) return NextResponse.json({ received: true });

  const session = evt.data.object as {
    id?: string; payment_intent?: string; amount_total?: number;
    payment_status?: string;
    metadata?: { invoiceId?: string; tenantId?: string };
  };

  // Method + settlement gating:
  // - async_payment_succeeded = an ACH/delayed payment that has now SETTLED -> record as ach.
  // - completed = the session finished; record ONLY if payment_status is "paid" (card/instant).
  //   For ACH, `completed` fires with payment_status "processing"/"unpaid" BEFORE funds settle —
  //   we must wait for the later async_payment_succeeded, so we skip here.
  let method: "card" | "ach";
  if (evt.type === "checkout.session.async_payment_succeeded") {
    method = "ach";
  } else {
    if (session.payment_status !== "paid") return NextResponse.json({ received: true });
    method = "card";
  }

  const invoiceId = session.metadata?.invoiceId;
  const tenantId = session.metadata?.tenantId;
  const stripePaymentId = session.payment_intent ?? session.id;
  if (!invoiceId || !tenantId || !stripePaymentId) return NextResponse.json({ received: true });
  try {
    const r = await recordStripePayment({
      tenantId, invoiceId, stripePaymentId, method, amountCents: session.amount_total ?? 0,
    });
    if (r.nowPaid) {
      try { await inngest.send({ name: "invoice/paid", data: { invoiceId, tenantId } }); } catch (e) { console.error(e); }
    }
  } catch (e) {
    // 23505 race -> already recorded; any other error we log but still 200 (avoid infinite Stripe retries on a poison event).
    console.error("reconcile failed", e);
  }
  return NextResponse.json({ received: true });
}
```

- [ ] **Step 3: Typecheck + lint** — `pnpm --filter @savvy/web typecheck && pnpm --filter @savvy/web lint` → PASS.

- [ ] **Step 4: Commit**
```bash
git add apps/web/src/app/api/stripe/webhook apps/web/src/middleware.ts
git commit -m "feat(web): Stripe webhook — verify, reconcile payment, emit invoice/paid"
```

---

## Task 11: Invoices UI (`/invoices` + detail + create)

**Files:** Create `apps/web/src/app/(app)/invoices/page.tsx`, `apps/web/src/app/(app)/invoices/InvoicesClient.tsx`, `apps/web/src/app/(app)/invoices/[id]/page.tsx`, `apps/web/src/app/(app)/invoices/[id]/InvoiceDetail.tsx`, `apps/web/src/app/(app)/invoices/new/*` (or a create form on the list); Modify nav.

> Study `apps/web/src/app/(app)/schedule/*` and `comms/*` first for the exact server-page + client-component + action-calling + toast + nav conventions. Money displays as `(cents/100).toLocaleString(undefined,{style:"currency",currency:"USD"})`.

- [ ] **Step 1: List page** — `invoices/page.tsx` (server, `force-dynamic`) calls `listInvoices()`, serializes Dates to ISO, renders `<InvoicesClient invoices={...} />`. Client: a table of invoices (number or "Draft", customer, amount due, status badge via inline `<span>`, due date), each row links to `/invoices/[id]`. A "New invoice" entry point.

- [ ] **Step 2: Detail page** — `invoices/[id]/page.tsx` (server, `force-dynamic`) calls `getInvoice(id)` (404 UI if null), passes serialized data to `InvoiceDetail.tsx` (client). Detail shows line items, totals (cents→$), status, recorded payments. Action buttons (in `useTransition`, toast feedback):
  - **Send** → `sendInvoiceAction(id)`; if `{error:"stripe_not_connected"}` show "Connect Stripe in Settings → Payments first".
  - **Void** → `voidInvoiceAction(id)`.
  - **Get pay link** → `createCheckoutForInvoice(id)`; on `{ok,url}` `window.open(url)` (or copy); on `{error}` toast.
  - Only show Send/pay-link when status allows (draft can send; sent can collect; paid shows payments).

- [ ] **Step 3: Create form** — a `"use client"` line-item editor (rows of description/qty/unit-dollars; convert dollars→cents on submit) that calls `createInvoiceAction(jobId, lineItems)`. Reachable from a job detail page or `/invoices/new?jobId=…`. Keep it pragmatic; jobId can come from a query param or a job picker. Also a **"Create invoice from estimate"** affordance calling `createFromEstimateAction(estimateId)` (can live on an estimate row/detail if one exists, else on the invoices page accepting an estimate id — simplest acceptable form).

- [ ] **Step 4: Nav** — add an "Invoices" link to the app nav (`apps/web/src/app/(app)/layout.tsx` NAV array, like `/schedule`).

- [ ] **Step 5: Typecheck + lint** — both pass. Do NOT run `pnpm build` (pre-existing Clerk prerender issue).

- [ ] **Step 6: Commit**
```bash
git add "apps/web/src/app/(app)/invoices" apps/web/src/app/\(app\)/layout.tsx
git commit -m "feat(web): invoices list + detail + create UI"
```

---

## Task 12: Settings → Payments (Connect Stripe)

**Files:** Create `apps/web/src/app/(app)/settings/payments/page.tsx` + client

- [ ] **Step 1: Page** — `settings/payments/page.tsx` (server, `force-dynamic`): resolve `getTenantId()`, call `getStripeConnection(tenantId)`, render status + a client button. Read `searchParams` for `?connected=1` / `?error=…` to show a toast/banner.

- [ ] **Step 2: Client** — a "Connect Stripe" button that does `window.location.href = "/api/stripe/connect/start"` when not connected; shows "Connected ✓ (acct_…)" when connected. Mirror the Phase 4 Connect-Google button styling in `settings/scheduling`.

- [ ] **Step 3: Typecheck + lint** — both pass.

- [ ] **Step 4: Commit**
```bash
git add "apps/web/src/app/(app)/settings/payments"
git commit -m "feat(web): settings — Connect Stripe (payments)"
```

---

## Task 13: e2e money path + final gate

**Files:** Create `apps/web/tests/e2e/finance.spec.ts`

> Harness identical to `scheduling.spec.ts` (Postgres + ai-stub + Inngest dev + Next, `TEST_MODE=1`). Stripe is mocked: the test sets `tenant.stripeAccountId` directly and drives reconciliation by calling `recordStripePayment` (the same code the webhook calls) — no real Stripe in CI. Study `scheduling.spec.ts` for setup (adminDb fixtures, TEST_TENANT_ID).

- [ ] **Step 1: Write the e2e** covering:
  1. **Setup** (adminDb): tenant (set `stripeAccountId = "acct_test"` so send is allowed) + a customer + property + job.
  2. Create an invoice via `createInvoice` (db helper, direct) with line items totalling e.g. 250000 cents; assert it shows on `/invoices` as a draft.
  3. Send it via `sendInvoice` (db helper); navigate to `/invoices/[id]`, assert a `INV-…` number + "sent" status render.
  4. **Reconcile**: call `recordStripePayment({ tenantId, invoiceId, stripePaymentId: "pi_e2e", method: "card", amountCents: 250000 })` (simulating the webhook). Reload `/invoices/[id]`; assert status shows **paid** and the payment is listed.
  5. **Idempotency**: call `recordStripePayment` again with the same `pi_e2e`; assert no second payment row (query via adminDb) and still one payment.

- [ ] **Step 2: Run e2e** (recipe from `scheduling.spec.ts` / handoff):
```bash
export DATABASE_URL=postgres://savvy_app:savvy_app@localhost:5432/savvy DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/savvy AI_STUB_PORT=4010 INNGEST_DEV=1
node apps/web/tests/e2e/ai-stub.mjs &
npx --yes inngest-cli@latest dev -u http://localhost:3000/api/inngest --no-discovery &
sleep 3
pnpm --filter @savvy/web exec tsx tests/e2e/create-tenant.ts
export TEST_TENANT_ID="$(node -e "console.log(require('/tmp/savvy-e2e-tenant.json').id)")"
pnpm --filter @savvy/web exec playwright test finance
pkill -f ai-stub.mjs; pkill -f inngest-cli; pkill -f "next dev" || true
```
Expect PASS. (If create-tenant.ts doesn't set `stripeAccountId`, set it in the test's beforeAll via adminDb.)

- [ ] **Step 3: Final full gate**
```bash
export DATABASE_URL=postgres://savvy_app:savvy_app@localhost:5432/savvy DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/savvy
pnpm typecheck && pnpm lint && pnpm test
```
All green.

- [ ] **Step 4: Commit**
```bash
git add apps/web/tests/e2e/finance.spec.ts
git commit -m "test(web): e2e — create -> send -> checkout(mock) -> reconcile -> paid (idempotent)"
```

---

## Final verification
- [ ] `pnpm typecheck && pnpm lint && pnpm test` green.
- [ ] e2e green.
- [ ] `.env.example` documents Stripe vars.
- [ ] Manual smoke: `pnpm db:reset && pnpm dev`; Settings → Payments shows "Connect Stripe"; create an invoice, send it (number assigned), "Get pay link" returns a URL (real Stripe test keys required for a true Checkout — otherwise the fake is used in tests).
- [ ] Done-gates: connect → invoice (direct + from estimate) → send (sequential number) → Checkout on connected account → webhook reconciles idempotently → `paid` + `payment` row; `invoice/paid` emitted; all tenant-scoped (RLS test).

## Notes for the executor
- **Money is cents.** Never store/compute dollars. UI converts at the edge only.
- **`stripe` SDK version**: `pnpm add stripe` installs the latest; if its types pin a specific `apiVersion` literal, match it (the type error names the expected string).
- **Webhook is the only public Stripe route**; connect start/callback are authed. Don't add the connect routes to middleware PUBLIC.
- **Reading `tenant` inside `withTenant`** works (SELECT grant); **writing `tenant`** must use `adminDb`.
- **Carried follow-ups (5B / deferred):** dunning, commissions, QBO push (hang off `invoice/sent`/`invoice/paid`); Stripe webhook replay-window hardening; refunds/disputes; Twilio webhook signature validation (still open from Phase 3).
