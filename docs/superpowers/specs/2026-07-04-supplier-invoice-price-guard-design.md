# Cell 13 — Supplier Invoice Ingestion + Price-Guard (with Cell 14 true-GM riding in)

**Status:** Design approved 2026-07-04. Ready for implementation planning.
**Contract:** `docs/superpowers/specs/first-20-cells.md` cells 13 (supplier invoice ingestion + price-guard, #336) and 14 (job costing actuals → true GM).

## 1. Goal & payoff

Today `job.costCents` is an *estimate* — the sum of `material_order.costSubtotalCents`, which is derived from the price book's static `unitCostCents` snapshotted at estimate acceptance (see `packages/db/src/lifecycle/material-order.ts:39-48`, `:66-70`). Every downstream money number (gross margin, profit-model commissions, the `GM·MTD` KPI on the Money screen) is therefore *assumed*, not *true*.

This feature makes it real: supplier invoices arrive automatically, are AI-parsed into line-level actuals, feed `job.costCents`, and are checked line-by-line against what we expected to pay — overages become auto-sent credit requests to the supplier, and recovered dollars surface in the digest.

**Done when (from the contract):**
- Cell 13: 100% of parsed lines checked; first credit request sent + tracked; recovered $ appears in the digest.
- Cell 14 (the part riding in here): GM per job computed from actuals; `GM·MTD` stops rendering `—` on the Money screen.

## 2. Scope & decomposition

This spec covers **Cell 13**. **Cell 14's true-GM falls out of it for free** — job costing flows through the single `job.costCents` field, and profit-model commissions already read it (`packages/db/src/lifecycle/commission.ts:41-46`), so once parsed actuals feed that field, GM and commissions become true with no extra wiring. Cell 14's genuinely-new remainder — **labor/sub costs per job + an estimate-vs-actual variance report** — is **explicitly deferred to a small follow-on spec**.

Three PRs, worktree per slice (same rhythm as cell 5):

| Slice | Delivers | Advances "done when" |
|-------|----------|----------------------|
| **13a — Ingestion pipe** | `supplier_invoice` + `credit_request` schema; `document.kind='supplier_invoice'`; per-tenant forwarding address → inbound webhook → PDF in R2 → emit `supplier-invoice/received`. No AI. | Invoices arrive automatically + stored, tenant-scoped |
| **13b — Parse → real costing** | Inngest `parseSupplierInvoice` (gateway `reasoning`) → parsed lines → **actuals replace the price-book estimate in `job.costCents`**; Money `GM·MTD` wired to real GM. | Job costing becomes real; `GM·MTD` stops rendering `—` |
| **13c — Price-guard + auto-credit** | Match lines vs material-order snapshot → overage detection → confidence-gated auto-send credit request + auto-recovery via credit memos → `finance.price_guard` invariant + digest. | 100% of lines checked; first credit request sent + tracked; recovered $ in digest |

## 3. Data model

Two new tables + one enum value, all with `tenantId` + RLS `tenantIsolation()` per the non-negotiable. Migrations via `pnpm db:generate` (never hand-numbered).

### `supplier_invoice`
One row per received supplier bill.

| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid PK | |
| `tenantId` | uuid NOT NULL FK→tenant | RLS |
| `jobId` | uuid FK→job, **nullable** | matched during parse; null → "unmatched supplier invoice" exception |
| `documentId` | uuid FK→document | the stored PDF (kind=supplier_invoice) |
| `supplierName` | text | parsed |
| `invoiceNumber` | text | supplier's invoice # |
| `invoiceDate` | timestamptz, nullable | parsed |
| `totalCents` | integer, nullable | parsed invoice total (negative for credit memos) |
| `lines` | jsonb `SupplierInvoiceLine[]` | parsed + guard-annotated (matches `material_order.lineItems` precedent) |
| `status` | enum | `received → parsing → parsed → guarded` / `parse_failed` |
| `parseConfidence` | real, nullable | 0–1 overall parse confidence |
| `externalMessageId` | text | inbound email Message-Id, idempotency |
| `createdAt` / `updatedAt` | timestamptz | |

Indexes: unique `(tenantId, externalMessageId)` (idempotent re-forwards, `onConflictDoNothing`); `(tenantId, jobId)`.

`SupplierInvoiceLine` (jsonb, in `@savvy/core`): `{ description, sku?, quantity, unit?, unitBilledCents, amountBilledCents, matchedItemKey?, expectedUnitCostCents?, overageCents?, matchConfidence? }`. Parse writes the first six fields; the guard step writes the last four.

### `credit_request`
The recovery ledger — the "found money" the digest reports.

| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid PK | |
| `tenantId` | uuid NOT NULL FK | RLS |
| `supplierInvoiceId` | uuid FK→supplier_invoice | |
| `jobId` | uuid FK→job, nullable | |
| `supplierName` | text | |
| `claimedCents` | integer | total overage claimed |
| `status` | enum | `drafted → sent → credited` / `rejected` |
| `evidence` | jsonb | the overage lines (expected vs billed, delta) |
| `sentAt` / `resolvedAt` | timestamptz, nullable | |
| `recoveredCents` | integer, default 0 | set when a credit memo matches |
| `emailMessageId` | text, nullable | the sent credit-request email id |
| `createdAt` / `updatedAt` | timestamptz | |

Recovered-$ in digest = `sum(recoveredCents) where status=credited` this period.

### `document.kind`
Add `'supplier_invoice'` to the existing kind enum (`packages/db/src/schema/ops.ts`).

### enums (`packages/core/src/enums.ts` + registered in `packages/db/src/schema/enums.ts`)
- `SUPPLIER_INVOICE_STATUS = ["received","parsing","parsed","guarded","parse_failed"]`
- `CREDIT_REQUEST_STATUS = ["drafted","sent","credited","rejected"]`

## 4. Ingestion pipeline (slice 13a)

- **Per-tenant forwarding address:** `inv-<opaque-token>@inbox.getsavvy.com`. The token is generated per tenant and stored in `tenant.settings.supplierInbox = { token }` (not guessable; rotatable). A small settings UI surfaces the address (read-only, copyable) so the tenant configures supplier/office auto-forwarding.
- **Provider:** Cloudflare Email Routing → tiny Worker → HTTP POST to our webhook (free; cost-discipline). **The webhook contract is provider-agnostic** — swapping to Resend Inbound later is config, not code.
- **Webhook** `POST /api/inbound/supplier-invoice`:
  1. Verify a shared secret header (`x-inbound-secret`, env `INBOUND_EMAIL_SECRET`) — mirrors existing webhook auth.
  2. Resolve tenant from the `to` token (`inv-<token>@…` → tenant via `tenant.settings.supplierInbox.token`). Unknown token → 404, no leak.
  3. For each PDF attachment: `r2Storage.presignUpload`/put → insert `document(kind=supplier_invoice, r2Key, filename, mime, sizeBytes, source='inbound_email')` → insert `supplier_invoice(status=received, externalMessageId=<Message-Id>, supplierName=<from-domain guess>)` with `onConflictDoNothing` on `(tenantId, externalMessageId)`.
  4. `inngest.send({ name: "supplier-invoice/received", data: { tenantId, supplierInvoiceId, documentId } })`.
- Mirrors `apps/web/src/app/api/sitesnap/photos/route.ts` (webhook → document → event) exactly. Non-PDF attachments ignored; emails with no PDF logged + dropped.

## 5. Parse → real costing (slice 13b)

Inngest `parseSupplierInvoice` on `supplier-invoice/received`. `concurrency: { limit: 5, key: "event.data.tenantId" }`, `retries: 2`, **fail-soft** (any parse error → `status=parse_failed` + a `supplier_invoice_unparsed` exception; never throws). Handler extracted as `parseSupplierInvoiceHandler` for unit tests; AI client injected (photo-qc pattern).

Steps:
1. **fetch** — bytes from R2 via `r2Storage.presignDownload`.
2. **parse** — gateway `completeObject` (capability **`reasoning`**; `classifyImage` when the PDF is image-only) into Zod `{ supplierName, invoiceNumber, invoiceDate, totalCents, lines:[…], confidence }`.
3. **match-job** — PO/job ref in the invoice text → else supplier + open material orders + property address. Sets `jobId`; null → `supplier_invoice_unmatched` exception (surfaces in Today).
4. **persist** — write parsed lines + confidence, `status=parsed`. Emit `supplier-invoice/parsed`.
5. **attach-actuals** — new `recomputeJobActualCost(tenantId, jobId)`: `job.costCents = sum(supplier_invoice.totalCents for jobId where status in (parsed,guarded) and totalCents > 0)` **when any actuals exist, else fall back to the estimated material-order cost** (existing `recomputeJobMaterialCost`). `computeJobMargin` already reads `job.costCents` → GM turns real automatically.

**Money `GM·MTD` (closing the cell-5 loop):** replace the hardcoded `null` in `getMoneyKpis` (`apps/web/src/lib/money-queries.ts`) with a real query — `GM·MTD = sum(revenue − cost) / sum(revenue)` across jobs invoiced this month using `job.costCents`, computed via `computeJobMargin`. Renders a real % once actuals exist for the period, `—` otherwise (graceful).

## 6. Price-guard + auto-credit (slice 13c)

Inngest `priceGuardSupplierInvoice` on `supplier-invoice/parsed`. Fail-soft, tenant concurrency key.

1. **Match & compare** — each parsed line → the job's `material_order.lineItems[]` snapshot line by `key`/`sku` (AI-assisted fallback match via `reasoning` when no deterministic key). `expectedUnitCostCents` from the snapshot (falls back to `price_book_item.unitCostCents`). `overageCents = max(0, unitBilledCents − expectedUnitCostCents) × quantity`. Unmatched lines are **actuals-only**, flagged `matchedItemKey=null` (counted as "checked: no baseline", not an overage). Write the guard fields back into `supplier_invoice.lines`; `status=guarded`.
2. **Threshold** — a line is an overage when it clears `max($25, 5% of expected)` (tenant-configurable in the finance config). Sum qualifying overages per invoice → `claimedCents`.
3. **Auto-send, confidence-gated:** if `claimedCents ≥ threshold` **AND** `parseConfidence ≥ HIGH (e.g. 0.8)` **AND** all overage lines matched cleanly → create `credit_request(status=sent)`, email the supplier a professional, evidence-based credit request (job/PO, expected vs billed, per-line delta, total), record `emailMessageId` + an `agent_run` (finance/RAINE) as proof-of-send. **Otherwise → `credit_request(status=drafted)` + a Today decision card** ("Review & send credit request — $X, <supplier>") for one-tap send. Never unattended-email a shaky parse.
4. **Recovery — automatic loop:** a credit memo is a negative-`totalCents` supplier invoice arriving on the *same* inbox → parsed by the same pipe → matched to an open `credit_request` by `supplierName` + invoice ref → `status=credited`, `recoveredCents` set, `resolvedAt` stamped. No manual step. (If no auto-match, a Today card offers manual reconcile.)
5. **Proof + digest:**
   - New `finance.price_guard` evidence check (an `invariant`): every `supplier_invoice.lines` entry for a job that has a material order carries a guard verdict (matched-and-compared OR explicitly no-baseline). Registered in `packages/core/src/verification/checks.ts`, bound to a registry task, surfaces on the Money proof panel — proving "100% of lines checked".
   - Recovered-$ (credited this period) + pending-recovery ($ sent, awaiting credit) surface in the ops digest via the dollar-impact channel (model as a `TaskException` carrying `dollarImpactCents`, per `packages/core/src/digest.ts` break-glass hook).

## 7. Surfacing

- **Money screen:** `GM·MTD` real; `finance.price_guard` row in the proof panel.
- **Today:** low-confidence credit drafts + large overages + unmatched invoices as decision cards.
- **Digest:** recovered / pending recovery dollars.
- **Job detail:** a "Supplier invoices" panel — parsed invoices, per-line guard results (expected vs billed, overage), and credit-request status.

## 8. Testing

- **Pure core (TDD, `@savvy/core`):** `matchInvoiceLines(parsedLines, snapshotLines)`, `computeLineOverage(line, expected, threshold)`, `shouldAutoSendCredit({ claimedCents, parseConfidence, allMatched })` (the confidence gate), `selectJobCost({ actualsCents, estimateCents })` (actual-vs-estimate selection), and the `finance.price_guard` invariant SQL contract.
- **Inngest handlers:** `parseSupplierInvoiceHandler` + `priceGuardHandler` unit-tested with an injected stub AI client (photo-qc pattern) — no Inngest runtime.
- **E2E (Playwright, AI-stubbed):** webhook lands invoice → `document`; parse → real `job.costCents` + `GM·MTD` shows a %; overage → `credit_request` + (gated) email; credit-memo → auto-`credited` + recovered-$ in digest; `finance.price_guard` renders on the proof panel.
- **RLS:** cross-tenant read-returns-nothing tests on `supplier_invoice` + `credit_request` (keep the isolation suite green).
- typecheck + lint clean; `gh pr checks <n> --watch` before each squash-merge.

## 9. Non-negotiables checklist (per CLAUDE.md)

- [x] `tenantId` + RLS on both new tables; cross-tenant tests.
- [x] AI parsing via the **gateway by capability** (`reasoning`), never a hard-coded model.
- [x] Ingestion + parse + guard are **durable Inngest workflows** with retries + idempotency (`onConflictDoNothing`, unique keys), not fire-and-forget.
- [x] No secrets in repo — `INBOUND_EMAIL_SECRET`, inbox domain via env; document in `.env.example`.
- [x] Integrate the commodity (inbound email via Cloudflare Email Routing / provider-agnostic webhook) — build only the orchestration + data model + Savvy logic.
- [x] Every slice ships with tests; small reviewed PRs.

## 10. Open questions / deferred

- **Deferred to cell-14 follow-on spec:** labor + subcontractor costs per job; the estimate-vs-actual variance report.
- **Line-matching accuracy** across supplier SKU dialects (ABC vs SRS vs Beacon) will need iteration — the AI-assisted fallback + confidence gate contain the risk (low-confidence → human card, never a wrong auto-email).
- **Credit-memo auto-match** heuristic (supplier + ref) may miss some formats → manual-reconcile Today card is the backstop.
