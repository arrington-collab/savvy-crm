# Phase 5B — Finance Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automate everything downstream of an invoice — dunning (chase overdue), commission calc on payment, and one-way QuickBooks push — all triggered off the existing `invoice/sent` / `invoice/paid` events.

**Architecture:** Three independent subsystems shipping in one PR, built in waves. Dunning clones the comms-agent `dripRun` Inngest pattern; commissions are pure `@savvy/core` math invoked by a thin `invoice/paid` workflow; QBO reuses the `nangoProxy` transport behind a `QboGateway` (real + fake). One new table (`commission`), one new event (`invoice/void`), a settings extension, and a handful of nullable columns.

**Tech Stack:** TypeScript, pnpm/Turborepo monorepo, Drizzle (Postgres + RLS), Inngest (durable workflows), Vitest, Playwright, Next.js App Router, Nango (QBO OAuth/proxy), Twilio (SMS), Resend (email).

**Spec:** `docs/superpowers/specs/2026-06-10-phase5b-finance-automation-design.md`

---

## Conventions (read once, applies to every task)

- **Run a single package's tests** from repo root: `pnpm test <file-pattern>`. Only `@savvy/core`, `@savvy/db`, `@savvy/agents` have a `test` script.
- **DB env for db/agents tests + migrations:**
  ```bash
  export DATABASE_URL=postgres://savvy_app:savvy_app@localhost:5432/savvy
  export DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/savvy
  ```
  Start DB first: `docker compose up -d`.
- **Imports:** app/agent code imports tables + drizzle operators (`eq`, `and`, `sql`…) from `@savvy/db`, and `z` + domain helpers from `@savvy/core` — never from `drizzle-orm`/`zod` directly. **No `.js` extensions** on internal relative imports in SOURCE; `@savvy/db` TEST files DO use `.js`.
- **Money is integer cents; rates are integer basis points** (1000 = 10%). No floats.
- **Static gate before every commit:** `pnpm typecheck && pnpm lint && pnpm test` (run the affected package's tests at minimum).
- **All new tenant tables/columns get `tenantIsolation()` / `tenant_id`** and are covered by the RLS isolation test (Task 18).

## File Structure

| File | Responsibility | Wave |
|------|----------------|------|
| `packages/core/src/enums.ts` (mod) | `COMMISSION_MODEL`, `COMMISSION_STATUS` tuples + types | 0 |
| `packages/core/src/finance.ts` (mod) | extend `financeSchema`/`FinanceConfig`/`parseFinanceConfig` with dunning + commission | 0 |
| `packages/core/src/commission.ts` (new) | pure `computeCommission` (flat/profit/tiered) | B |
| `packages/core/src/quiet-hours.ts` (new) | pure `isWithinQuietHours` + `nextAllowedSendTime` | A |
| `packages/core/src/dunning.ts` (new) | pure dunning step schedule + email copy builder | A |
| `packages/db/src/schema/enums.ts` (mod) | `commissionModelEnum`, `commissionStatusEnum` | 0 |
| `packages/db/src/schema/finance.ts` (mod) | `commission` table; `payment.qboId`, `customer.qboId` (crm.ts), `job.costCents` (jobs.ts), `tenant.qboConnectionId` (tenancy.ts) | 0 |
| `packages/db/src/lifecycle/commission.ts` (new) | `recordCommission` (idempotent insert + prior-period sum) | B |
| `packages/db/src/lifecycle/invoices.ts` (unchanged) | — | — |
| `packages/integrations/src/nango.ts` (new) | shared `nangoProxy` transport (extracted from gcal) | C |
| `packages/integrations/src/gcal.ts` (mod) | import `nangoProxy` from `./nango` | C |
| `packages/integrations/src/qbo.ts` (new) | `QboGateway` interface + real (`nangoQbo`) + `makeFakeQbo` | C |
| `packages/agents/src/client.ts` (mod) | add `invoice/void` event type | 0 |
| `packages/agents/src/functions/dunning.ts` (new) | dunning Inngest workflow | A |
| `packages/agents/src/functions/commission.ts` (new) | commission Inngest workflow | B |
| `packages/agents/src/functions/qbo-sync.ts` (new) | QBO invoice + payment sync Inngest workflows | C |
| `packages/agents/src/index.ts` (mod) | register new functions | A/B/C |
| `apps/web/src/lib/finance-actions.ts` (mod) | emit `invoice/void` in `voidInvoiceAction` | 0 |
| `apps/web/src/lib/commission-queries.ts` (new) | `listCommissions` | B |
| `apps/web/src/app/(app)/commissions/*` (new) | read-only commissions list | B |
| `apps/web/src/app/(app)/settings/quickbooks/*` (new) | QBO connect UI | C |
| `apps/web/src/app/api/nango/qbo/{start,callback}/route.ts` (new) | QBO connect start/callback | C |
| `apps/web/tests/e2e/finance-automation.spec.ts` (new) | dunning + commissions e2e | gate |
| `.env.example` (mod) | `NANGO_QBO_INTEGRATION_ID` | gate |

---

# Wave 0 — Foundation (schema, settings, events)

## Task 1: Commission enums in core

**Files:**
- Modify: `packages/core/src/enums.ts`
- Test: `packages/core/src/enums.test.ts`

- [ ] **Step 1: Write the failing test** — append to `packages/core/src/enums.test.ts`:

```ts
import { COMMISSION_MODEL, COMMISSION_STATUS } from "./enums";

test("commission enums", () => {
  expect(COMMISSION_MODEL).toEqual(["flat", "profit", "tiered"]);
  expect(COMMISSION_STATUS).toEqual(["pending", "approved", "paid"]);
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `pnpm test enums`
Expected: FAIL — `COMMISSION_MODEL` is not exported.

- [ ] **Step 3: Implement** — append to `packages/core/src/enums.ts`:

```ts
export const COMMISSION_MODEL = ["flat", "profit", "tiered"] as const;
export const COMMISSION_STATUS = ["pending", "approved", "paid"] as const;
export type CommissionModel = (typeof COMMISSION_MODEL)[number];
export type CommissionStatus = (typeof COMMISSION_STATUS)[number];
```

- [ ] **Step 4: Run test, verify it passes**

Run: `pnpm test enums` → PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/enums.ts packages/core/src/enums.test.ts
git commit -m "feat(core): commission model + status enums"
```

## Task 2: Extend finance settings schema (dunning + commission)

**Files:**
- Modify: `packages/core/src/finance.ts`
- Test: `packages/core/src/finance.test.ts`

- [ ] **Step 1: Write the failing test** — append to `packages/core/src/finance.test.ts`:

```ts
test("finance config defaults include dunning + commission", () => {
  const cfg = parseFinanceConfig(undefined);
  expect(cfg.timezone).toBe("America/Phoenix");
  expect(cfg.dunning).toEqual({
    enabled: true, smsEscalationDay: 30, quietHours: { startHour: 21, endHour: 8 },
  });
  expect(cfg.commission).toEqual({
    model: "flat", rate: 1000, tiers: [], period: "monthly", perRepRate: {},
  });
});

test("finance config merges partial overrides", () => {
  const cfg = parseFinanceConfig({ commission: { model: "tiered", rate: 800 } });
  expect(cfg.commission.model).toBe("tiered");
  expect(cfg.commission.rate).toBe(800);
  expect(cfg.commission.period).toBe("monthly"); // default still applied
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `pnpm test finance` → FAIL (`cfg.dunning` undefined).

- [ ] **Step 3: Implement** — in `packages/core/src/finance.ts`, replace the `financeSchema`, `FinanceConfig`, and `parseFinanceConfig` block with:

```ts
import { COMMISSION_MODEL } from "./enums";

const quietHoursSchema = z.object({
  startHour: z.number().int().min(0).max(23).default(21),
  endHour: z.number().int().min(0).max(23).default(8),
});

const dunningSchema = z.object({
  enabled: z.boolean().default(true),
  smsEscalationDay: z.number().int().positive().default(30),
  quietHours: quietHoursSchema.default({}),
});

const commissionSettingsSchema = z.object({
  model: z.enum(COMMISSION_MODEL).default("flat"),
  rate: z.number().int().min(0).default(1000), // basis points
  tiers: z.array(z.object({
    thresholdCents: z.number().int().min(0),
    rate: z.number().int().min(0),
  })).default([]),
  period: z.enum(["monthly", "quarterly"]).default("monthly"),
  perRepRate: z.record(z.string(), z.number().int().min(0)).default({}),
});

const financeSchema = z.object({
  netDays: z.number().int().positive().default(14),
  invoiceNumberPrefix: z.string().default("INV-"),
  timezone: z.string().default("America/Phoenix"),
  dunning: dunningSchema.default({}),
  commission: commissionSettingsSchema.default({}),
});

export type FinanceConfig = z.infer<typeof financeSchema>;
export type CommissionConfig = z.infer<typeof commissionSettingsSchema>;

export function parseFinanceConfig(raw: unknown): FinanceConfig {
  return financeSchema.parse(raw ?? {});
}
```

> Note: `.default({})` on the nested objects makes zod fill every leaf default, so existing tenants holding only `{ netDays, invoiceNumberPrefix }` parse cleanly. The earlier 5A test (`parseFinanceConfig({ netDays: 30 })` toEqual) now returns extra keys — update that assertion to `expect(parseFinanceConfig({ netDays: 30 }).netDays).toBe(30)` and `expect(parseFinanceConfig(undefined).invoiceNumberPrefix).toBe("INV-")`.

- [ ] **Step 4: Update the two 5A assertions** in `finance.test.ts` (lines ~19–20) to the field-wise checks above so they don't break on the new keys.

- [ ] **Step 5: Run test, verify it passes**

Run: `pnpm test finance` → PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/finance.ts packages/core/src/finance.test.ts
git commit -m "feat(core): extend finance settings with dunning + commission config"
```

## Task 3: DB pgEnums for commission

**Files:**
- Modify: `packages/db/src/schema/enums.ts`

- [ ] **Step 1: Implement** — add the import + enums to `packages/db/src/schema/enums.ts`:

```ts
// add COMMISSION_MODEL, COMMISSION_STATUS to the existing "@savvy/core" import list
import { COMMISSION_MODEL, COMMISSION_STATUS } from "@savvy/core";
// ...at the bottom:
export const commissionModelEnum = pgEnum("commission_model", COMMISSION_MODEL);
export const commissionStatusEnum = pgEnum("commission_status", COMMISSION_STATUS);
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck` → PASS (no test for bare enum decls).

- [ ] **Step 3: Commit**

```bash
git add packages/db/src/schema/enums.ts
git commit -m "feat(db): commission pgEnums"
```

## Task 4: Schema columns + commission table + migration 0005

**Files:**
- Modify: `packages/db/src/schema/finance.ts`, `packages/db/src/schema/crm.ts`, `packages/db/src/schema/jobs.ts`, `packages/db/src/schema/tenancy.ts`
- Generate: `packages/db/drizzle/0005_*.sql`
- Test: `packages/db/tests/commission.test.ts`

- [ ] **Step 1: Add the columns.**

In `packages/db/src/schema/jobs.ts` add to the `job` table columns: `costCents: integer("cost_cents"),` (import `integer` if not already).

In `packages/db/src/schema/crm.ts` add to `customer`: `qboId: text("qbo_id"),`.

In `packages/db/src/schema/tenancy.ts` add to `tenant`: `qboConnectionId: text("qbo_connection_id"),`.

In `packages/db/src/schema/finance.ts`:
- add `qboId: text("qbo_id"),` to the `payment` table columns.
- add the import `import { commissionModelEnum, commissionStatusEnum } from "./enums";` (extend existing) and `import { user } from "./tenancy";` (or wherever `user` is defined — check the import already used by jobs.ts).
- append the `commission` table:

```ts
export const commission = pgTable("commission", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  invoiceId: uuid("invoice_id").notNull().references(() => invoice.id),
  userId: uuid("user_id").notNull().references(() => user.id),
  model: commissionModelEnum("model").notNull(),
  basisCents: integer("basis_cents").notNull(),
  rate: integer("rate").notNull(),
  amountCents: integer("amount_cents").notNull(),
  periodKey: text("period_key").notNull(),
  status: commissionStatusEnum("status").notNull().default("pending"),
  createdAt: createdAt(),
}, (t) => [
  index("commission_tenant_user_idx").on(t.tenantId, t.userId),
  uniqueIndex("commission_tenant_invoice_uniq").on(t.tenantId, t.invoiceId),
  tenantIsolation(),
]);
```

> Confirm where `user` is imported from (jobs.ts imports it — mirror that path). `idCol`, `createdAt`, `tenantIsolation`, `index`, `uniqueIndex`, `integer`, `text`, `uuid` are already imported in finance.ts.

- [ ] **Step 2: Generate the migration**

Run: `pnpm db:generate`
Expected: creates `packages/db/drizzle/0005_<name>.sql` + snapshot + journal entry, **non-interactively** (all changes are additive — new table + nullable columns — so drizzle-kit won't prompt for renames).

- [ ] **Step 3: Apply it**

Run: `pnpm db:migrate` → applies 0005 cleanly.

- [ ] **Step 4: Write the failing test** — `packages/db/tests/commission.test.ts` (mirror the structure of `packages/db/tests/invoices.test.ts`, which uses `.js` import extensions + the test tenant helper):

```ts
import { describe, it, expect } from "vitest";
import { withTenant } from "../src/tenant.js";
import { commission } from "../src/schema/finance.js";
import { makeTestTenant } from "./helpers.js"; // use whatever invoices.test.ts uses to make a tenant/job/invoice/user

describe("commission table", () => {
  it("inserts and reads back a commission row, tenant-scoped", async () => {
    const { tenantId, invoiceId, userId } = await makeTestTenant(); // adapt to the existing helper's return
    const row = await withTenant(tenantId, async (tx) => {
      const [r] = await tx.insert(commission).values({
        tenantId, invoiceId, userId, model: "flat",
        basisCents: 100000, rate: 1000, amountCents: 10000, periodKey: "2026-06",
      }).returning();
      return r;
    });
    expect(row.amountCents).toBe(10000);
    expect(row.status).toBe("pending");
  });
});
```

> Inspect `packages/db/tests/invoices.test.ts` first and reuse its exact tenant/job/invoice/user setup helper rather than inventing `makeTestTenant`. The point of this test is to prove the migration applied and RLS doesn't block a same-tenant write.

- [ ] **Step 5: Run test**

Run: `pnpm test commission` → PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/schema packages/db/drizzle packages/db/tests/commission.test.ts
git commit -m "feat(db): commission table + qbo/cost columns + migration 0005"
```

## Task 5: `invoice/void` event + emit on void

**Files:**
- Modify: `packages/agents/src/client.ts`
- Modify: `apps/web/src/lib/finance-actions.ts`

- [ ] **Step 1: Add the event type** — in `packages/agents/src/client.ts`, add to the `Events` type:

```ts
  "invoice/void": { data: { invoiceId: string; tenantId: string } };
```

- [ ] **Step 2: Emit it** — in `apps/web/src/lib/finance-actions.ts` `voidInvoiceAction`, after `await voidInvoice(...)` and before `revalidatePath`:

```ts
  try { await inngest.send({ name: "invoice/void", data: { invoiceId, tenantId } }); } catch (e) { console.error(e); }
```

(`inngest` is already imported in this file.)

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck` → PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/agents/src/client.ts apps/web/src/lib/finance-actions.ts
git commit -m "feat: emit invoice/void event when an invoice is voided"
```

---

# Wave A — Dunning

## Task 6: `isWithinQuietHours` pure helper

**Files:**
- Create: `packages/core/src/quiet-hours.ts`
- Modify: `packages/core/src/index.ts` (add `export * from "./quiet-hours";`)
- Test: `packages/core/src/quiet-hours.test.ts`

- [ ] **Step 1: Write the failing test:**

```ts
import { describe, it, expect } from "vitest";
import { isWithinQuietHours, nextAllowedSendTime } from "./quiet-hours";

const QH = { startHour: 21, endHour: 8 }; // quiet 21:00–08:00 local

describe("isWithinQuietHours", () => {
  it("is quiet at 23:00 and 06:00, awake at noon", () => {
    expect(isWithinQuietHours(new Date("2026-06-10T23:00:00-07:00"), "America/Phoenix", QH)).toBe(true);
    expect(isWithinQuietHours(new Date("2026-06-10T06:00:00-07:00"), "America/Phoenix", QH)).toBe(true);
    expect(isWithinQuietHours(new Date("2026-06-10T12:00:00-07:00"), "America/Phoenix", QH)).toBe(false);
  });

  it("nextAllowedSendTime returns input when already awake", () => {
    const t = new Date("2026-06-10T12:00:00-07:00");
    expect(nextAllowedSendTime(t, "America/Phoenix", QH).getTime()).toBe(t.getTime());
  });

  it("nextAllowedSendTime jumps to endHour when quiet", () => {
    // 23:00 local -> next allowed is 08:00 local next day
    const t = new Date("2026-06-10T23:00:00-07:00");
    const next = nextAllowedSendTime(t, "America/Phoenix", QH);
    expect(isWithinQuietHours(next, "America/Phoenix", QH)).toBe(false);
    expect(next.getTime()).toBeGreaterThan(t.getTime());
  });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `pnpm test quiet-hours` → FAIL (module not found).

- [ ] **Step 3: Implement** `packages/core/src/quiet-hours.ts`:

```ts
export type QuietHours = { startHour: number; endHour: number };

/** Hour-of-day (0–23) for `date` in the given IANA timezone. */
function localHour(date: Date, tz: string): number {
  const s = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", hour12: false }).format(date);
  const h = parseInt(s, 10);
  return h === 24 ? 0 : h; // some runtimes format midnight as "24"
}

/** Quiet window wraps midnight when startHour > endHour (e.g. 21 → 8). */
export function isWithinQuietHours(date: Date, tz: string, qh: QuietHours): boolean {
  const h = localHour(date, tz);
  if (qh.startHour === qh.endHour) return false;
  return qh.startHour > qh.endHour
    ? h >= qh.startHour || h < qh.endHour // wraps midnight
    : h >= qh.startHour && h < qh.endHour;
}

/** First instant ≥ `date` that is NOT within quiet hours (advances 1h at a time, capped at 48 steps). */
export function nextAllowedSendTime(date: Date, tz: string, qh: QuietHours): Date {
  let t = new Date(date.getTime());
  for (let i = 0; i < 48 && isWithinQuietHours(t, tz, qh); i++) {
    t = new Date(t.getTime() + 60 * 60 * 1000);
  }
  return t;
}
```

> Hourly stepping is deliberate: it sidesteps DST edge cases and is exact enough for a "don't text at night" guard. The 48-step cap is a safety bound (a quiet window can't exceed 24h).

- [ ] **Step 4: Run, verify pass** → `pnpm test quiet-hours` PASS. Add the export to `packages/core/src/index.ts`.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/quiet-hours.ts packages/core/src/quiet-hours.test.ts packages/core/src/index.ts
git commit -m "feat(core): quiet-hours helper for TCPA-safe SMS scheduling"
```

## Task 7: Dunning schedule + email copy (pure)

**Files:**
- Create: `packages/core/src/dunning.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/dunning.test.ts`

- [ ] **Step 1: Write the failing test:**

```ts
import { describe, it, expect } from "vitest";
import { dunningSchedule, dunningEmail, dunningSms } from "./dunning";

describe("dunning schedule", () => {
  it("produces 4 steps with the SMS step last, at smsEscalationDay", () => {
    const steps = dunningSchedule({ smsEscalationDay: 30 });
    expect(steps.map((s) => s.dayOffset)).toEqual([3, 7, 14, 30]);
    expect(steps.map((s) => s.channel)).toEqual(["email", "email", "email", "sms"]);
    expect(steps[3].flipsOverdue).toBe(true);
  });

  it("email copy includes number + pay link, escalating tone", () => {
    const gentle = dunningEmail({ tone: "gentle", number: "INV-000007", payUrl: "https://pay", amountCents: 250000 });
    expect(gentle.subject).toContain("INV-000007");
    expect(gentle.html).toContain("https://pay");
    expect(gentle.html).toContain("$2,500.00");
    expect(dunningEmail({ tone: "final", number: "INV-000007", payUrl: "https://pay", amountCents: 250000 }).subject)
      .not.toBe(gentle.subject);
  });

  it("sms copy is short and includes the pay link", () => {
    const sms = dunningSms({ number: "INV-000007", payUrl: "https://pay" });
    expect(sms).toContain("INV-000007");
    expect(sms).toContain("https://pay");
    expect(sms.length).toBeLessThan(320);
  });
});
```

- [ ] **Step 2: Run, verify fail** → `pnpm test dunning` FAIL.

- [ ] **Step 3: Implement** `packages/core/src/dunning.ts`:

```ts
export type DunningTone = "gentle" | "firmer" | "firm" | "final";
export type DunningStep = { stepNum: number; dayOffset: number; channel: "email" | "sms"; tone: DunningTone; flipsOverdue: boolean };

export function dunningSchedule(opts: { smsEscalationDay: number }): DunningStep[] {
  return [
    { stepNum: 1, dayOffset: 3, channel: "email", tone: "gentle", flipsOverdue: false },
    { stepNum: 2, dayOffset: 7, channel: "email", tone: "firmer", flipsOverdue: false },
    { stepNum: 3, dayOffset: 14, channel: "email", tone: "firm", flipsOverdue: false },
    { stepNum: 4, dayOffset: opts.smsEscalationDay, channel: "sms", tone: "final", flipsOverdue: true },
  ];
}

function dollars(cents: number): string {
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
}

const TONE_LEAD: Record<DunningTone, string> = {
  gentle: "Just a friendly reminder that",
  firmer: "We wanted to follow up — ",
  firm: "Our records show that",
  final: "FINAL NOTICE: ",
};

export function dunningEmail(o: { tone: DunningTone; number: string; payUrl: string; amountCents: number }): { subject: string; html: string } {
  const subjectByTone: Record<DunningTone, string> = {
    gentle: `Reminder: invoice ${o.number}`,
    firmer: `Following up on invoice ${o.number}`,
    firm: `Past due: invoice ${o.number}`,
    final: `Final notice: invoice ${o.number} is overdue`,
  };
  const html =
    `<p>${TONE_LEAD[o.tone]} invoice <strong>${o.number}</strong> for ${dollars(o.amountCents)} ` +
    `is awaiting payment.</p><p><a href="${o.payUrl}">Pay now</a></p>`;
  return { subject: subjectByTone[o.tone], html };
}

export function dunningSms(o: { number: string; payUrl: string }): string {
  return `Invoice ${o.number} is overdue. Pay here: ${o.payUrl}. Reply STOP to opt out.`;
}
```

- [ ] **Step 4: Run, verify pass** → `pnpm test dunning` PASS. Add `export * from "./dunning";` to `packages/core/src/index.ts`.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/dunning.ts packages/core/src/dunning.test.ts packages/core/src/index.ts
git commit -m "feat(core): dunning schedule + templated email/sms copy"
```

## Task 8: Dunning Inngest workflow

**Files:**
- Create: `packages/agents/src/functions/dunning.ts`
- Modify: `packages/agents/src/index.ts` (register)

This clones the structure of `packages/agents/src/functions/drip.ts` (`dripRun`). Read that file first — the `step.sleep` / `cancelOn` / per-step status re-check shape is the template.

- [ ] **Step 1: Implement** `packages/agents/src/functions/dunning.ts`:

```ts
import { parseFinanceConfig, dunningSchedule, dunningEmail, dunningSms, nextAllowedSendTime } from "@savvy/core";
import { withTenant, eq, invoice, tenant, customer, communication, agentRun } from "@savvy/db";
import { twilioSms, resendEmail } from "@savvy/integrations";
import { inngest } from "../client";

export const dunningRun = inngest.createFunction(
  {
    id: "dunning-run",
    concurrency: { limit: 20 },
    // Stop the moment the invoice is paid or voided. Matched on invoiceId.
    cancelOn: [
      { event: "invoice/paid", match: "data.invoiceId" },
      { event: "invoice/void", match: "data.invoiceId" },
    ],
  },
  { event: "invoice/sent" },
  async ({ event, step }) => {
    const { tenantId, invoiceId } = event.data;

    const setup = await step.run("load", async () =>
      withTenant(tenantId, async (tx) => {
        const [inv] = await tx.select().from(invoice).where(eq(invoice.id, invoiceId));
        const [t] = await tx.select().from(tenant).where(eq(tenant.id, tenantId));
        if (!inv || !inv.dueAt) return null;
        const cfg = parseFinanceConfig((t?.settings as { finance?: unknown })?.finance);
        if (!cfg.dunning.enabled) return null;
        const cust = inv.customerId
          ? (await tx.select().from(customer).where(eq(customer.id, inv.customerId)))[0]
          : null;
        return { inv, cfg, cust };
      }),
    );
    if (!setup) return { skipped: true };

    const { cfg } = setup;
    const dueAt = new Date(setup.inv.dueAt!);
    const steps = dunningSchedule({ smsEscalationDay: cfg.dunning.smsEscalationDay });

    for (const s of steps) {
      // Sleep until dueAt + dayOffset; for SMS, push past quiet hours.
      let sendAt = new Date(dueAt.getTime() + s.dayOffset * 86400_000);
      if (s.channel === "sms") sendAt = nextAllowedSendTime(sendAt, cfg.timezone, cfg.dunning.quietHours);
      await step.sleepUntil(`wait-${s.stepNum}`, sendAt);

      const status = await step.run(`check-${s.stepNum}`, async () =>
        withTenant(tenantId, async (tx) => {
          const [inv] = await tx.select().from(invoice).where(eq(invoice.id, invoiceId));
          return inv?.status ?? "void";
        }),
      );
      if (status === "paid" || status === "void") return { stopped: true, atStep: s.stepNum };

      await step.run(`send-${s.stepNum}`, async () =>
        withTenant(tenantId, async (tx) => {
          const [inv] = await tx.select().from(invoice).where(eq(invoice.id, invoiceId));
          const cust = setup.cust;
          // Build a fresh pay link target (the hosted Checkout URL is created on demand by the web action;
          // for dunning we link to the invoice's public pay page which redirects to Checkout).
          const payUrl = `${process.env.APP_BASE_URL ?? "http://localhost:3000"}/invoices/${invoiceId}`;
          if (s.flipsOverdue && inv?.status === "sent") {
            await tx.update(invoice).set({ status: "overdue" }).where(eq(invoice.id, invoiceId));
          }
          if (s.channel === "email") {
            if (!cust?.email) { await logComm(tx, { tenantId, inv, channel: "email", note: "[suppressed: no email]" }); return; }
            const mail = dunningEmail({ tone: s.tone, number: inv?.number ?? "", payUrl, amountCents: inv?.amountDue ?? 0 });
            let id = "mock";
            try { ({ id } = await resendEmail.sendEmail({ to: cust.email, from: process.env.EMAIL_FROM ?? "noreply@example.com", subject: mail.subject, html: mail.html })); } catch {}
            await logComm(tx, { tenantId, inv, channel: "email", to: cust.email, body: mail.subject, providerId: id });
          } else {
            if (!cust?.phone) { await logComm(tx, { tenantId, inv, channel: "sms", note: "[suppressed: no phone]" }); return; }
            if (cust.smsOptOut) { await logComm(tx, { tenantId, inv, channel: "sms", note: "[suppressed: sms opt-out]" }); return; }
            const body = dunningSms({ number: inv?.number ?? "", payUrl });
            let sid = "mock";
            try { ({ sid } = await twilioSms.sendSms({ to: cust.phone, from: process.env.TWILIO_FROM ?? "+15555550000", body })); } catch {}
            await logComm(tx, { tenantId, inv, channel: "sms", to: cust.phone, body, providerId: sid });
          }
          await tx.insert(agentRun).values({ tenantId, agent: "finance", jobId: inv?.jobId ?? null, status: "ok" });
        }),
      );
    }
    return { completed: true };
  },
);

// Local helper — keep the send step readable. `tx` is the active tenant transaction.
async function logComm(tx: any, o: { tenantId: string; inv: any; channel: "email" | "sms"; to?: string; body?: string; note?: string; providerId?: string }) {
  await tx.insert(communication).values({
    tenantId: o.tenantId, customerId: o.inv?.customerId ?? null, jobId: o.inv?.jobId ?? null,
    channel: o.channel, direction: "outbound", to: o.to ?? null,
    body: o.note ?? o.body ?? "", twilioSid: o.channel === "sms" ? (o.providerId ?? null) : null, aiHandled: false,
  });
}
```

> `step.sleepUntil` (absolute timestamp) is the right primitive here vs `dripRun`'s relative `step.sleep("…h")`, because dunning anchors to `dueAt`, not enrollment time. `any` on the local `logComm`/`tx` is a pragmatic exception to the no-`any` rule for an internal helper threading a Drizzle tx; if lint forbids it, type `tx` as `Parameters<Parameters<typeof withTenant>[1]>[0]`.

- [ ] **Step 2: Register** — in `packages/agents/src/index.ts` add the import, the re-export, and append `dunningRun` to the `functions` array (mirror how `dripRun` appears in all three places).

- [ ] **Step 3: Typecheck + lint**

Run: `pnpm typecheck && pnpm lint` → PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/agents/src/functions/dunning.ts packages/agents/src/index.ts
git commit -m "feat(agents): dunning workflow — escalating reminders, stop on paid/void"
```

## Task 9: Dunning integration test (stops on paid/void)

**Files:**
- Test: `packages/agents/src/functions/dunning.test.ts`

Mirror `packages/agents/src/functions/drip-send.test.ts` / `drip.test.ts` for how they invoke a function's steps with a test harness or unit-test the send logic with injected fakes. The cheapest reliable test asserts the per-step status backstop: a `send` step is a no-op once status is `paid`/`void`.

- [ ] **Step 1: Write the test** — extract the per-step decision into a testable unit if the existing drip tests do so; otherwise test the `dunningSchedule`-driven branch by calling the function with an Inngest test harness. Concretely, assert:

```ts
import { describe, it, expect } from "vitest";
import { dunningSchedule } from "@savvy/core";

describe("dunning sequencing", () => {
  it("schedule is monotonic and ends on the SMS escalation day", () => {
    const steps = dunningSchedule({ smsEscalationDay: 21 });
    const offsets = steps.map((s) => s.dayOffset);
    expect([...offsets].sort((a, b) => a - b)).toEqual(offsets); // already ascending
    expect(steps.at(-1)).toMatchObject({ channel: "sms", dayOffset: 21 });
  });
});
```

> If `@savvy/agents` has an Inngest function-test harness pattern in a sibling test (check `appointment-reminders.test.ts`), add a harness-driven test that fires `invoice/sent`, advances to step 1, marks the invoice `paid`, and asserts the run returns `{ stopped: true }`. If no harness pattern exists in the repo, keep the unit-level assertion above and rely on the e2e (Task 19) for the end-to-end stop — note this gap in the commit message.

- [ ] **Step 2: Run** → `pnpm test dunning` PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/agents/src/functions/dunning.test.ts
git commit -m "test(agents): dunning schedule sequencing"
```

---

# Wave B — Commissions

## Task 10: `computeCommission` pure core (all three models)

**Files:**
- Create: `packages/core/src/commission.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/commission.test.ts`

- [ ] **Step 1: Write the failing test:**

```ts
import { describe, it, expect } from "vitest";
import { computeCommission } from "./commission";

describe("computeCommission", () => {
  it("flat: rate × basis", () => {
    expect(computeCommission({ model: "flat", basisCents: 100000, rate: 1000, priorPeriodTotalCents: 0 }))
      .toEqual({ amountCents: 10000, appliedRate: 1000 });
  });

  it("profit: caller passes profit as basis", () => {
    // basis already = paid - cost = 80000
    expect(computeCommission({ model: "profit", basisCents: 80000, rate: 1500, priorPeriodTotalCents: 0 }))
      .toEqual({ amountCents: 12000, appliedRate: 1500 });
  });

  it("tiered: picks the tier the prior-period total has reached", () => {
    const tiers = [{ thresholdCents: 5000000, rate: 1200 }];
    // below threshold -> base rate
    expect(computeCommission({ model: "tiered", basisCents: 100000, rate: 800, tiers, priorPeriodTotalCents: 0 }).appliedRate).toBe(800);
    // at/above threshold -> tier rate
    expect(computeCommission({ model: "tiered", basisCents: 100000, rate: 800, tiers, priorPeriodTotalCents: 5000000 }).appliedRate).toBe(1200);
  });

  it("rounds half-up to whole cents", () => {
    expect(computeCommission({ model: "flat", basisCents: 12345, rate: 1000, priorPeriodTotalCents: 0 }).amountCents).toBe(1235);
  });
});
```

- [ ] **Step 2: Run, verify fail** → `pnpm test commission` FAIL.

- [ ] **Step 3: Implement** `packages/core/src/commission.ts`:

```ts
import type { CommissionModel } from "./enums";

export type CommissionTier = { thresholdCents: number; rate: number };

export function computeCommission(input: {
  model: CommissionModel;
  basisCents: number;            // paid amount (flat/tiered) or profit (profit; caller pre-subtracts cost)
  rate: number;                  // basis points
  tiers?: CommissionTier[];
  priorPeriodTotalCents: number; // rep's basis already booked this period (tiered only)
}): { amountCents: number; appliedRate: number } {
  const basis = Math.max(0, input.basisCents);
  let appliedRate = input.rate;
  if (input.model === "tiered" && input.tiers?.length) {
    const reached = input.tiers
      .filter((t) => input.priorPeriodTotalCents >= t.thresholdCents)
      .sort((a, b) => b.thresholdCents - a.thresholdCents)[0];
    if (reached) appliedRate = reached.rate;
  }
  const amountCents = Math.round((basis * appliedRate) / 10_000);
  return { amountCents, appliedRate };
}
```

- [ ] **Step 4: Run, verify pass** → PASS. Add `export * from "./commission";` to `packages/core/src/index.ts`.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/commission.ts packages/core/src/commission.test.ts packages/core/src/index.ts
git commit -m "feat(core): computeCommission (flat/profit/tiered)"
```

## Task 11: `recordCommission` db lifecycle helper

**Files:**
- Create: `packages/db/src/lifecycle/commission.ts`
- Modify: `packages/db/src/index.ts` (export it)
- Test: `packages/db/tests/record-commission.test.ts`

- [ ] **Step 1: Write the failing test** (mirror `invoices.test.ts` setup helpers):

```ts
import { describe, it, expect } from "vitest";
import { recordCommission } from "../src/lifecycle/commission.js";
import { withTenant } from "../src/tenant.js";
import { commission } from "../src/schema/finance.js";
import { eq } from "drizzle-orm";
// reuse the invoices.test.ts helper to create tenant + job(with assignedUserId) + sent+paid invoice

describe("recordCommission", () => {
  it("computes flat commission on a paid invoice, idempotent", async () => {
    const { tenantId, invoiceId } = await makePaidInvoice({ amountCents: 100000, assignRep: true, rate: 1000 });
    const a = await recordCommission({ tenantId, invoiceId });
    expect(a?.amountCents).toBe(10000);
    const b = await recordCommission({ tenantId, invoiceId }); // second call no-ops
    expect(b?.alreadyRecorded ?? true).toBe(true);
    const rows = await withTenant(tenantId, (tx) => tx.select().from(commission).where(eq(commission.invoiceId, invoiceId)));
    expect(rows).toHaveLength(1);
  });

  it("skips when the job has no assigned rep", async () => {
    const { tenantId, invoiceId } = await makePaidInvoice({ amountCents: 100000, assignRep: false });
    expect(await recordCommission({ tenantId, invoiceId })).toBeNull();
  });
});
```

> Build `makePaidInvoice` on top of the existing invoices.test helpers: create a tenant with `settings.finance.commission = { model:'flat', rate:1000 }`, a job with/without `assignedUserId`, an invoice marked `paid` with a payment row. Keep it in the test file.

- [ ] **Step 2: Run, verify fail** → FAIL.

- [ ] **Step 3: Implement** `packages/db/src/lifecycle/commission.ts`:

```ts
import { withTenant } from "../tenant";
import { invoice, payment, commission } from "../schema/finance";
import { job } from "../schema/jobs";
import { tenant } from "../schema/tenancy";
import { and, eq, sql } from "drizzle-orm";
import { parseFinanceConfig, computeCommission } from "@savvy/core";

function periodKeyFor(date: Date, period: "monthly" | "quarterly"): string {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth(); // 0-based
  if (period === "quarterly") return `${y}-Q${Math.floor(m / 3) + 1}`;
  return `${y}-${String(m + 1).padStart(2, "0")}`;
}

export async function recordCommission(input: { tenantId: string; invoiceId: string }):
  Promise<{ amountCents: number; alreadyRecorded: boolean } | null> {
  return withTenant(input.tenantId, async (tx) => {
    const [inv] = await tx.select().from(invoice).where(eq(invoice.id, input.invoiceId));
    if (!inv) return null;

    const existing = await tx.select({ id: commission.id }).from(commission)
      .where(and(eq(commission.tenantId, input.tenantId), eq(commission.invoiceId, input.invoiceId)));
    if (existing.length > 0) return { amountCents: 0, alreadyRecorded: true };

    const [j] = await tx.select().from(job).where(eq(job.id, inv.jobId));
    const repId = j?.assignedUserId;
    if (!repId) return null; // no rep -> skip

    const [t] = await tx.select().from(tenant).where(eq(tenant.id, input.tenantId));
    const cfg = parseFinanceConfig((t?.settings as { finance?: unknown })?.finance).commission;
    const rate = cfg.perRepRate[repId] ?? cfg.rate;

    // Basis: paid amount; profit model subtracts job cost (skip if unknown).
    let basisCents = inv.amountPaid ?? 0;
    if (cfg.model === "profit") {
      if (j?.costCents == null) return null; // can't compute profit without cost
      basisCents = (inv.amountPaid ?? 0) - j.costCents;
    }

    const [pmt] = await tx.select().from(payment).where(eq(payment.invoiceId, input.invoiceId))
      .orderBy(sql`received_at desc`).limit(1);
    const periodKey = periodKeyFor(pmt?.receivedAt ?? new Date(), cfg.period);

    const [{ prior }] = await tx.select({ prior: sql<number>`coalesce(sum(basis_cents),0)::int` })
      .from(commission)
      .where(and(eq(commission.tenantId, input.tenantId), eq(commission.userId, repId), eq(commission.periodKey, periodKey)));

    const { amountCents, appliedRate } = computeCommission({
      model: cfg.model, basisCents, rate, tiers: cfg.tiers, priorPeriodTotalCents: prior ?? 0,
    });

    await tx.insert(commission).values({
      tenantId: input.tenantId, invoiceId: input.invoiceId, userId: repId, model: cfg.model,
      basisCents, rate: appliedRate, amountCents, periodKey, status: "pending",
    }).onConflictDoNothing();

    return { amountCents, alreadyRecorded: false };
  });
}
```

- [ ] **Step 4: Export** — add to `packages/db/src/index.ts`: `export { recordCommission } from "./lifecycle/commission";` (alongside the other `lifecycle/*` exports near the top).

- [ ] **Step 5: Run, verify pass** → `pnpm test record-commission` PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/lifecycle/commission.ts packages/db/src/index.ts packages/db/tests/record-commission.test.ts
git commit -m "feat(db): recordCommission — idempotent, period-aware, per-rep override"
```

## Task 12: Commission Inngest workflow

**Files:**
- Create: `packages/agents/src/functions/commission.ts`
- Modify: `packages/agents/src/index.ts`

- [ ] **Step 1: Implement** `packages/agents/src/functions/commission.ts`:

```ts
import { withTenant, recordCommission, eq, agentRun, invoice } from "@savvy/db";
import { inngest } from "../client";

export const commissionOnPaid = inngest.createFunction(
  { id: "commission-on-paid", concurrency: { limit: 20 } },
  { event: "invoice/paid" },
  async ({ event, step }) => {
    const { tenantId, invoiceId } = event.data;
    const result = await step.run("record-commission", async () => recordCommission({ tenantId, invoiceId }));
    await step.run("log", async () =>
      withTenant(tenantId, async (tx) => {
        const [inv] = await tx.select().from(invoice).where(eq(invoice.id, invoiceId));
        await tx.insert(agentRun).values({
          tenantId, agent: "finance", jobId: inv?.jobId ?? null,
          status: result ? "ok" : "skipped",
        });
      }),
    );
    return { commission: result };
  },
);
```

> Confirm the `agentRun.status` enum accepts `"skipped"` (check `AGENT` sibling enums in core — if `agent_run.status` is free text or an enum without `skipped`, use `"ok"` and rely on the returned `result` being null). Adjust to the actual column type.

- [ ] **Step 2: Register** in `packages/agents/src/index.ts` (import, re-export, append `commissionOnPaid` to `functions`).

- [ ] **Step 3: Typecheck + lint** → PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/agents/src/functions/commission.ts packages/agents/src/index.ts
git commit -m "feat(agents): commission workflow on invoice/paid"
```

## Task 13: Commissions list UI

**Files:**
- Create: `apps/web/src/lib/commission-queries.ts`
- Create: `apps/web/src/app/(app)/commissions/page.tsx`, `apps/web/src/app/(app)/commissions/CommissionsClient.tsx`
- Modify: `apps/web/src/app/(app)/layout.tsx` (nav link)

Mirror the 5A invoices list (`apps/web/src/app/(app)/invoices/page.tsx` + `InvoicesClient.tsx` + `finance-queries.ts`) for the exact server-component/`force-dynamic`/`getTenantId` pattern.

- [ ] **Step 1: Query** — `apps/web/src/lib/commission-queries.ts`:

```ts
import { withTenant, commission, invoice, user, eq, desc } from "@savvy/db";
import { getTenantId } from "./tenant";

export async function listCommissions() {
  const tenantId = await getTenantId();
  return withTenant(tenantId, async (tx) =>
    tx.select({
      id: commission.id, amountCents: commission.amountCents, basisCents: commission.basisCents,
      rate: commission.rate, model: commission.model, status: commission.status,
      periodKey: commission.periodKey, invoiceNumber: invoice.number, repName: user.name,
    })
      .from(commission)
      .leftJoin(invoice, eq(invoice.id, commission.invoiceId))
      .leftJoin(user, eq(user.id, commission.userId))
      .orderBy(desc(commission.createdAt)),
  );
}
```

> Confirm `user.name` exists (it's used by the comms/drip code as `c.name` on customer; check the `user` table's display column — could be `name` or `firstName`). Adjust the selected column accordingly.

- [ ] **Step 2: Page** — `commissions/page.tsx`:

```tsx
import { listCommissions } from "@/lib/commission-queries";
import { CommissionsClient } from "./CommissionsClient";

export const dynamic = "force-dynamic";

export default async function CommissionsPage() {
  const rows = await listCommissions();
  return <CommissionsClient rows={rows} />;
}
```

- [ ] **Step 3: Client table** — `CommissionsClient.tsx`: a read-only table (rep, invoice #, model, basis $, rate %, amount $, period, status badge). Reuse the shadcn table + currency formatting from `InvoicesClient.tsx`. Rate display: `(rate/100).toFixed(1) + "%"`.

- [ ] **Step 4: Nav** — add a `Commissions` link to `apps/web/src/app/(app)/layout.tsx` next to the existing `Invoices`/`Comms` links (match the existing link markup).

- [ ] **Step 5: Build check**

Run: `pnpm --filter @savvy/web typecheck` (or root `pnpm typecheck`) → PASS. (The known Clerk static-prerender build warning is pre-existing; `force-dynamic` keeps this page out of prerender.)

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/commission-queries.ts "apps/web/src/app/(app)/commissions" "apps/web/src/app/(app)/layout.tsx"
git commit -m "feat(web): commissions list (read-only)"
```

---

# Wave C — QuickBooks push

## Task 14: Extract `nangoProxy` to a shared module

**Files:**
- Create: `packages/integrations/src/nango.ts`
- Modify: `packages/integrations/src/gcal.ts`, `packages/integrations/src/index.ts`

- [ ] **Step 1: Create** `packages/integrations/src/nango.ts` — move the `nangoProxy` function out of `gcal.ts` verbatim, but make the integration-id a parameter (gcal hard-coded `NANGO_GCAL_INTEGRATION_ID`; QBO needs its own):

```ts
export async function nangoProxy(
  o: { connectionId: string; integrationId: string; method: string; endpoint: string; body?: unknown },
): Promise<unknown> {
  const host = process.env.NANGO_HOST ?? "https://api.nango.dev";
  const res = await fetch(`${host}/proxy${o.endpoint}`, {
    method: o.method,
    headers: {
      Authorization: `Bearer ${process.env.NANGO_SECRET_KEY ?? ""}`,
      "Connection-Id": o.connectionId,
      "Provider-Config-Key": o.integrationId,
      "Content-Type": "application/json",
    },
    ...(o.body ? { body: JSON.stringify(o.body) } : {}),
  });
  if (!res.ok) throw new Error(`nango proxy ${o.method} ${o.endpoint} -> ${res.status}`);
  return o.method === "DELETE" ? undefined : res.json();
}
```

- [ ] **Step 2: Update gcal** — in `gcal.ts`, delete the local `nangoProxy` and `import { nangoProxy } from "./nango";`. Update the three call sites to the new object signature, passing `integrationId: process.env.NANGO_GCAL_INTEGRATION_ID ?? "google-calendar"`. Example:

```ts
const res = await nangoProxy({ connectionId, integrationId: process.env.NANGO_GCAL_INTEGRATION_ID ?? "google-calendar", method: "POST", endpoint: "/calendar/v3/calendars/primary/events", body: { /* … */ } });
```

- [ ] **Step 3: Export** — add `export { nangoProxy } from "./nango";` to `packages/integrations/src/index.ts`.

- [ ] **Step 4: Typecheck**

Run: `pnpm typecheck` → PASS (gcal behavior unchanged; no gcal test should break).

- [ ] **Step 5: Commit**

```bash
git add packages/integrations/src/nango.ts packages/integrations/src/gcal.ts packages/integrations/src/index.ts
git commit -m "refactor(integrations): extract shared nangoProxy transport"
```

## Task 15: `QboGateway` interface + real + fake

**Files:**
- Create: `packages/integrations/src/qbo.ts`
- Modify: `packages/integrations/src/index.ts`
- Test: `packages/integrations/src/qbo.test.ts` — **note:** `@savvy/integrations` has no `test` script. Either (a) add one mirroring `@savvy/db`'s `package.json` test script, or (b) put this test in `@savvy/agents` where the QBO sync is exercised. Prefer (a): add `"test": "vitest run"` to `packages/integrations/package.json` and a minimal `vitest` devDep matching the other packages.

- [ ] **Step 1: Write the failing test** `packages/integrations/src/qbo.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { makeFakeQbo } from "./qbo";

describe("makeFakeQbo", () => {
  it("returns deterministic ids and records calls", async () => {
    const qbo = makeFakeQbo();
    const c = await qbo.upsertCustomer({ connectionId: "x", customer: { id: "cust1", name: "Acme" } });
    const i = await qbo.upsertInvoice({ connectionId: "x", qboCustomerId: c.qboId, invoice: { number: "INV-1", lineItems: [], amountCents: 1000, dueAt: null } });
    const p = await qbo.recordPayment({ connectionId: "x", qboInvoiceId: i.qboId, amountCents: 1000, receivedAt: "2026-06-10" });
    expect(c.qboId).toMatch(/^qbo_cust_/);
    expect(i.qboId).toMatch(/^qbo_inv_/);
    expect(p.qboId).toMatch(/^qbo_pmt_/);
    expect(qbo.calls.map((x) => x.op)).toEqual(["customer", "invoice", "payment"]);
  });
});
```

- [ ] **Step 2: Run, verify fail** → FAIL.

- [ ] **Step 3: Implement** `packages/integrations/src/qbo.ts`:

```ts
import { nangoProxy } from "./nango";

export interface QboGateway {
  upsertCustomer(o: { connectionId: string; customer: { id: string; name: string; email?: string } }): Promise<{ qboId: string }>;
  upsertInvoice(o: { connectionId: string; qboCustomerId: string; invoice: { number: string; lineItems: unknown[]; amountCents: number; dueAt: string | null } }): Promise<{ qboId: string }>;
  recordPayment(o: { connectionId: string; qboInvoiceId: string; amountCents: number; receivedAt: string }): Promise<{ qboId: string }>;
}

const QBO_INTEGRATION = () => process.env.NANGO_QBO_INTEGRATION_ID ?? "quickbooks";

export const nangoQbo: QboGateway = {
  async upsertCustomer({ connectionId, customer }) {
    const res = await nangoProxy({ connectionId, integrationId: QBO_INTEGRATION(), method: "POST", endpoint: "/v3/company/customer",
      body: { DisplayName: customer.name, PrimaryEmailAddr: customer.email ? { Address: customer.email } : undefined } });
    return { qboId: String((res as { Customer?: { Id: string } }).Customer?.Id ?? "") };
  },
  async upsertInvoice({ connectionId, qboCustomerId, invoice }) {
    const res = await nangoProxy({ connectionId, integrationId: QBO_INTEGRATION(), method: "POST", endpoint: "/v3/company/invoice",
      body: { CustomerRef: { value: qboCustomerId }, DocNumber: invoice.number,
        Line: [{ Amount: invoice.amountCents / 100, DetailType: "SalesItemLineDetail", SalesItemLineDetail: {} }] } });
    return { qboId: String((res as { Invoice?: { Id: string } }).Invoice?.Id ?? "") };
  },
  async recordPayment({ connectionId, qboInvoiceId, amountCents }) {
    const res = await nangoProxy({ connectionId, integrationId: QBO_INTEGRATION(), method: "POST", endpoint: "/v3/company/payment",
      body: { TotalAmt: amountCents / 100, Line: [{ Amount: amountCents / 100, LinkedTxn: [{ TxnId: qboInvoiceId, TxnType: "Invoice" }] }] } });
    return { qboId: String((res as { Payment?: { Id: string } }).Payment?.Id ?? "") };
  },
};

export function makeFakeQbo(): QboGateway & { calls: { op: string; id: string }[] } {
  const calls: { op: string; id: string }[] = [];
  let n = 0;
  return {
    calls,
    async upsertCustomer() { const qboId = `qbo_cust_${++n}`; calls.push({ op: "customer", id: qboId }); return { qboId }; },
    async upsertInvoice() { const qboId = `qbo_inv_${++n}`; calls.push({ op: "invoice", id: qboId }); return { qboId }; },
    async recordPayment() { const qboId = `qbo_pmt_${++n}`; calls.push({ op: "payment", id: qboId }); return { qboId }; },
  };
}
```

> The exact QBO API field shapes (CustomerRef/Line/LinkedTxn) are best-effort per the QBO Accounting API; the real impl is validated against a sandbox later. The **fake** is what the tests + e2e use, so field-shape drift in `nangoQbo` doesn't block the phase. Note this in the commit.

- [ ] **Step 4: Run, verify pass** → `pnpm test qbo` PASS. Add `export { nangoQbo, makeFakeQbo, type QboGateway } from "./qbo";` to `packages/integrations/src/index.ts`.

- [ ] **Step 5: Commit**

```bash
git add packages/integrations/src/qbo.ts packages/integrations/src/index.ts packages/integrations/src/qbo.test.ts packages/integrations/package.json
git commit -m "feat(integrations): QboGateway (real via nango + fake)"
```

## Task 16: QBO connect flow (settings UI + Nango start/callback)

**Files:**
- Create: `apps/web/src/app/api/nango/qbo/start/route.ts`, `apps/web/src/app/api/nango/qbo/callback/route.ts`
- Create: `apps/web/src/app/(app)/settings/quickbooks/page.tsx`, `ConnectQuickBooksButton.tsx`
- Modify: middleware if the gcal connect routes are public (check `apps/web/src/middleware.ts`)

Mirror the existing **gcal connect flow** (find it: `grep -rl "gcalConnectionId\|nango" apps/web/src/app`) for the exact Nango session-token / redirect pattern. QBO connection is **tenant-level** (`tenant.qboConnectionId`), unlike gcal which is user-level.

- [ ] **Step 1: Settings page** — `settings/quickbooks/page.tsx` (server component, `force-dynamic`): read `tenant.qboConnectionId` via `withTenant`/`getTenantId`; render connected status + `<ConnectQuickBooksButton/>`.

- [ ] **Step 2: Start route** — `api/nango/qbo/start/route.ts`: Clerk-protected; resolve `getTenantId()`; create a Nango Connect session (mirror gcal) for integration `process.env.NANGO_QBO_INTEGRATION_ID`; redirect/return the Connect URL.

- [ ] **Step 3: Callback route** — `api/nango/qbo/callback/route.ts`: on success, store the Nango connectionId on `tenant.qboConnectionId` via **adminDb** (tenant is the RLS root — follow the 5A Stripe `connect/callback` pattern in `apps/web/src/app/api/stripe/connect/callback/route.ts`), then redirect to `/settings/quickbooks?connected=1`.

> Read both `apps/web/src/app/api/stripe/connect/callback/route.ts` (for the adminDb tenant-write + redirect) and the gcal connect route (for the Nango specifics) and combine. If the repo's gcal flow uses Nango's frontend SDK rather than a redirect, follow that instead — match what exists.

- [ ] **Step 4: Typecheck** → PASS.

- [ ] **Step 5: Commit**

```bash
git add "apps/web/src/app/api/nango/qbo" "apps/web/src/app/(app)/settings/quickbooks"
git commit -m "feat(web): QuickBooks connect flow (tenant-level Nango connection)"
```

## Task 17: QBO sync workflows

**Files:**
- Create: `packages/agents/src/functions/qbo-sync.ts`
- Modify: `packages/agents/src/index.ts`
- Test: `packages/agents/src/functions/qbo-sync.test.ts` (uses `makeFakeQbo`)

- [ ] **Step 1: Implement** `packages/agents/src/functions/qbo-sync.ts` — two functions, both no-op when `tenant.qboConnectionId` is null:

```ts
import { withTenant, eq, and, invoice, payment, customer, tenant } from "@savvy/db";
import type { QboGateway } from "@savvy/integrations";
import { nangoQbo } from "@savvy/integrations";
import { inngest } from "../client";

async function ensureCustomerAndInvoice(tenantId: string, invoiceId: string, qbo: QboGateway) {
  return withTenant(tenantId, async (tx) => {
    const [t] = await tx.select().from(tenant).where(eq(tenant.id, tenantId));
    const conn = t?.qboConnectionId;
    if (!conn) return { skipped: "not_connected" as const };
    const [inv] = await tx.select().from(invoice).where(eq(invoice.id, invoiceId));
    if (!inv) return { skipped: "no_invoice" as const };
    if (inv.qboId) return { qboInvoiceId: inv.qboId }; // already pushed

    let cust = inv.customerId ? (await tx.select().from(customer).where(eq(customer.id, inv.customerId)))[0] : null;
    let qboCustomerId = cust?.qboId ?? null;
    if (cust && !qboCustomerId) {
      const r = await qbo.upsertCustomer({ connectionId: conn, customer: { id: cust.id, name: cust.name, email: cust.email ?? undefined } });
      qboCustomerId = r.qboId;
      await tx.update(customer).set({ qboId: qboCustomerId }).where(eq(customer.id, cust.id));
    }
    const r = await qbo.upsertInvoice({ connectionId: conn, qboCustomerId: qboCustomerId ?? "",
      invoice: { number: inv.number ?? "", lineItems: inv.lineItems as unknown[], amountCents: inv.amountDue ?? 0, dueAt: inv.dueAt?.toISOString() ?? null } });
    await tx.update(invoice).set({ qboId: r.qboId }).where(eq(invoice.id, inv.id));
    return { qboInvoiceId: r.qboId };
  });
}

export const qboPushInvoice = inngest.createFunction(
  { id: "qbo-push-invoice", concurrency: { limit: 10 }, retries: 3 },
  { event: "invoice/sent" },
  async ({ event, step }) => step.run("push", () => ensureCustomerAndInvoice(event.data.tenantId, event.data.invoiceId, nangoQbo)),
);

export const qboPushPayment = inngest.createFunction(
  { id: "qbo-push-payment", concurrency: { limit: 10 }, retries: 3 },
  { event: "invoice/paid" },
  async ({ event, step }) => {
    const { tenantId, invoiceId } = event.data;
    const ensured = await step.run("ensure-invoice", () => ensureCustomerAndInvoice(tenantId, invoiceId, nangoQbo));
    if (!("qboInvoiceId" in ensured) || !ensured.qboInvoiceId) return { skipped: true };
    return step.run("push-payment", async () =>
      withTenant(tenantId, async (tx) => {
        const [t] = await tx.select().from(tenant).where(eq(tenant.id, tenantId));
        if (!t?.qboConnectionId) return { skipped: "not_connected" };
        const [pmt] = await tx.select().from(payment)
          .where(and(eq(payment.invoiceId, invoiceId))).orderBy(payment.receivedAt);
        if (!pmt || pmt.qboId) return { skipped: "no_unsynced_payment" };
        const r = await nangoQbo.recordPayment({ connectionId: t.qboConnectionId, qboInvoiceId: ensured.qboInvoiceId, amountCents: pmt.amount, receivedAt: pmt.receivedAt.toISOString() });
        await tx.update(payment).set({ qboId: r.qboId }).where(eq(payment.id, pmt.id));
        return { qboPaymentId: r.qboId };
      }),
    );
  },
);
```

> Verify the `retries` option key against how other functions set retries (Inngest v3 uses `retries: n` in the function config — confirm against `appointment-reminders.ts` or the Inngest version in package.json).

- [ ] **Step 2: Test** `qbo-sync.test.ts` — inject `makeFakeQbo()` instead of `nangoQbo` (refactor the two functions to accept an optional gateway param defaulting to `nangoQbo`, so tests pass the fake), then assert: connected tenant → customer upserted once, invoice once; second `invoice/sent` → no duplicate (invoice already has `qboId`). Use the agents test harness pattern from a sibling test.

- [ ] **Step 3: Register** in `packages/agents/src/index.ts` (`qboPushInvoice`, `qboPushPayment`).

- [ ] **Step 4: Run** → `pnpm test qbo-sync` PASS; `pnpm typecheck && pnpm lint` PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agents/src/functions/qbo-sync.ts packages/agents/src/functions/qbo-sync.test.ts packages/agents/src/index.ts
git commit -m "feat(agents): QBO sync — push invoice on sent, payment on paid (idempotent)"
```

---

# Wave Gate — isolation, e2e, env

## Task 18: Extend RLS isolation test for `commission`

**Files:**
- Modify: the existing cross-tenant isolation test (find it: `grep -rl "isolation\|cross-tenant\|cross tenant" packages/db/tests`)

- [ ] **Step 1: Add a case** — following the existing per-table pattern in that file: insert a `commission` row under tenant A, set the session to tenant B (`savvy_app` role, `app.tenant_id` = B), assert the select returns zero rows.

- [ ] **Step 2: Run** → `pnpm test <isolation-test-name>` PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/db/tests
git commit -m "test(db): RLS isolation covers commission table"
```

## Task 19: e2e — dunning stop + commissions list

**Files:**
- Create: `apps/web/tests/e2e/finance-automation.spec.ts`

Use the e2e recipe from the handoff (`TEST_MODE=1`, `TEST_TENANT_ID`, ai-stub, inngest-cli dev). Mirror `apps/web/tests/e2e/finance.spec.ts` (5A) for harness setup.

- [ ] **Step 1: Write the e2e** covering:
  1. Create + send an invoice (reuse 5A helpers) → assert it appears `sent`.
  2. Simulate full payment via the mock Stripe webhook (as 5A's finance.spec does) → assert invoice `paid`.
  3. Navigate to `/commissions` → assert a commission row exists for that invoice (rep assigned in the test tenant seed; commission rate from seeded `settings.finance`).
  4. (If the inngest dev server is running in the e2e) assert the dunning run for that invoice ended without sending (cancelled by `invoice/paid`) — at minimum assert no overdue dunning `communication` rows were logged for the paid invoice.

- [ ] **Step 2: Run the e2e** per the recipe; verify PASS. Kill dev servers after (`pkill -f ai-stub.mjs; pkill -f inngest-cli; pkill -f "next dev"`).

- [ ] **Step 3: Commit**

```bash
git add apps/web/tests/e2e/finance-automation.spec.ts
git commit -m "test(e2e): finance automation — paid invoice yields commission, cancels dunning"
```

## Task 20: `.env.example` + final static gate

**Files:**
- Modify: `.env.example`

- [ ] **Step 1: Document new env** — append to `.env.example`:

```bash
# QuickBooks (via Nango) — Phase 5B
NANGO_QBO_INTEGRATION_ID=quickbooks
```

(`NANGO_HOST`, `NANGO_SECRET_KEY` already documented for gcal.)

- [ ] **Step 2: Full static gate**

Run:
```bash
export DATABASE_URL=postgres://savvy_app:savvy_app@localhost:5432/savvy DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/savvy
pnpm typecheck && pnpm lint && pnpm test
```
Expected: all green.

- [ ] **Step 3: Commit + push + open PR**

```bash
git add .env.example
git commit -m "chore: document NANGO_QBO_INTEGRATION_ID for Phase 5B"
git push -u origin feat/phase5b-finance-automation
gh pr create --title "Phase 5B: Finance automation — dunning + commissions + QBO push" \
  --body "Implements the Phase 5B spec: dunning workflow (escalating email→SMS, stop on paid/void, TCPA quiet-hours), commission engine (flat/profit/tiered, per-tenant), and one-way QuickBooks push (invoices/payments/customers via Nango). All off existing invoice/sent + invoice/paid events. See docs/superpowers/specs/2026-06-10-phase5b-finance-automation-design.md."
```

---

## Self-Review (completed by plan author)

**Spec coverage:**
- §4 schema (job.costCents, commission table, payment/customer.qboId, tenant.qboConnectionId, enums, settings) → Tasks 1–4. ✅
- §5 dunning (workflow, cadence, stop, TCPA, logging) → Tasks 6–9 + Task 5 (`invoice/void`). ✅
- §6 commissions (3 models, workflow, idempotency, UI) → Tasks 10–13. ✅
- §7 QBO (nango extract, gateway, connect, sync) → Tasks 14–17. ✅
- §8 events (`invoice/void`) → Task 5. ✅
- §10 testing (unit, integration, RLS, e2e) → Tasks 6–17 inline + Tasks 18–19. ✅
- §11 done (RLS, durable+idempotent, no hardcoded models, tests, env, one PR) → Tasks 18–20. ✅

**Open verifications flagged inline** (engineer must confirm against live code, not guess): `user` import path + display column (Tasks 4, 13); `agent_run.status` enum values incl. `skipped` (Task 12); Inngest `retries`/`cancelOn match` syntax for the repo's Inngest version (Tasks 8, 17); existence of an agents Inngest test harness (Tasks 9, 17); the gcal/Nango connect specifics (Task 16); the RLS isolation test filename (Task 18). These are real-codebase lookups, not placeholders — each names exactly what to check and the fallback.

**Type consistency:** `FinanceConfig.commission` (Task 2) → consumed in Tasks 8, 11 with matching fields (`model`, `rate`, `tiers`, `period`, `perRepRate`). `computeCommission` signature (Task 10) matches its caller (Task 11). `QboGateway` (Task 15) matches callers (Task 17). `dunningSchedule`/`dunningEmail`/`dunningSms` (Task 7) match the workflow (Task 8). ✅
