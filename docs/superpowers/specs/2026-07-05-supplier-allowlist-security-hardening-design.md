# Pre-Go-Live Security Hardening — Design

**Date:** 2026-07-05
**Status:** Approved (brainstorm) → pending spec review
**Base:** `main` @ `a394b7d` (supplier auto-send LIVE from #137; canvass rep-auth hardened #139).

## Goal

Harden the supplier auto-send path before it emails real suppliers in production, and close a repo-hygiene gap in canvass provisioning. Two independent parts, shipped in **one PR with separate commits**.

## Part 1 — Canvass provisioning repo-hygiene (small)

**Context:** an automated security review flagged a hardcoded tenant `publicKey` in `canvass-app/seed-alta-tenant.sql` and weak key generation in `packages/db/src/setup-canvass.ts`. **Both files are UNTRACKED local scripts** (never committed; confirmed via `git ls-files`/`git log --all`) — they are not repo code, but they are also not gitignored, so they *could* be committed by accident.

- **In the PR:** add `.gitignore` entries so these untracked, secret-bearing local files can never be committed:
  - `canvass-app/` (local seed scripts with real tenant keys)
  - `packages/db/src/setup-canvass.ts` (local admin provisioning script)
- **Out of scope (local/ops, not a repo change):** hardening the generator in the local `setup-canvass.ts` (`randomUUID().slice(0,12)` → `randomBytes(32).toString("base64url")`) and rotating the Alta tenant's publicKey. These are edits to untracked local files / the prod DB and are handled directly, not via this PR.

## Part 2 — Supplier auto-send allow-list + observability (feature)

**Threat:** the auto-send recipient is derived from the unauthenticated inbound `From` header. A spoofed `From` on a PDF that parses as a confident, matched overbill could auto-email a credit request to an attacker-chosen address. This adds an **opt-in per-tenant allow-list** to constrain auto-send recipients, plus **observability** on every send.

### Decisions (from brainstorm)
- **Domain-level** allow-list (not full email) — supplier AR addresses vary by mailbox (`ar@`, `billing@`, `credit@`).
- **Empty allow-list = allow all** (opt-in restriction): with no entries, auto-send behaves as it does today (any resolved external recipient). Once a tenant adds ≥1 domain, auto-send is restricted to those domains; a non-matching recipient drafts instead.

### Architecture

**Schema** — new `supplier_allowlist` table, **migration 0051**:
```
supplier_allowlist { id, tenant_id (FK, notNull), domain (text, notNull, lowercased),
                     label (text, nullable), created_at }
```
+ `tenantIsolation()` RLS + unique index `(tenant_id, domain)`.

**Core** — pure, unit-tested:
- `isRecipientAllowed(recipientEmail: string, allowedDomains: string[]): boolean` — `true` when `allowedDomains` is **empty** (opt-in: no restriction) OR the recipient's domain (case-insensitive) is in `allowedDomains`. Reuses domain extraction consistent with `resolveSupplierRecipient`.

**DB lifecycle** (`packages/db/src/lifecycle/supplier-allowlist.ts`, all `withTenant`):
- `listSupplierAllowlist(tenantId): Promise<{ id, domain, label, createdAt }[]>`
- `listAllowedDomains(tenantId): Promise<string[]>` — just the domains, for the handler gate.
- `addSupplierAllowlistDomain(tenantId, { domain, label? }): Promise<{ id }>` — lowercases/normalizes the domain; idempotent on the unique index.
- `removeSupplierAllowlistDomain(tenantId, id): Promise<void>`.

**Handler — 5th auto-send gate** (`priceGuardHandler`):
- Add dep `loadAllowedDomains(tenantId): Promise<string[]>` (wired to `listAllowedDomains`; injectable for tests).
- Compute `allowedByList = isRecipientAllowed(recipient, allowedDomains)` (only meaningful when `recipient !== null`).
- `autoSend = shouldAutoSendCredit(...) && gate.proceed && recipient !== null && allowedByList`.
- A resolved recipient whose domain is not in a **non-empty** allow-list → falls through to the existing draft + Today-card path (no new branch).
- Stays fail-soft; empty allow-list preserves current behavior (existing guard e2e still reaches `sent` without seeding).

**Observability** — structured logs in the handler (existing `log`):
- On auto-send: `log.info("credit-request auto-sent", { tenantId, recipientDomain, claimedCents, creditRequestId })`.
- On allow-list block (non-empty list, recipient not allowed): `log.info("credit-request drafted: recipient not allow-listed", { tenantId, recipientDomain })`.

**UI** — `apps/web/src/app/(app)/settings/suppliers/page.tsx` (server component), mirroring `settings/price-book`:
- Lists allowed domains (+ label, added date) with a remove control.
- Add form (domain, optional label) → server actions `addSupplierAllowlistDomain` / `removeSupplierAllowlistDomain` in `apps/web/src/lib/supplier-allowlist-actions.ts` (tenant from `getTenantId()`; `revalidatePath`).
- Add a "Suppliers" entry to the settings nav.
- Copy notes the opt-in behavior: "Empty = auto-send to any resolved supplier. Add domains to restrict auto-send to only those suppliers."

### Error handling
- `isRecipientAllowed` is pure/total (never throws).
- Handler stays fail-soft (any throw → `guard_skipped`).
- Server actions require an authed session (`getTenantId()`); domain input validated (non-empty, basic domain shape) and lowercased.

### Testing
- **Core:** `isRecipientAllowed` — empty list → true; domain in list (case-insensitive) → true; domain not in list → false; null/garbage recipient handled.
- **Agents:** handler tests — allow-listed domain → sends; non-empty list without the domain → drafts (no email); empty list → sends (existing behavior). Existing 11 guard/recovery cases stay green (baseDeps `loadAllowedDomains` returns `[]`).
- **DB:** lifecycle add/list/remove + RLS cross-tenant for `supplier_allowlist`.
- **E2e:** the existing `supplier-invoice-guard.spec` stays green (empty list → `sent`). Add a focused assertion or a new spec case: seed a non-matching allow-list domain for the guard tenant and assert the credit request lands `drafted` (recipient blocked). Keep `sendEmail` stubbed under TEST_MODE.
- **Web:** `settings/suppliers` validated by typecheck + lint (apps/web not in vitest).

### Migration
- **0051** generated via `pnpm --filter @savvy/db db:generate` (next after 0050). New table only, additive.
- Run on prod post-merge (alongside 0050).

## Definition of Done
- [ ] `.gitignore` blocks `canvass-app/` + local `setup-canvass.ts` from ever being committed.
- [ ] `supplier_allowlist` table + migration 0051 + RLS + cross-tenant test.
- [ ] `isRecipientAllowed` in `@savvy/core`, unit-tested (empty=allow, non-empty=restrict, case-insensitive).
- [ ] Handler auto-send gated on the allow-list (5th gate); empty list preserves current behavior; non-matching recipient drafts.
- [ ] Observability logs on auto-send + allow-list block.
- [ ] `settings/suppliers` management UI (list/add/remove) + nav entry.
- [ ] Unit + e2e green; typecheck + lint clean; migrations 0051 generated (run on prod post-merge, with 0050).

## Out of scope / follow-ups
- Local `setup-canvass.ts` CSPRNG fix + Alta key rotation (local/ops, offered separately).
- AI PDF-email recipient extraction; supplier directory beyond the domain allow-list.
- Full audit-log entity for auto-sends (structured logs suffice for v1).
