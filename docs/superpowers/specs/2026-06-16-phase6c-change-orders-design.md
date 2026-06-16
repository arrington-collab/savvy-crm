# Phase 6C — Change Orders (Design Spec)

**Date:** 2026-06-16
**Parent:** Phase 6 (Production & close-out), delivered as sequenced slices — 6A (production spine) ✅, 6B (closeout e-sign) ✅, **6C (this spec): change orders**, then 6D (CompanyCam + crew check-in). Roadmap Phase 6 done-when: "a job goes approved → produced → closed with documents attached." Lifecycle task #118: "Change order processing — captures scope changes, reprices, gets homeowner approval."

## 1. Summary

During production, a rep captures a scope change as a **change order**: a priced delta of line items on the job, with a reason. The homeowner **signs it via DocuSeal** (reusing the unified gateway from 6B). On signature, a durable workflow marks the change order **approved**, **bumps the job's contract value (`job.valueFinal`) by the delta**, and **generates a supplemental invoice** for the delta (reusing the 5A invoice/Stripe money path).

This is structurally the estimate-signing flow (Phase 7) applied to a mid-production delta: send → DocuSeal submission → webhook → durable consumer. It reuses the price book (Phase 7) for line-item pricing, the unified DocuSeal gateway + webhook (6B/7), and the invoice lifecycle (5A).

```
create change order (line items from price book / manual, + reason; status "draft")
  → send for signature  (httpDocuseal.createClosoutSubmission, status "sent")
  → homeowner signs → POST /api/docuseal/webhook (verify + parse once, route by submission id)
  → emit change_order/accepted {changeOrderId, tenantId}
  → Inngest changeOrderAccepted (idempotent):
        status → approved · job.valueFinal += total · supplemental invoice (when total > 0)
```

## 2. Scope decisions (locked during brainstorming)

| Decision | Choice |
|---|---|
| Money effect on approval | **Adjust `job.valueFinal` by the delta AND generate a supplemental invoice** for the delta |
| Approval mechanism | **DocuSeal e-sign** — homeowner signs the change order; webhook drives approval (reuses 6B's unified gateway/route) |
| Line items | **Price book + manual**, mirroring the Phase 7 estimate editor |
| ± deltas | `total` is whatever the line items sum to (can be negative = credit). `valueFinal` always adjusts by `total`; a supplemental **invoice is created only when `total > 0`** (credits adjust value but aren't auto-invoiced) |
| Stage gating | **None** — change orders are additive; the job stays in its current stage (consistent with 6B) |

### Out of scope (deferred)
- **AI scope-drafting** (task #118's "Finance Agent" Partial-Auto: describe a scope change → AI drafts line items from the price book). Deferred to keep the slice tight; the rep builds line items. Tracked follow-up.
- **Credit/negative-delta invoicing** (Stripe credit notes / refunds) — a negative `total` adjusts `valueFinal` only.
- **Commission recompute** on the supplemental invoice beyond the existing `commissionOnPaid` flow (which already fires when any invoice is paid).
- **Change-order reminders / auto-nudge** for unsigned orders.
- **Editing an already-sent change order** — once sent, it's immutable (void + create a new one).

## 3. Architecture approach

Reuse established patterns end-to-end:
- **Signing** reuses the unified `httpDocuseal` gateway (`createClosoutSubmission` — generic template + prefilled fields + metadata) and the single `/api/docuseal/webhook` route, which already verifies the HMAC once and routes by submission id. 6C adds one more branch to that route.
- **Durable approval** is an Inngest function (`changeOrderAccepted`) on a new `change_order/accepted` event — same webhook→event→durable-consumer shape as `estimate/accepted` → `estimateAcceptedAdvanceJob`.
- **Pricing** is pure logic in `@savvy/core` (`computeChangeOrderTotal`) reusing the price book; line-item shape mirrors the estimate's.
- **Invoicing** reuses the 5A `@savvy/db` invoice lifecycle (`createInvoice`) — no new payment plumbing.
- **UI** mirrors Phase 7's `EstimateEditor` (price-book line-item picker + manual lines).

## 4. Data model changes (migration `0010`)

### 4.1 New table `change_order` (`packages/db/src/schema/finance.ts`, next to `estimate`)
| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | |
| `tenantId` | uuid → tenant | RLS scope |
| `jobId` | uuid → job (notNull) | |
| `customerId` | uuid → customer (notNull) | signer + invoice target |
| `reason` | text | why the scope changed |
| `status` | text notNull default `"draft"` | `draft` \| `sent` \| `approved` \| `declined` \| `voided` |
| `lineItems` | jsonb default `[]` | price-book + manual lines (same shape as estimate) |
| `subtotal` | integer (cents, nullable) | |
| `total` | integer (cents, nullable) | the delta (can be ±) |
| `docusealSubmissionId` | text (nullable) | DocuSeal submission id |
| `signingUrl` | text (nullable) | captured at send; rep can copy/resend |
| `invoiceId` | uuid → invoice (nullable) | set on approval when a supplemental invoice is created (only when `total > 0`) |
| `applied` | boolean notNull default `false` | money mutation done (valueFinal bumped, invoice created if any). Guards the durable consumer's idempotency for credit/zero deltas where `invoiceId` stays null |
| `sentAt` | timestamptz (nullable) | |
| `approvedAt` | timestamptz (nullable) | set when the webhook flips status → approved |
| `createdAt` | timestamptz default now | |

- **RLS:** `tenantIsolation()`; add a case to `packages/db/tests/isolation.test.ts`.
- **Index:** `(tenantId, jobId)` for the per-job list.
- **Unique:** `(tenantId, docusealSubmissionId)` — webhook idempotency (mirrors `estimate`/`esign_request`).

### 4.2 No other schema changes
`job.valueFinal` (integer cents) already exists (5B). The supplemental invoice uses the existing `invoice` table unchanged.

## 5. Core pricing (`packages/core/src/change-order.ts`)

Change-order line items **reuse the existing `EstimateLineItem` type** from `@savvy/core` (`{ key, name, category, unit, quantity, unitPriceCents, amountCents }`) so the change-order editor can reuse the Phase 7 estimate editor's line shape + price-book picker (DRY). The pure total helper:
```ts
export function computeChangeOrderTotal(lines: { amountCents: number }[]): { subtotal: number; total: number };
```
- Sums `amountCents` across lines (each line's `amountCents = quantity * unitPriceCents` is maintained by the editor, same as estimates). `subtotal === total` for 6C — no separate tax line on a change order; the delta is the figure that adjusts the contract and is invoiced. (Distinct from `computeEstimateTotals`, which adds tax.)
- A zod schema validates a line (`description` non-empty, `qty`/`unitPriceCents` integers) at the action edge.

## 6. DB lifecycle (`packages/db/src/lifecycle/change-order.ts`)

1. **`createChangeOrder({ tenantId, jobId, reason, lineItems })`** — tenant-scoped insert (status `draft`); computes subtotal/total; returns the row.
2. **`sendChangeOrder({ tenantId, changeOrderId, docusealSubmissionId, signingUrl })`** — sets status `sent`, `sentAt`, the submission id + url. (The DocuSeal HTTP call happens in the server action, outside the tx; this just records the result.)
3. **`markChangeOrderBySubmission({ submissionId })`** — webhook-side (mirrors `markEsignBySubmission` from 6B): `adminDb` lookup by the globally-unique `docusealSubmissionId` (no session); if the row exists and isn't terminal, flip `status → approved` + `approvedAt = now` inside `withTenant` (the lightweight status write, so the UI reflects approval immediately even before the money work runs). Returns `{ tenantId, changeOrderId, changed }`; a row already `approved`/`declined`/`voided` returns `changed:false`; unknown → `null`.
4. **`approveChangeOrder({ tenantId, changeOrderId })`** — the durable MONEY mutation (called by the Inngest fn; status is already `approved` from step 3). Inside one `withTenant` tx: re-read the change order; **idempotency — if `applied` is `true`, no-op and return**; otherwise bump `job.valueFinal = coalesce(valueFinal, valueEstimate, 0) + total`, and **when `total > 0`** insert a **draft** supplemental invoice directly (`tx.insert(invoice)` with `amountDue = total`, `lineItems` = the change order's, `customerId`, `jobId`, `status: "draft"` — mirroring `createInvoiceFromEstimate`) and store its id on `change_order.invoiceId`; finally set `change_order.applied = true`. All in the one tx, so a replay sees `applied = true` and does nothing (no double value-bump, no second invoice). Returns `{ invoiceCreated: boolean }`.

## 7. Webhook (third branch in `/api/docuseal/webhook`)

The unified route already: `verifyWebhook` (401 on bad sig) → `parseEvent` → on `completed`, look up `estimate` by submissionId (→ `estimate/accepted`), else `esign_request` (→ `esign/completed`). **6C adds a third lookup**: if neither matched, look up `change_order` by `docusealSubmissionId`; on a found, not-yet-terminal row, call `markChangeOrderBySubmission` and emit `change_order/accepted { changeOrderId, tenantId }` when `changed`. Unknown across all three → 200 no-op. Three sequential indexed lookups by submission id is acceptable; a single instance posts all events to one URL.

## 8. Durable consumer (`packages/agents/src/functions/change-order.ts`)

`changeOrderAccepted` Inngest fn on `change_order/accepted`:
1. Load the change order (tenant-scoped via the event's `tenantId`).
2. **Idempotency:** if `applied` is already `true`, skip.
3. Call `approveChangeOrder(...)` — guarded on `applied`: adjusts `job.valueFinal += total`, and when `total > 0` inserts a **draft** supplemental invoice directly (`amountDue = total`, `lineItems` = the change order's, `customerId`, `jobId` — mirroring `createInvoiceFromEstimate`, NOT `createInvoice` whose line-item summing expects a different `{qty, unitAmountCents}` shape), linking `invoiceId`; sets `applied = true` — all in one tx.
4. Write an `agent_run` (`finance`, `ok`). The supplemental invoice is left **draft**; the rep sends it via the existing `/invoices` flow (Stripe checkout + dunning), exactly as an accepted estimate's invoice is created draft. Auto-sending it is a tracked follow-up. Re-hydrate any Date crossing a `step.run` boundary with `new Date(x)`.

## 9. Send action (`apps/web/src/lib/change-order-actions.ts`)

- **`createChangeOrderAction({ jobId, reason, lineItems })`** → tenant-scoped; validates lines; `createChangeOrder`; `revalidatePath`.
- **`sendChangeOrderForSignature({ changeOrderId })`** → load the change order + job + customer (tenant-scoped, require `customer.email`); build prefill fields (customer, property, change-order total, reason); call `docuseal().createClosoutSubmission({ templateId: <change-order template>, signer, fields, metadata: { tenantId, jobId, docType: "change_order" } })` **outside** the tx (fake-when-unconfigured, same `defaultDocuseal()` pattern as 6B/7); `sendChangeOrder(...)`; return the signing URL. Template id from env `DOCUSEAL_TEMPLATE_CHANGE_ORDER` (documented in `.env.example`); no template → `no_template` result.

## 10. UI (`apps/web/src/app/(app)/jobs/[id]`)

- A **"Change orders" section/tab** on the job detail page: a list of change orders with status badge, total, reason, copy-signing-link (while `sent`), and a link to the supplemental invoice (once `approved`).
- A **change-order editor** mirroring `EstimateEditor.tsx`: price-book line-item picker (auto-priced) + manual lines + a reason field; shows the running total; "Save" then "Send for signature".
- Toasts distinguish `no_customer_email` / `no_template` / `docuseal_failed` (same union style as 6B's `EsignPanel`).

## 11. Error handling
- **Webhook:** bad/missing signature → 401 (no DB touch); unknown submission across estimate/esign_request/change_order → 200 + no-op; idempotent via `markChangeOrderBySubmission` (`changed:false` on terminal) + the unique index.
- **Send action:** job not tenant's → typed error; missing `customer.email` → `no_customer_email`; no template → `no_template`; DocuSeal unreachable → `docuseal_failed` (with `defaultDocuseal()` fake fallback, dev/e2e never hit the network).
- **`changeOrderAccepted`:** retried by Inngest; idempotent via `invoiceId`-set / `approved` check — no double value-bump or double invoice.
- **Decline/void:** recorded as status; no value change, no invoice.

## 12. Testing
- **Unit (`@savvy/core`):** `computeChangeOrderTotal` (sums, empty, negative line/credit).
- **DB integration (`@savvy/db`):** `createChangeOrder`; `markChangeOrderBySubmission` flips sent→approved-intent + idempotent on replay; `approveChangeOrder` bumps `valueFinal` by `total`, creates one supplemental invoice when `total>0`, creates **no** invoice when `total<=0`, and is idempotent (second call: no second invoice, no double bump).
- **RLS:** extend `packages/db/tests/isolation.test.ts` to cover `change_order`.
- **Agents:** `changeOrderAccepted` end-to-end with fakes against a real DB — approves once, links invoice, idempotent on replay.
- **e2e (Playwright):** on a job, create a change order (price-book line) → send → simulate the `form.completed` webhook → assert status `approved` and the supplemental invoice appears. Reuses the fake-gateway harness from 6B (no stub); `DOCUSEAL_TEMPLATE_CHANGE_ORDER` set in `playwright.config` so `no_template` doesn't short-circuit. `getByRole("button", { name })` for tab triggers.
- **Static gate:** `pnpm typecheck && pnpm lint && pnpm test` green.

## 13. Definition of done (per repo CLAUDE.md)
- [ ] `change_order` table + migration `0010`; RLS isolation test; unique `(tenantId, docusealSubmissionId)`.
- [ ] DocuSeal signing reuses the unified `httpDocuseal` gateway + the single webhook route (third branch); no new gateway, no second webhook URL.
- [ ] Send action tenant-scoped, requires `customer.email`, resolves the change-order template, DocuSeal call outside the `withTenant` tx, fake-when-unconfigured.
- [ ] On approval (durable + idempotent): `job.valueFinal += total` AND a supplemental invoice when `total > 0`, linked via `change_order.invoiceId`.
- [ ] `DOCUSEAL_TEMPLATE_CHANGE_ORDER` documented in `.env.example`; no secrets committed.
- [ ] Unit + DB + agents + RLS + e2e tests pass; typecheck + lint clean.
- [ ] One reviewed PR (base **main**, `gh pr create --base main`).

## 14. Tracked follow-ups (deferred)
- **Auto-send the supplemental invoice** on approval (Stripe checkout + dunning) — 6C creates it as a draft, mirroring accepted-estimate invoices; the rep sends it via `/invoices`.
- **AI scope-drafting** (Finance Agent: describe scope change → draft line items from the price book).
- **Credit/negative-delta invoicing** (Stripe credit notes) for `total < 0`.
- **Change-order reminders** for unsigned orders.
- **Per-tenant change-order template config UI** (6C reads the template id from env; admin/seed for now).
- **Confirm the DocuSeal change-order template field names** and wire real prefill names (best-effort/sandbox-validated, like the rest of the DocuSeal integration).
