# Phase 5B — Finance Automation (Design Spec)

**Date:** 2026-06-10
**Parent:** Phase 5 (Finance agent). 5A shipped the money path (invoicing + Stripe Connect + reconciliation). 5B builds the three automations that hang off it: **dunning/AR**, **commission calc**, and **QuickBooks Online (QBO) one-way push**. Roadmap Phase 5 done-when: "invoice → payment → reconciled; overdue dunning runs automatically."

## 1. Summary

With the money path live, 5B automates everything downstream of an invoice. All three subsystems trigger off the **existing** `invoice/sent` / `invoice/paid` events emitted in 5A — none requires new event plumbing, and all three are independent of each other (order-flexible).

- **Dunning** — a durable Inngest workflow chases overdue invoices on an escalating cadence (email, then SMS on the most overdue), stopping the moment the invoice is paid or voided.
- **Commissions** — on `invoice/paid`, compute the assigned rep's payout via one of three tenant-configurable models (flat %, profit %, tiered) and record it.
- **QBO push** — invoices, payments, and customers flow one-way from Savvy into QuickBooks Online via Nango.

**Ships as one PR (Phase 5B).** Built in three internal waves (A dunning, B commissions, C QBO) so the implementation plan sequences sanely, but merges together.

## 2. Scope decisions (locked during brainstorming)

| Decision | Choice |
|---|---|
| Subsystems in this phase | All three: dunning + commissions + QBO push |
| Dunning channel | Email reminders, escalating to SMS on the most-overdue step |
| Commission config | Per-tenant ("each company decides") |
| Commission models implemented | All three now: flat %, profit %, tiered |
| QBO sync scope | Invoices + payments + customers |
| Build/ship structure | One spec, one PR; internal waves A/B/C |
| `commission/created` event | Skipped (YAGNI) — add when a consumer needs it |

### Out of scope (deferred follow-ups)
- Commission **approval/payout** workflow + UI actions (5B records commissions read-only; approve/pay is a later phase).
- **Two-way** QBO sync / pulling QBO changes back into Savvy (5B is one-way push only).
- **Customer-level timezone** capture for TCPA (5B uses tenant timezone; customer tz is a follow-up).
- Standalone QBO customer sync decoupled from invoicing (customers are upserted lazily on first invoice push).

## 3. Architecture approach

Reuse the established patterns from Phases 3–5A rather than introduce new infrastructure:

- **Dunning** clones the comms-agent drip pattern (`packages/agents/src/functions/drip.ts`): one Inngest run per invoice, `step.sleep` between reminders, `cancelOn` to stop early, plus a per-step DB-status re-check backstop.
- **Commissions** are pure math in `@savvy/core` (testable in isolation) invoked by a thin `invoice/paid` Inngest function that does the DB I/O.
- **QBO** reuses the `nangoProxy()` transport already powering Google Calendar sync, extracted to a shared module. A `QboGateway` interface (real + fake) mirrors the `StripeGateway` / `CalendarSync` pattern.
- **All AI-free** — these are deterministic workflows; no gateway calls needed. (Dunning email copy is templated, not AI-drafted, in 5B.)

## 4. Data model changes (migration `0005`)

### 4.1 `job`
- Add `costCents integer` (nullable). Source of truth for the profit commission model. Null → profit model skips that invoice (logs, no commission row).

### 4.2 `commission` (new table, `packages/db/src/schema/finance.ts`)
```ts
export const commission = pgTable("commission", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  invoiceId: uuid("invoice_id").notNull().references(() => invoice.id),
  userId: uuid("user_id").notNull().references(() => user.id),   // the rep
  model: commissionModelEnum("model").notNull(),                 // flat|profit|tiered
  basisCents: integer("basis_cents").notNull(),                  // paid amount, or profit
  rate: integer("rate").notNull(),                               // basis points (1000 = 10%)
  amountCents: integer("amount_cents").notNull(),
  periodKey: text("period_key").notNull(),                       // "YYYY-MM"
  status: commissionStatusEnum("status").notNull().default("pending"), // pending|approved|paid
  createdAt: createdAt(),
}, (t) => [
  index("commission_tenant_user_idx").on(t.tenantId, t.userId),
  uniqueIndex("commission_tenant_invoice_uniq").on(t.tenantId, t.invoiceId), // idempotency
  tenantIsolation(),
]);
```

### 4.3 `payment` / `customer`
- `payment`: add `qboId text` (nullable) — QBO payment idempotency.
- `customer`: add `qboId text` (nullable) — QBO customer idempotency.
- `invoice.qboId` already exists (added in 5A schema).

### 4.4 `tenant`
- Add `qboConnectionId text` (nullable) — the per-tenant Nango connection id for QBO. Null → tenant hasn't linked QuickBooks → QBO workflows no-op.

### 4.5 Enums
- `@savvy/core`: `COMMISSION_MODEL` (`flat|profit|tiered`), `COMMISSION_STATUS` (`pending|approved|paid`) const tuples + types.
- `@savvy/db`: `commissionModelEnum`, `commissionStatusEnum` pgEnums (same pattern as 5A's `invoiceStatusEnum`).

### 4.6 `tenant.settings.finance` (jsonb, extended — no new table)
Parsed by the `@savvy/core` zod schema with defaults; 5A keys preserved:
```jsonc
{
  "netDays": 14,
  "invoiceNumberPrefix": "INV-",
  "timezone": "America/Phoenix",
  "dunning": {
    "enabled": true,
    "smsEscalationDay": 30,
    "quietHours": { "startHour": 21, "endHour": 8 }
  },
  "commission": {
    "model": "flat",
    "rate": 1000,
    "tiers": [{ "thresholdCents": 5000000, "rate": 1200 }],
    "period": "monthly",
    "perRepRate": { "<userId>": 800 }
  }
}
```
- `rate` and all tier rates are **basis points** (1000 = 10%) — integer math, no floats.
- `perRepRate[userId]` overrides the tenant `rate` for that rep (applies to flat & profit; tiered uses tier rates).
- Zod schema provides every default so existing tenants with only the 5A keys parse cleanly.

## 5. Wave A — Dunning workflow

**`packages/agents/src/functions/dunning.ts`** — durable Inngest fn, one run per invoice, modeled on `dripRun`.

- **Trigger:** `invoice/sent`. Reads the invoice + `tenant.settings.finance.dunning`; if `enabled === false`, exits immediately.
- **Cadence** (relative to `invoice.dueAt`; tenant-overridable via settings later, defaults here):
  | Step | When | Channel | Tone |
  |---|---|---|---|
  | 1 | due + 3 days | email | gentle reminder |
  | 2 | due + 7 days | email | firmer |
  | 3 | due + 14 days | email | firm |
  | 4 | due + `smsEscalationDay` (default 30) | SMS + email | final; flips invoice → `overdue` |
  - Each email includes the Stripe Checkout pay link (regenerated via the 5A `createCheckoutForInvoice` action if no live session).
- **Between steps:** `step.sleep` until the target timestamp.
- **Stop conditions (belt-and-suspenders, all three):**
  1. `cancelOn` `invoice/paid` matched on `invoiceId`.
  2. `cancelOn` `invoice/void` matched on `invoiceId` (**new event — see §8**).
  3. Per-step backstop: re-read `invoice.status` before each send; if `paid` or `void`, exit.
- **TCPA quiet-hours:** pure `@savvy/core` helper `isWithinQuietHours(date, tz, { startHour, endHour })`. The SMS step computes the next allowed send time and `step.sleep`s until then. `tz` resolves from `settings.finance.timezone` (customer-level tz is a deferred follow-up). Phase 3's STOP-keyword opt-out (`customer.sms_opt_out`) is honored — the SMS step suppresses if opted out.
- **Logging:** every send writes a `communication` row (tenant-scoped) and the run records an `agent_run`, same as the comms agent.

## 6. Wave B — Commission engine

### 6.1 Pure core (`packages/core/src/commission.ts`)
```ts
export function computeCommission(input: {
  model: CommissionModel;
  basisCents: number;            // paid amount (flat/tiered) or profit (profit)
  rate: number;                  // basis points (resolved: per-rep override or tenant rate)
  tiers?: { thresholdCents: number; rate: number }[];
  priorPeriodTotalCents: number; // rep's basis already booked this period (tiered only)
}): { amountCents: number; appliedRate: number };
```
- `flat` → `round(basisCents × rate / 10_000)`.
- `profit` → caller passes `basisCents = paidCents − costCents` (≥ 0; if `costCents` null, caller skips). Then same `× rate` math.
- `tiered` → pick `appliedRate` from the highest `tiers[].thresholdCents` that `priorPeriodTotalCents` meets or exceeds (else base `rate`); then `× appliedRate`.
- All integer cents; round half-up. No commission row when `amountCents === 0` is **not** suppressed (a $0 commission from null cost IS suppressed earlier by the caller skipping).

### 6.2 Workflow (`packages/agents/src/functions/commission.ts`)
- **Trigger:** `invoice/paid`.
- Steps: load invoice → resolve rep = `job.assignedUserId` (skip + log if null) → resolve config (`settings.finance.commission`, apply `perRepRate[userId]` override) → compute `basisCents` (paid amount; profit subtracts `job.costCents`, skip if null) → `periodKey` from `payment.receivedAt` (or now) as `YYYY-MM` → sum the rep's existing `commission.basisCents` for that `periodKey` = `priorPeriodTotalCents` → `computeCommission(...)` → insert `commission` (idempotent on `(tenantId, invoiceId)`; on conflict, no-op) → record `agent_run`.
- **Idempotency:** the unique `(tenantId, invoiceId)` index means a re-fired `invoice/paid` never double-pays.

### 6.3 UI (`apps/web/src/app/(app)/commissions`)
- `/commissions` — read-only list: rep, invoice number, model, basis, rate, amount, period, status badge. Nav link. `force-dynamic`. No actions (approve/pay deferred).

## 7. Wave C — QuickBooks push

### 7.1 Shared Nango transport
- Extract the private `nangoProxy(connectionId, method, endpoint, body)` from `packages/integrations/src/gcal.ts` into `packages/integrations/src/nango.ts` and export it; `gcal.ts` imports it back (no behavior change). This is the only refactor in 5B and is in service of the QBO work.

### 7.2 `QboGateway` (`packages/integrations/src/qbo.ts`)
```ts
export interface QboGateway {
  upsertCustomer(o: { connectionId: string; customer: { id: string; name: string; email?: string } }): Promise<{ qboId: string }>;
  upsertInvoice(o: { connectionId: string; qboCustomerId: string; invoice: { number: string; lineItems: unknown[]; amountCents: number; dueAt: string | null } }): Promise<{ qboId: string }>;
  recordPayment(o: { connectionId: string; qboInvoiceId: string; amountCents: number; receivedAt: string }): Promise<{ qboId: string }>;
}
```
- Real impl maps Savvy entities → QBO API shapes and calls through `nangoProxy`. `makeFakeQbo()` returns deterministic ids (`qbo_cust_…`, `qbo_inv_…`, `qbo_pmt_…`) and records calls (unit/integration tests).
- Env: `NANGO_QBO_INTEGRATION_ID` (default `quickbooks`) documented in `.env.example`.

### 7.3 Connect UI + onboarding
- Settings → QuickBooks page: Connect button + status (`tenant.qboConnectionId` present?).
- Nango connect start/callback (mirrors the gcal connect flow): on success store `qboConnectionId` on `tenant` (adminDb — `tenant` is the RLS root, per 5A's tenant-write rule).

### 7.4 Sync workflows (`packages/agents/src/functions/qbo-sync.ts`)
Durable Inngest fns, retried, idempotent via stored `qboId`s. Each first checks `tenant.qboConnectionId`; if null → log + exit (never throws into the event pipeline).
- **On `invoice/sent`:** ensure `customer.qboId` (call `upsertCustomer` if null, store it) → `upsertInvoice` → store `invoice.qboId`. If `invoice.qboId` already set, skip (already pushed).
- **On `invoice/paid`:** require `invoice.qboId` (if missing, push invoice first) → `recordPayment` → store `payment.qboId` on the most recent reconciled payment lacking one. If that payment already has a `qboId`, skip.

## 8. Events (`packages/agents/src/client.ts`)
| Event | Status | Emitted when | Consumers (5B) |
|---|---|---|---|
| `invoice/sent` | exists (5A) | `sendInvoice` succeeds | dunning start, QBO invoice push |
| `invoice/paid` | exists (5A) | invoice fully reconciled | commission calc, QBO payment push, dunning stop |
| `invoice/void` | **new** | `voidInvoice` succeeds | dunning stop (`cancelOn`) |

- 5A's `voidInvoice` lifecycle fn flips status to `void` but emits nothing; 5B adds the `invoice/void` emit at its call site so dunning can cancel. (Single-line addition; the `cancelOn` consumer is the only reader.)

## 9. Error handling
- **Dunning:** a failed email/SMS send is retried by Inngest; if a step ultimately fails, the run logs and continues to the next step (a missed reminder must not strand the whole sequence). Missing customer email/phone → that channel's step suppresses (logs), others proceed.
- **Commissions:** rep null / cost null (profit) / tenant has no commission config → skip with a logged reason, never throw. Unique-index conflict → treat as already-computed.
- **QBO:** not connected → no-op. Nango/QBO API error → Inngest retry; after retries exhausted, log to `agent_run` with error and leave `qboId` unset so a later manual/automatic resync can retry. Never block the dunning or commission workflows (separate functions on the same event).

## 10. Testing
- **Unit (`@savvy/core`):** `computeCommission` across all three models incl. edge cases (null-cost skip handled by caller, tier boundaries, per-rep override, rounding); `isWithinQuietHours` across tz + window boundaries.
- **Integration (`@savvy/db` / `@savvy/agents` with fakes):** dunning stops on `invoice/paid` and `invoice/void`; commission idempotency on double `invoice/paid`; QBO mapping + idempotency via `makeFakeQbo` (customer upsert-once, invoice push-once, payment push-once).
- **RLS:** isolation test extended to cover the new `commission` table.
- **e2e (Playwright):** dunning happy-path — invoice sent → (simulated time) reminder logged → mark paid → sequence cancels; commissions list renders for a paid invoice.
- **Static gate:** `pnpm typecheck && pnpm lint && pnpm test` green before commit.

## 11. Definition of done (per repo CLAUDE.md)
- [ ] `commission` table + all new columns have RLS / `tenantIsolation()`; isolation test green.
- [ ] All multi-step logic is durable Inngest workflows with idempotency keys (commission unique index; QBO stored `qboId`s; dunning `cancelOn` + status backstop).
- [ ] No hard-coded provider/model strings (no AI in 5B); SMS/email/QBO via integration wrappers.
- [ ] Unit + integration + e2e tests written and passing; typecheck + lint clean.
- [ ] `.env.example` updated (`NANGO_QBO_INTEGRATION_ID`); no secrets committed.
- [ ] One reviewed PR with a clear summary; internal waves A/B/C visible in commit history.

## 12. Tracked follow-ups (deferred, not blockers)
- Commission **approval → paid** workflow + UI actions.
- Customer-level **timezone** capture for TCPA quiet-hours (5B uses tenant tz).
- **Two-way** QBO sync (pull changes back).
- Tenant-configurable dunning **cadence** in the settings UI (5B reads cadence defaults from code; only `smsEscalationDay` + quiet-hours are settings-driven).
- **Twilio webhook signature validation** (carried over from 5A follow-ups; relevant now that dunning sends real SMS).
- `commission/created` event if/when a downstream consumer (e.g. a payout dashboard) needs it.
