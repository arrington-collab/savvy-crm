# Supplier-Invoice Auto-Send Recipient Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the 13c gated auto-send path a real, safe supplier recipient (replacing `to: ""`) resolved from the inbound `from`, with a validity guard that downgrades to draft when the address is missing/self/malformed.

**Architecture:** Persist the inbound sender on `supplier_invoice`; a pure `@savvy/core` resolver turns it into a valid external address or `null`; the guard handler treats a `null` recipient as a fourth auto-send gate (→ draft + Today card) and passes a non-null address to `sendEmail`.

**Tech Stack:** TypeScript · Drizzle/Postgres (RLS) · `@savvy/core` pure helpers (Vitest) · Inngest handler (Vitest, DI) · Playwright e2e (AI-stubbed).

**Spec:** `docs/superpowers/specs/2026-07-04-autosend-recipient-design.md`. **Base:** slice 13c merged (`main` @ `b27f131`).

## Global Constraints

- **Tenant isolation on every query** — all DB access via `withTenant`; no new table (column-only), RLS unchanged.
- **No hard-coded models** anywhere (N/A here — no AI in this slice).
- **No `.js` import extensions** in any package src or `@savvy/db` barrel (breaks Turbopack e2e build).
- **Migrations via `pnpm --filter @savvy/db db:generate`** — never hand-numbered. Next after 0048 = **0049**.
- **`apps/web` is NOT run by vitest** (`vitest.workspace.ts` = `packages/*` only) — validate web changes with typecheck + lint + Playwright e2e.
- **Handler stays fail-soft** — any throw → `guard_skipped`, never throws (unchanged from 13c).
- Money is integer cents; guard/recovery behavior from 13c is unchanged except the recipient gate.

---

### Task 1: Core — `resolveSupplierRecipient` pure resolver

**Files:**
- Create: `packages/core/src/supplier-recipient.ts`
- Create: `packages/core/src/supplier-recipient.test.ts`
- Modify: `packages/core/src/index.ts` (export)

**Interfaces:**
- Consumes: nothing.
- Produces: `resolveSupplierRecipient(from: string | null | undefined, opts: { selfDomains: string[] }): string | null`; `SUPPLIER_SELF_DOMAINS: string[]` (default `["getsavvy.com"]`).

- [ ] **Step 1: Write the failing test** — create `packages/core/src/supplier-recipient.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { resolveSupplierRecipient, SUPPLIER_SELF_DOMAINS } from "./supplier-recipient";

const opts = { selfDomains: SUPPLIER_SELF_DOMAINS };

describe("resolveSupplierRecipient", () => {
  it("returns a plain valid external address", () => {
    expect(resolveSupplierRecipient("ar@abcsupply.com", opts)).toBe("ar@abcsupply.com");
  });
  it("extracts the bracketed address from a display-name form", () => {
    expect(resolveSupplierRecipient('"ABC Supply AR" <ar@abcsupply.com>', opts)).toBe("ar@abcsupply.com");
  });
  it("trims surrounding whitespace", () => {
    expect(resolveSupplierRecipient("  ar@abcsupply.com  ", opts)).toBe("ar@abcsupply.com");
  });
  it("returns null for a self domain and its subdomains (case-insensitive)", () => {
    expect(resolveSupplierRecipient("billing@getsavvy.com", opts)).toBeNull();
    expect(resolveSupplierRecipient("inv-abc@inbox.getsavvy.com", opts)).toBeNull();
    expect(resolveSupplierRecipient("X@INBOX.GETSAVVY.COM", opts)).toBeNull();
  });
  it("returns null for empty / missing input", () => {
    expect(resolveSupplierRecipient("", opts)).toBeNull();
    expect(resolveSupplierRecipient(null, opts)).toBeNull();
    expect(resolveSupplierRecipient(undefined, opts)).toBeNull();
    expect(resolveSupplierRecipient("   ", opts)).toBeNull();
  });
  it("returns null for malformed addresses", () => {
    expect(resolveSupplierRecipient("abc", opts)).toBeNull();       // no @
    expect(resolveSupplierRecipient("a@b", opts)).toBeNull();       // no dot in domain
    expect(resolveSupplierRecipient("a@b@c.com", opts)).toBeNull(); // two @
    expect(resolveSupplierRecipient("a @b.com", opts)).toBeNull();  // space in local
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `cd packages/core && pnpm exec vitest run src/supplier-recipient.test.ts`. Expected: FAIL (`./supplier-recipient` missing).

- [ ] **Step 3: Implement** — create `packages/core/src/supplier-recipient.ts`:

```ts
/** Resolve a safe supplier email recipient from an inbound `from` header.
 *  Returns a valid external address, or null when the address is missing,
 *  malformed, or belongs to a self domain — in which case the guard handler
 *  falls back to drafting the credit request instead of auto-sending. */

// exactly one @, non-empty local (no whitespace), domain with at least one dot.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Savvy-owned domains that must never receive a supplier credit request. */
export const SUPPLIER_SELF_DOMAINS = ["getsavvy.com"];

/** `"ABC" <ar@abc.com>` -> `ar@abc.com`; a plain address is returned as-is. */
function extractAddress(raw: string): string {
  const m = raw.match(/<([^>]+)>/);
  return (m ? m[1]! : raw).trim();
}

function domainOf(addr: string): string {
  return addr.slice(addr.lastIndexOf("@") + 1).toLowerCase();
}

/** True when `domain` equals or is a subdomain of any self domain. */
function isSelfDomain(domain: string, selfDomains: string[]): boolean {
  return selfDomains.some((s) => {
    const sd = s.toLowerCase();
    return domain === sd || domain.endsWith(`.${sd}`);
  });
}

export function resolveSupplierRecipient(
  from: string | null | undefined,
  opts: { selfDomains: string[] },
): string | null {
  if (!from) return null;
  const addr = extractAddress(from);
  if (!EMAIL_RE.test(addr)) return null;
  if (isSelfDomain(domainOf(addr), opts.selfDomains)) return null;
  return addr;
}
```

- [ ] **Step 4: Export** — add to `packages/core/src/index.ts`: `export * from "./supplier-recipient";`

- [ ] **Step 5: Verify pass + typecheck + commit**

```bash
cd packages/core && pnpm exec vitest run src/supplier-recipient.test.ts   # PASS
cd ../.. && pnpm --filter @savvy/core typecheck
git add packages/core/src/supplier-recipient.ts packages/core/src/supplier-recipient.test.ts packages/core/src/index.ts
git commit -m "feat(core): resolveSupplierRecipient — safe external supplier email resolver"
```

---

### Task 2: DB — `sender_email` column on `supplier_invoice` + migration 0049

**Files:**
- Modify: `packages/db/src/schema/supplier-invoice.ts` (add column)
- Generate: `packages/db/drizzle/0049_*.sql` via `db:generate`

**Interfaces:**
- Consumes: nothing.
- Produces: `supplierInvoice.senderEmail` (`sender_email text`, nullable).

- [ ] **Step 1: Add the column** — in `packages/db/src/schema/supplier-invoice.ts`, add after the `externalMessageId` line:

```ts
  externalMessageId: text("external_message_id"),
  senderEmail: text("sender_email"), // inbound `from` — resolved to the auto-send recipient (13c follow-on)
```

- [ ] **Step 2: Generate the migration**

Run: `pnpm --filter @savvy/db db:generate` → produces `packages/db/drizzle/0049_*.sql`. **Inspect the SQL:** confirm it is exactly `ALTER TABLE "supplier_invoice" ADD COLUMN "sender_email" text;` (additive, nullable, no other changes). Paste the SQL line into the commit/PR.

- [ ] **Step 3: Apply locally + typecheck + commit**

```bash
pnpm --filter @savvy/db db:migrate        # applies 0049 to the local dev DB
pnpm --filter @savvy/db typecheck
git add packages/db/src/schema/supplier-invoice.ts packages/db/drizzle/
git commit -m "feat(db): supplier_invoice.sender_email column (migration 0049)"
```
(Run on prod post-merge, same flow as 0048.)

---

### Task 3: Web — persist inbound `from` into `sender_email` at ingestion

**Files:**
- Modify: `apps/web/src/lib/supplier-invoice-ingest.ts` (add `senderEmail` to the insert)

**Interfaces:**
- Consumes: `supplierInvoice.senderEmail` (Task 2).
- Produces: nothing (behavior only). Validated by typecheck + the Task 5 e2e (no vitest for `apps/web`).

- [ ] **Step 1: Persist the sender** — in `apps/web/src/lib/supplier-invoice-ingest.ts`, the `supplierInvoice` insert currently reads:

```ts
      const [inv] = await tx.insert(supplierInvoice).values({
        tenantId, documentId: doc!.id, supplierName, externalMessageId: body.messageId, status: "received",
      }).onConflictDoNothing({ target: [supplierInvoice.tenantId, supplierInvoice.externalMessageId] }).returning({ id: supplierInvoice.id });
```

Change the `.values({...})` to also store the raw sender:

```ts
      const [inv] = await tx.insert(supplierInvoice).values({
        tenantId, documentId: doc!.id, supplierName, senderEmail: body.from ?? null, externalMessageId: body.messageId, status: "received",
      }).onConflictDoNothing({ target: [supplierInvoice.tenantId, supplierInvoice.externalMessageId] }).returning({ id: supplierInvoice.id });
```

(`body.from` already exists on `InboundBody`; today only its domain is used for `supplierName`.)

- [ ] **Step 2: Typecheck + lint + commit**

```bash
pnpm --filter @savvy/web typecheck && pnpm --filter @savvy/web lint   # clean (4 pre-existing _-prefixed warnings OK)
git add apps/web/src/lib/supplier-invoice-ingest.ts
git commit -m "feat(web): persist inbound from as supplier_invoice.sender_email"
```

---

### Task 4: Agents — resolve recipient in the guard handler (null → draft, valid → send)

**Files:**
- Modify: `packages/agents/src/functions/supplier-invoice-guard.ts`
- Modify: `packages/agents/src/functions/supplier-invoice-guard.test.ts`

**Interfaces:**
- Consumes: `resolveSupplierRecipient`, `SUPPLIER_SELF_DOMAINS` (Task 1); `supplierInvoice.senderEmail` (Task 2).
- Produces: `PriceGuardDeps.resolveRecipient: (senderEmail: string | null) => string | null`; `ParsedInvoice.senderEmail: string | null`.

- [ ] **Step 1: Write the failing tests** — in `packages/agents/src/functions/supplier-invoice-guard.test.ts`:

First, add `senderEmail` to the shared `invoice` fixture (so the existing auto-send test still sends) and a `resolveRecipient` spy to `baseDeps`. The fixture currently is:

```ts
const invoice = {
  jobId: "job-1", supplierName: "ABC Supply", invoiceNumber: "INV-9", parseConfidence: 0.92, totalCents: 240000,
```
Change its first line to include the sender:
```ts
const invoice = {
  jobId: "job-1", supplierName: "ABC Supply", invoiceNumber: "INV-9", parseConfidence: 0.92, totalCents: 240000, senderEmail: "ar@abcsupply.com",
```
And in `baseDeps = () => ({ ... })`, add a resolver spy that returns a valid address by default:
```ts
  resolveRecipient: vi.fn().mockReturnValue("ar@abcsupply.com"),
```

Then add two new cases inside `describe("priceGuardHandler", …)`:

```ts
  it("auto-sends to the resolved recipient address", async () => {
    const deps = baseDeps();
    await priceGuardHandler(input, deps);
    expect(deps.resolveRecipient).toHaveBeenCalledWith("ar@abcsupply.com");
    expect(deps.sendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: "ar@abcsupply.com" }));
    expect(deps.createCredit).toHaveBeenCalledWith("t", expect.objectContaining({ status: "sent" }));
  });

  it("drafts (no email) when the recipient does not resolve, even if confident + gated open", async () => {
    const deps = baseDeps();
    deps.resolveRecipient = vi.fn().mockReturnValue(null); // e.g. self-domain / missing sender
    const res = await priceGuardHandler(input, deps);
    expect(res.status).toBe("guarded");
    expect(deps.sendEmail).not.toHaveBeenCalled();
    expect(deps.createCredit).toHaveBeenCalledWith("t", expect.objectContaining({ status: "drafted" }));
    expect(deps.raiseDraftCard).toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run to verify they fail** — `cd packages/agents && pnpm exec vitest run src/functions/supplier-invoice-guard.test.ts`. Expected: FAIL (`resolveRecipient` not used; `sendEmail` still called with `to: ""`).

- [ ] **Step 3: Add `senderEmail` to `ParsedInvoice` + `resolveRecipient` to `PriceGuardDeps`** — in `packages/agents/src/functions/supplier-invoice-guard.ts`:

In `type ParsedInvoice = { … }` add:
```ts
  senderEmail: string | null;
```
In `export type PriceGuardDeps = { … }` add:
```ts
  resolveRecipient: (senderEmail: string | null) => string | null;
```

- [ ] **Step 4: Gate the auto-send on a resolved recipient** — in the handler body, the current auto-send block reads:

```ts
    const autoSend =
      shouldAutoSendCredit({ claimedCents, parseConfidence: inv.parseConfidence, allOverageLinesMatched, cfg }) &&
      gate.proceed;

    if (autoSend) {
      const email = await deps.sendEmail(buildCreditEmail(inv, claimedCents, evidence));
```

Change it to resolve the recipient first and require it:

```ts
    const recipient = deps.resolveRecipient(inv.senderEmail);
    const autoSend =
      shouldAutoSendCredit({ claimedCents, parseConfidence: inv.parseConfidence, allOverageLinesMatched, cfg }) &&
      gate.proceed &&
      recipient !== null;

    if (autoSend) {
      const email = await deps.sendEmail(buildCreditEmail(inv, claimedCents, evidence, recipient!));
```

(The draft path below is unchanged — a `null` recipient now falls through to it.)

- [ ] **Step 5: Make `buildCreditEmail` take the resolved `to`** — change its signature + return. Current:

```ts
function buildCreditEmail(
  inv: ParsedInvoice,
  claimedCents: number,
  evidence: unknown[],
): { to: string; subject: string; html: string } {
  // …
  return {
    to: "",
```
Change to:
```ts
function buildCreditEmail(
  inv: ParsedInvoice,
  claimedCents: number,
  evidence: unknown[],
  to: string,
): { to: string; subject: string; html: string } {
  // …
  return {
    to,
```

- [ ] **Step 6: Load `senderEmail` + wire the real resolver in the Inngest fn** — in the guard `loadInvoice` wiring, the SELECT currently is:

```ts
              .select({
                jobId: supplierInvoice.jobId,
                supplierName: supplierInvoice.supplierName,
                invoiceNumber: supplierInvoice.invoiceNumber,
                parseConfidence: supplierInvoice.parseConfidence,
                totalCents: supplierInvoice.totalCents,
                lines: supplierInvoice.lines,
```
Add `senderEmail` to the select AND to the returned object:
```ts
                senderEmail: supplierInvoice.senderEmail,
```
(mirror it wherever the row fields are mapped into the returned `ParsedInvoice`).

Add the resolver dep in the same deps object that supplies `loadInvoice`/`sendEmail`/etc.:
```ts
        resolveRecipient: (senderEmail) => resolveSupplierRecipient(senderEmail, { selfDomains: SUPPLIER_SELF_DOMAINS }),
```
And import it at the top from `@savvy/core`:
```ts
import { …existing…, resolveSupplierRecipient, SUPPLIER_SELF_DOMAINS } from "@savvy/core";
```

- [ ] **Step 7: Verify pass + full suite + typecheck + commit**

```bash
cd packages/agents && pnpm exec vitest run src/functions/supplier-invoice-guard.test.ts   # all cases PASS
pnpm --filter @savvy/agents test                                                            # full agents suite green
cd ../.. && pnpm --filter @savvy/agents typecheck
git add packages/agents/src/functions/supplier-invoice-guard.ts packages/agents/src/functions/supplier-invoice-guard.test.ts
git commit -m "feat(agents): resolve supplier recipient — null gates auto-send to draft, valid sends to address"
```

---

### Task 5: E2e — a real external `from` lands the credit request `sent`

**Files:**
- Modify: `apps/web/tests/e2e/supplier-invoice-guard.spec.ts`

**Interfaces:**
- Consumes: the full pipeline (Tasks 1–4).
- Produces: nothing.

- [ ] **Step 1: Give the guard invoice a real external sender** — in `apps/web/tests/e2e/supplier-invoice-guard.spec.ts`, the forwarded guard invoice is POSTed with a `from`. Set that `from` to a valid external supplier address (NOT a `getsavvy.com` address), e.g. `from: "ar@abcsupply.com"`, so `resolveSupplierRecipient` returns it and the auto-send gate opens (the e2e's `sendEmail` is stubbed under `TEST_MODE`, so no real email is sent). If the spec seeds the tenant's automation gate as open for task 133, the request will be `sent`; if the gate is HUMAN-owned in the e2e's seed, keep the assertion tolerant (see Step 2).

- [ ] **Step 2: Tighten the status assertion** — the spec currently asserts:

```ts
    expect(["sent", "drafted"]).toContain(cr!.status);
```
If the e2e's tenant seed opens the task-133 gate (auto-send path), change it to:
```ts
    expect(cr!.status).toBe("sent");
```
AND assert the persisted sender + recipient took effect by checking `sender_email` on the invoice row after ingestion (add to the existing invoice poll/select):
```ts
    expect(row!.senderEmail).toBe("ar@abcsupply.com");
```
If the gate is HUMAN-owned in the e2e seed (so auto-send can't fire regardless of recipient), do NOT force `sent`; instead keep `["sent","drafted"]` but still assert `sender_email` persisted, and add a comment that the recipient gate is unit-covered in Task 4. (Check the spec's tenant seed to decide which applies; prefer opening the gate so the e2e exercises the real send path.)

- [ ] **Step 3: Commit**

```bash
git add apps/web/tests/e2e/supplier-invoice-guard.spec.ts
git commit -m "test(e2e): real external from resolves recipient → credit request sent + sender_email persisted"
```

- [ ] **Step 4: Open PR + watch + merge**

```bash
git push -u origin <branch>
gh pr create --base main --title "feat(console): supplier-invoice auto-send recipient (13c follow-on)" --body "…"
gh pr checks <n> --watch
gh pr merge <n> --squash --delete-branch
```
(Then run migration 0049 on prod, same flow as 0048.)

---

## Definition of Done

- [ ] `supplier_invoice.sender_email` column + migration 0049; ingestion persists `body.from`.
- [ ] `resolveSupplierRecipient` in `@savvy/core`, fully unit-tested (valid / display-name / self-domain / malformed / empty).
- [ ] Guard handler resolves the recipient; `null` → draft + card, valid → `sendEmail(to)` + `credit_request(sent)`; `buildCreditEmail` uses the resolved `to`.
- [ ] Unit + full agents suite green; e2e green; typecheck + lint clean; migration 0049 generated (run on prod post-merge).
- [ ] Tenant isolation unaffected (column-only, RLS unchanged).

## Self-Review

- **Spec coverage:** persist sender (Task 2/3) ✓; pure resolver w/ self-domain + display-name + malformed rules (Task 1) ✓; recipient as 4th auto-send gate → draft on null (Task 4) ✓; `buildCreditEmail` uses resolved `to` (Task 4) ✓; migration 0049 + prod note (Task 2/5) ✓; e2e sent-path + sender persistence (Task 5) ✓; documented self-domain limitation (spec, no code needed).
- **Type consistency:** `resolveSupplierRecipient(from, {selfDomains})→string|null` defined Task 1, consumed Task 4; `ParsedInvoice.senderEmail: string|null` added Task 4 and loaded from `supplierInvoice.senderEmail` (Task 2); `PriceGuardDeps.resolveRecipient` signature matches the wiring closure; `buildCreditEmail(inv, claimedCents, evidence, to)` call sites updated in the same task.
- **Deferred (spec non-goals):** supplier directory, AI PDF-email extraction, per-tenant self-domain list — all out of scope.
