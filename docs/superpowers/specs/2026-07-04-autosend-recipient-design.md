# Supplier-Invoice Auto-Send Recipient — Design (13c follow-on)

**Date:** 2026-07-04
**Status:** Approved (brainstorm) → pending spec review
**Base:** slice 13c merged (`main` @ `b27f131`) — price-guard pipeline drafts/auto-sends `credit_request`s; the auto-send email currently has `to: ""` (a plan-sanctioned MVP stub), so no supplier is ever emailed. Auto-send is also dormant behind the HUMAN-owned task-133 gate.

## Goal

Give the gated auto-send path a real, safe supplier recipient — replacing `to: ""` — so a confidence-gated credit request actually emails the supplier, **while never emailing a forwarder or our own inbox**. Recipient-validity becomes an additional auto-send gate, consistent with 13c's "never unattended-email a shaky parse" principle.

## Non-goals

- No supplier/vendor directory or contact-management UI (a clean future add).
- No AI extraction of the billing email from the PDF (considered, deferred).
- No change to the existing confidence/overage/gate logic or to when task 133 is flipped to `full_auto`.
- No backfill of historical invoices.

## Decisions (from brainstorm)

1. **Recipient source = the inbound `from`.** The forwarded email's sender address is persisted at ingestion and used as the recipient. This is reliable when forwarding preserves the supplier's original `From` header (Cloudflare Email Routing does); a human "FW:" does not, which the guard below handles.
2. **Recipient guard = downgrade to draft + Today card** when the resolved recipient is not a plausible external supplier address. Auto-send only proceeds to a valid, non-self external address.

## Architecture

### 1. Persist the sender (data)
- Add nullable `sender_email text` column to `supplier_invoice` — **migration 0049** (additive, non-destructive).
- In `apps/web/src/lib/supplier-invoice-ingest.ts`, store the raw `body.from` into `sender_email` at insert time. (Today `body.from` is used only to derive a provisional `supplier_name` domain, then discarded.)
- No backfill; only new invoices carry `sender_email`.

### 2. Pure recipient resolver (`@savvy/core`)
- `resolveSupplierRecipient(from: string | null, opts: { selfDomains: string[] }): string | null`
  - Returns a trimmed, valid external email, or `null` when:
    - `from` is empty/whitespace, OR
    - it has no valid `local@domain` shape (single `@`, non-empty local + domain, domain has a dot), OR
    - the domain (case-insensitive) equals or is a subdomain of any `selfDomains` entry.
  - Pure and fully unit-tested. If `from` is a display-name form (`"ABC Supply" <ar@abc.com>`), extract the bracketed address; otherwise treat the whole string as the address.
- `selfDomains` default: `["getsavvy.com"]` (covers `inbox.getsavvy.com` via subdomain match). Passed in by the caller so it's configurable/testable.

### 3. Wire into the guard handler (`@savvy/agents`)
- Thread `senderEmail` through `loadInvoice` into `priceGuardHandler` (extend the loaded invoice shape + the DB select in the Inngest wiring).
- Add a handler dep `resolveRecipient(senderEmail: string | null): string | null` (wired to `resolveSupplierRecipient` with the default self-domains; injectable for tests).
- In the auto-send branch: compute `recipient = resolveRecipient(inv.senderEmail)`. **If `recipient` is `null` → take the draft + `raiseDraftCard` path** even when confidence/overage/gate/match all pass. Only a non-null recipient calls `sendEmail({ to: recipient, ... })`.
- `buildCreditEmail` takes the resolved `to` (no longer `""`).
- Net effect: recipient-validity is a fourth auto-send gate, alongside `claim ≥ floor`, `parseConfidence ≥ 0.8`, `allOverageLinesMatched`, and `gate.proceed`.

### Data flow
```
inbound email (from) ──ingest──▶ supplier_invoice.sender_email
                                          │
parse (13b) ──▶ guarded lines + overage ──▶ priceGuardHandler
                                          │
              recipient = resolveSupplierRecipient(sender_email)
                     │                         │
                null │                         │ valid external
                     ▼                         ▼
             draft + Today card        sendEmail(to: recipient) + credit_request(sent)
```

## Error handling
- Resolver is pure and total (never throws; returns `null` on any malformed input).
- The handler stays fail-soft (any throw → `guard_skipped`, unchanged from 13c).
- A `null` recipient is a normal branch (draft), not an error.

## Testing
- **Core** (`@savvy/core`, vitest): `resolveSupplierRecipient` — valid supplier address; display-name form; self-domain (`x@getsavvy.com`, `x@inbox.getsavvy.com`) → null; malformed (`""`, `"abc"`, `"a@b"`, double `@`) → null; case-insensitive domain.
- **Agents** (`@savvy/agents`, vitest, DI): valid recipient → `sendEmail` called with `to: recipient` + `createCredit(status:"sent")`; null recipient (e.g. `from` on getsavvy.com) → drafts, `sendEmail` NOT called, `raiseDraftCard` called. Existing 6+3 guard/recovery cases stay green (add a `senderEmail` to their fixture so the happy path still sends).
- **DB** (`@savvy/db`, vitest): ingestion persists `sender_email`; migration 0049 present with the column.
- **E2e** (`apps/web`, Playwright, AI-stubbed): keep `sendEmail` stubbed; give the guard spec's forwarded invoice a real external `from` so the `credit_request` lands `sent` — tighten the existing `status in (sent,drafted)` assertion to `sent`.

## Migration
- **0049** generated via `pnpm --filter @savvy/db db:generate` (next after 0048). Additive column only.
- Run on prod post-merge via `DATABASE_ADMIN_URL … db:migrate` (same flow used for 0048).

## Known limitation (documented)
- Self-domain detection covers `getsavvy.com`, not a tenant's own forwarding-mailbox domain (we don't store it). A manual "FW:" from the tenant's own mailbox whose `From` got rewritten to the tenant could still resolve to a valid address — but the parse-confidence + overage gates still apply, and the worst case is emailing the tenant itself, not a random third party. A per-tenant self-domain list is a clean future add.

## Definition of done
- [ ] `supplier_invoice.sender_email` column + migration 0049; ingestion persists `body.from`.
- [ ] `resolveSupplierRecipient` in `@savvy/core`, fully unit-tested.
- [ ] Guard handler resolves the recipient; null → draft + card, valid → `sendEmail(to)` + `credit_request(sent)`; `buildCreditEmail` uses the resolved `to`.
- [ ] Unit + e2e green; typecheck + lint clean; migration 0049 generated (run on prod post-merge).
- [ ] RLS/tenant isolation unaffected (no new table).
