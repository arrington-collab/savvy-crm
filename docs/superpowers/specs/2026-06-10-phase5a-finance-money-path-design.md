# Phase 5A — Finance Money Path (Design Spec)

**Date:** 2026-06-10
**Status:** Approved for planning
**Parent:** Phase 5 (Finance agent) is delivered as two sequenced slices — **5A (this spec): the money path**, then **5B: dunning + commissions + QBO push**. Roadmap Phase 5 goal: invoicing, Stripe payments (card + ACH), AR/dunning, QuickBooks, commission calc. Done when: invoice → payment → reconciled; overdue dunning runs automatically.

**5A Done gate:** A tenant can connect their Stripe account, create/send an invoice (direct or from an accepted estimate), the customer pays via Stripe Checkout (card or ACH) on the tenant's connected account, and the payment is reconciled back — invoice flips to `paid` with a `payment` row — durably and idempotently. Tenant-scoped; RLS enforced.

## 1. Summary

5A builds the core money-movement vertical slice. Savvy is the **source of truth** for invoices; Stripe (via **Connect Standard** accounts) collects card + ACH on each tenant's own account; a signature-verified, idempotent webhook reconciles payments back into Savvy. Automation that hangs off this (dunning, commissions, QBO push) is **5B** and is intentionally out of scope here — 5A only emits the `invoice/sent` and `invoice/paid` events those workflows will consume.

The defensible work is the invoice data model + orchestration + reconciliation, not the payment rail (a commodity, integrated via Stripe).

## 2. Scope decisions (locked during brainstorming)

| Dimension | Decision |
|---|---|
| Invoice ownership | **Savvy owns the invoice** (record, line items, status, amounts). Stripe is collection-only. |
| Payment rail | **Stripe Checkout / Payment Links** on the tenant's connected account; `card` + `us_bank_account` (ACH). |
| Multi-tenancy | **Stripe Connect — Standard accounts.** Tenant links an existing Stripe account via Stripe's OAuth; `stripeAccountId` (`acct_...`) stored on `tenant`. Funds settle to the tenant. |
| Reconciliation | Signature-verified **Connect webhook** → idempotent `payment` insert → invoice status transition. |
| Estimate→invoice | **In scope:** `createInvoiceFromEstimate` copies an accepted estimate's line items + total into a new invoice. |
| Out of scope (→ 5B) | Dunning workflow, commission calc, QBO push. 5A emits `invoice/sent` + `invoice/paid` for them. |

### Deferred (tracked follow-ups, not 5A)
- Dunning / commissions / QBO push (all 5B).
- TCPA quiet-hours / consent (relevant once dunning sends — 5B).
- Stripe Connect **Express** onboarding (we use Standard/OAuth per the scope decision).
- Multi-currency (USD-only; cents).
- Partial-payment UX beyond status staying `sent` until fully paid.
- Refunds / disputes handling.

## 3. Architecture approach

- Savvy owns the invoice; **pure helpers** in `@savvy/core` (`computeInvoiceTotal`, invoice-number formatting) are unit-tested with no I/O (mirrors Phase 3/4 `renderTemplate`/`computeOpenSlots`).
- **Transactional lifecycle helpers** in `@savvy/db` (`createInvoice`, `createInvoiceFromEstimate`, `sendInvoice`, `voidInvoice`, `recordStripePayment`) run inside `withTenant` (RLS-scoped).
- **Stripe** via the official SDK, wrapped behind a thin `StripeGateway` interface in `@savvy/integrations` (+ `makeFakeStripe` for tests) — same shape as the `CalendarSync`/`makeFakeCalendarSync` wrapper.
- **Connect OAuth** uses Stripe's own OAuth (not Nango); the `state` param is an HMAC token (`signPayloadToken`) carrying `{tenantId}`.
- **Reconciliation** is webhook-driven; idempotency is a DB invariant (unique index on `payment.stripePaymentId`) — the hybrid app-logic + DB-constraint pattern from Phase 4.
- Money is **integer cents** end-to-end; dollars only at the display edge.

## 4. Data model changes (migration `0004`)

### 4.1 `tenant`
- Add `stripeAccountId text` (nullable). Null → tenant hasn't linked Stripe → cannot send/collect.

### 4.2 `invoice` (table exists in `schema/finance.ts`)
- Convert `status text` → **`invoiceStatusEnum`** (`draft | sent | paid | overdue | void`).
- Add `stripeCheckoutSessionId text`, `stripePaymentIntentId text`. (Keep existing `stripeInvoiceId`/`qboId` columns for the 5B QBO story; 5A populates the Checkout/PI columns.)
- `customerId uuid references customer(id)` — add (so we can show/contact the payer without joining through job; invoice currently only has `jobId`). Nullable, set from the job's customer at creation.
- Keep `amountDue`/`amountPaid` integer **cents**; `amountPaid` default 0.
- `number` assigned on **send** (per-tenant sequential, formatted `INV-000123`). Add a **partial unique index on `(tenant_id, number)` `WHERE number IS NOT NULL`** (backstops the sequence; drafts have null numbers).

### 4.3 `payment` (table exists)
- Convert `method text` → **`paymentMethodEnum`** (`card | ach | check | insurance | mortgage`).
- Add **unique index on `(tenant_id, stripe_payment_id)`** (idempotent reconciliation; partial — `WHERE stripe_payment_id IS NOT NULL`).

### 4.4 `estimate`
- No structural change in 5A. `createInvoiceFromEstimate` reads its `lineItems`/`total` and flips its `status` to `accepted`. (If `status` is still `text`, leave as text in 5A; enum conversion optional/deferred.)

### 4.5 Enums
- `@savvy/core`: `INVOICE_STATUS`, `PAYMENT_METHOD` const tuples + types.
- `@savvy/db`: `invoiceStatusEnum`, `paymentMethodEnum` pgEnums (same pattern as appointment enums).

### 4.6 `tenant.settings.finance` (jsonb, no new table)
Parsed by a `@savvy/core` zod schema with defaults:
```jsonc
{ "netDays": 14, "invoiceNumberPrefix": "INV-" }
```
(Dunning cadence + commission rate live here too but are added/consumed in 5B.)

## 5. Stripe integration wrapper (`packages/integrations/src/stripe.ts`)

Thin interface over the `stripe` SDK; `connectedAccountId` threads the Connect account onto each call.
```ts
export interface StripeGateway {
  oauthToken(code: string): Promise<{ stripeUserId: string }>;
  createCheckoutSession(o: {
    connectedAccountId: string; amountCents: number; currency?: string;
    invoiceId: string; tenantId: string; description: string;
    successUrl: string; cancelUrl: string; customerEmail?: string;
  }): Promise<{ id: string; url: string; paymentIntentId: string | null }>;
  constructWebhookEvent(rawBody: string, signature: string): StripeEventLite; // verifies signature
}
```
- Real impl uses `STRIPE_SECRET_KEY` (platform), `STRIPE_CONNECT_CLIENT_ID`, `STRIPE_WEBHOOK_SECRET`. Checkout created with `{ stripeAccount: connectedAccountId }`; `payment_method_types: ['card','us_bank_account']`; `metadata: { invoiceId, tenantId }`.
- `makeFakeStripe()` returns deterministic ids (`cs_fake_…`, `pi_fake_…`) + records calls (for unit/e2e).
- Env documented in `.env.example`.

## 6. Stripe Connect onboarding

- `getStripeConnection(tenantId) -> { connected, accountId? }` (read helper).
- **`GET /api/stripe/connect/start`** (Clerk-protected): resolve `getTenantId()`, build the Stripe Connect OAuth authorize URL with `client_id`, `response_type=code`, `scope=read_write`, and `state = signPayloadToken({ tenantId }, secret)`. Redirect.
- **`GET /api/stripe/connect/callback`** (Clerk-protected): verify `state` HMAC → `{tenantId}` (must match `getTenantId()`); exchange `code` via `oauthToken` → `stripeUserId`; store on `tenant.stripeAccountId` (adminDb or withTenant per the tenant-write rule — `tenant` is the RLS root, so adminDb, as in Phase 4 settings). Redirect back to settings with success.
- **Settings → Payments UI**: Connect Stripe button (→ start route) + status (`getStripeConnection`).

## 7. Invoice lifecycle (`packages/db/src/lifecycle/invoices.ts`, all `withTenant`)

- `createInvoice({ tenantId, jobId, lineItems })` → resolves `customerId` from the job; `amountDue = computeInvoiceTotal(lineItems)`; status `draft`.
- `createInvoiceFromEstimate({ tenantId, estimateId })` → copies estimate `lineItems` + `total` into a new draft invoice on the same job; sets estimate `status='accepted'`. **Always creates a new draft** (no dedupe guard — the rep controls duplicates and can void).
- `sendInvoice({ tenantId, invoiceId })` → require `tenant.stripeAccountId` (else `StripeNotConnectedError`); assign `number` via `nextInvoiceNumber` (per-tenant sequential, race-safe in-tx); set `dueAt = now + netDays`; status `sent`. Returns the invoice. Caller emits `invoice/sent`.
- `voidInvoice({ tenantId, invoiceId })` → status `void`.
- `recordStripePayment({ tenantId, invoiceId, stripePaymentId, method, amountCents })` → idempotent (unique index); insert `payment`; `amountPaid += amount`; if `amountPaid >= amountDue` → `paid`. Returns `{ alreadyRecorded, nowPaid }`. Caller emits `invoice/paid` when `nowPaid`.

Pure (`@savvy/core`): `computeInvoiceTotal(lineItems) -> cents`; `formatInvoiceNumber(prefix, seq) -> "INV-000123"`. `nextInvoiceNumber` lives in db (needs a tx/counter).

**Invoice number sequence:** per-tenant, assigned in the `sendInvoice` transaction. Mechanism (definitive): take a tenant-scoped Postgres **advisory lock** (`pg_advisory_xact_lock(hashtext(tenant_id))`) at the start of the tx, then `seq = (count of this tenant's invoices whose number IS NOT NULL) + 1`, and set `number = formatInvoiceNumber(prefix, seq)`. The advisory lock serializes concurrent sends per tenant so two invoices can't get the same number; the lock auto-releases at tx end. (A unique index on `(tenant_id, number)` is the backstop.)

## 8. Checkout (server action `createCheckoutForInvoice`)

`apps/web/src/lib/finance-actions.ts`:
- Load invoice + `tenant.stripeAccountId` (must exist → else error result).
- `stripe.createCheckoutSession({ connectedAccountId, amountCents: amountDue, invoiceId, tenantId, description: number, successUrl, cancelUrl, customerEmail })`.
- Store `stripeCheckoutSessionId` (+ `stripePaymentIntentId` if present) on the invoice.
- Return `{ url }` (the hosted Checkout URL = the pay link).

## 9. Webhook reconciliation (`POST /api/stripe/webhook`)

- Public route — add `/api/stripe/` to middleware PUBLIC. Read **raw body** (`await req.text()`); verify signature via `constructWebhookEvent(raw, sig)` → 400 on failure.
- Connect event carries `account` (the `acct_...`); session `metadata` carries `{invoiceId, tenantId}`.
- Handle:
  - `checkout.session.completed` (card) + `checkout.session.async_payment_succeeded` (ACH settles later) → success → `recordStripePayment` (method from session payment-method type) → if `nowPaid`, best-effort `inngest.send('invoice/paid')` (try/catch).
  - `checkout.session.async_payment_failed` → log; leave unpaid.
- Unknown invoice/tenant or already-recorded → log + 200 (don't force Stripe retries). Return 200 fast.
- Events emitted: `invoice/sent` (on send), `invoice/paid` (on full payment) — consumed by 5B.

## 10. Events (`packages/agents/src/client.ts`)
| Event | Emitted when | Consumers |
|---|---|---|
| `invoice/sent` | `sendInvoice` succeeds | 5B: dunning start, QBO invoice push |
| `invoice/paid` | invoice fully reconciled | 5B: commission calc, QBO payment push, dunning cancel |

(5A adds the event types + emits them; no 5A workflow consumes them yet. A no-op is fine.)

## 11. UI (`(app)` group, shadcn, `force-dynamic`)
- **`/invoices`** — list (number, customer, amountDue/Paid, status badge, dueAt), status filter; nav link.
- **`/invoices/[id]`** — detail: line items, totals, status, payments; actions **Send**, **Void**, **Open Checkout / Copy pay link**.
- **Create invoice** — line-item form on a job; **Create from estimate** action on an accepted estimate.
- **Settings → Payments** — Connect Stripe button + status.
- Money shown as dollars (`cents/100`) at the edge only.

## 12. Error handling
| Case | Behavior |
|---|---|
| Send/checkout, no `stripeAccountId` | Blocked, clear "Connect Stripe" message (not 500). |
| Webhook bad signature | 400, no state change. |
| Webhook unknown invoice/tenant | Log + 200. |
| Duplicate webhook / payment | No-op via `stripePaymentId` unique index → 200. |
| Stripe API error on checkout | Surfaced to rep; invoice stays `sent`. |
| Connect `state` invalid | Reject callback; bind nothing. |
| Post-tx `inngest.send` failure | try/catch + log (carries the Phase 3 follow-up). |

## 13. Testing
- **Unit (`@savvy/core`)**: `computeInvoiceTotal` (sums, empty, large cents), `formatInvoiceNumber`, finance-config defaults.
- **Integration (`@savvy/db`)**: `createInvoice`/`createInvoiceFromEstimate` (copies items, flips estimate), `sendInvoice` (sequential number, due date, blocks without Stripe), `recordStripePayment` (increments, flips `paid`, partial stays `sent`, idempotent via unique index), RLS isolation on new columns/enums. `makeFakeStripe` where needed.
- **e2e (Playwright)**: create → send (assert number/status) → `createCheckoutForInvoice` returns URL (Stripe **mocked**) → simulate webhook / call `recordStripePayment` → assert `payment` row + `paid` on `/invoices/[id]`. Connect + Stripe mocked; no real Stripe in CI.

## 14. Definition of done (per repo CLAUDE.md)
- [ ] Tenant connects Stripe (Connect Standard OAuth) → `stripeAccountId` stored.
- [ ] Invoice created (direct + from estimate), sent (sequential number, due date), Checkout session created on the connected account (card + ACH).
- [ ] Signature-verified webhook reconciles payment idempotently → invoice `paid` + `payment` row; `invoice/paid` emitted.
- [ ] Money in integer cents throughout; tenant-scoped; RLS verified by test.
- [ ] Workflows/reconciliation idempotent; typecheck + lint + tests green; `.env.example` updated (Stripe); small reviewed commits.

## 15. Tracked follow-ups (deferred)
- 5B: dunning workflow, commission calc, QBO one-way push.
- Stripe webhook endpoint hardening (replay window), refunds/disputes, multi-currency, partial-payment UX, Express onboarding option.
- Estimate `status` enum conversion (left text in 5A).
