# Pre-Go-Live Security Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in per-tenant supplier allow-list (a 5th auto-send gate) with observability so a spoofed inbound `From` can't auto-email an attacker, and gitignore the untracked canvass provisioning scripts so their real keys can't be committed.

**Architecture:** New `supplier_allowlist` table (migration 0051) + a pure `isRecipientAllowed` core helper + DB lifecycle writers + a handler gate (empty list = allow-all; non-empty = restrict) + structured auto-send logs + a `settings/suppliers` management UI. Plus a `.gitignore` entry for the local canvass scripts.

**Tech Stack:** TypeScript · Drizzle/Postgres (RLS) · `@savvy/core` pure helpers (Vitest) · Inngest handler (Vitest, DI) · Next.js server components + server actions · Playwright e2e (AI-stubbed).

**Spec:** `docs/superpowers/specs/2026-07-05-supplier-allowlist-security-hardening-design.md`. **Base:** `main` @ `a394b7d`.

## Global Constraints

- **Tenant isolation on every query/table:** `supplier_allowlist` carries `tenant_id` + `tenantIsolation()` RLS; all DB access via `withTenant`. Cross-tenant read-returns-nothing test stays green.
- **Empty allow-list = allow all** (opt-in restriction). Non-empty = auto-send only to a recipient whose domain is in the list; otherwise draft. This preserves current auto-send behavior until a tenant adds domains.
- **Handler stays fail-soft** — any throw → `guard_skipped`, never throws.
- **No `.js` import extensions** in any package src / `@savvy/db` barrel (breaks Turbopack e2e build).
- **Migrations via `pnpm --filter @savvy/db db:generate`** — never hand-numbered. Next after 0050 = **0051**.
- **`apps/web` is NOT run by vitest** (`vitest.workspace.ts` = `packages/*`) — validate web changes with typecheck + lint + Playwright e2e.
- Domains stored/compared lowercased. No hard-coded models. No secrets committed.

---

### Task 1: Repo — gitignore the untracked canvass provisioning scripts

**Files:**
- Modify: `.gitignore`

**Interfaces:** none (repo hygiene only).

- [ ] **Step 1: Confirm the files are untracked** — run `git ls-files canvass-app/ "*setup-canvass*"`. Expected: EMPTY (they are local, never committed). If either prints a path, STOP and report (the plan's assumption is wrong).

- [ ] **Step 2: Add gitignore entries** — append to `.gitignore`:

```gitignore

# Local canvass provisioning scripts — contain real tenant publicKeys; never commit
canvass-app/
packages/db/src/setup-canvass.ts
```

- [ ] **Step 3: Verify they are now ignored** — run `git check-ignore canvass-app/seed-tenant.sql packages/db/src/setup-canvass.ts`. Expected: both paths printed (ignored). Run `git status --porcelain` and confirm neither file appears as untracked.

- [ ] **Step 4: Commit**

```bash
git add .gitignore
git commit -m "chore(security): gitignore untracked canvass provisioning scripts (real tenant keys)"
```

---

### Task 2: Core — `isRecipientAllowed` pure helper

**Files:**
- Create: `packages/core/src/supplier-allowlist.ts`
- Create: `packages/core/src/supplier-allowlist.test.ts`
- Modify: `packages/core/src/index.ts` (export)

**Interfaces:**
- Consumes: nothing.
- Produces: `isRecipientAllowed(recipientEmail: string, allowedDomains: string[]): boolean`.

- [ ] **Step 1: Write the failing test** — create `packages/core/src/supplier-allowlist.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { isRecipientAllowed } from "./supplier-allowlist";

describe("isRecipientAllowed", () => {
  it("allows any recipient when the list is empty (opt-in restriction)", () => {
    expect(isRecipientAllowed("ar@abcsupply.com", [])).toBe(true);
  });
  it("allows a recipient whose domain is in the list (case-insensitive)", () => {
    expect(isRecipientAllowed("ar@abcsupply.com", ["abcsupply.com"])).toBe(true);
    expect(isRecipientAllowed("AR@ABCSupply.com", ["abcsupply.com"])).toBe(true);
    expect(isRecipientAllowed("ar@abcsupply.com", ["ABCSUPPLY.COM"])).toBe(true);
  });
  it("blocks a recipient whose domain is not in a non-empty list", () => {
    expect(isRecipientAllowed("ar@evil.com", ["abcsupply.com"])).toBe(false);
    expect(isRecipientAllowed("ar@srs.com", ["abcsupply.com", "beacon.com"])).toBe(false);
  });
  it("blocks a malformed recipient against a non-empty list", () => {
    expect(isRecipientAllowed("not-an-email", ["abcsupply.com"])).toBe(false);
    expect(isRecipientAllowed("", ["abcsupply.com"])).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `cd packages/core && pnpm exec vitest run src/supplier-allowlist.test.ts`. Expected: FAIL (module missing).

- [ ] **Step 3: Implement** — create `packages/core/src/supplier-allowlist.ts`:

```ts
/** Opt-in per-tenant supplier recipient allow-list check.
 *  Empty list ⇒ no restriction (allow). Non-empty ⇒ the recipient's domain must
 *  be in the list (case-insensitive). All domains are compared lowercased. */
export function isRecipientAllowed(recipientEmail: string, allowedDomains: string[]): boolean {
  if (allowedDomains.length === 0) return true;
  const at = recipientEmail.lastIndexOf("@");
  if (at < 0 || at === recipientEmail.length - 1) return false;
  const domain = recipientEmail.slice(at + 1).toLowerCase();
  const allowed = new Set(allowedDomains.map((d) => d.trim().toLowerCase()));
  return allowed.has(domain);
}
```

- [ ] **Step 4: Export** — add to `packages/core/src/index.ts`: `export * from "./supplier-allowlist";`

- [ ] **Step 5: Verify pass + typecheck + commit**

```bash
cd packages/core && pnpm exec vitest run src/supplier-allowlist.test.ts   # PASS
cd ../.. && pnpm --filter @savvy/core typecheck
git add packages/core/src/supplier-allowlist.ts packages/core/src/supplier-allowlist.test.ts packages/core/src/index.ts
git commit -m "feat(core): isRecipientAllowed — opt-in supplier domain allow-list check"
```

---

### Task 3: DB — `supplier_allowlist` table + migration 0051

**Files:**
- Create: `packages/db/src/schema/supplier-allowlist.ts`
- Modify: `packages/db/src/schema/index.ts` (export)
- Generate: `packages/db/drizzle/0051_*.sql` via `db:generate`

**Interfaces:**
- Produces: `supplierAllowlist` table with columns `id, tenantId, domain, label, createdAt`.

- [ ] **Step 1: Create the table** — `packages/db/src/schema/supplier-allowlist.ts`:

```ts
import { pgTable, uuid, text, uniqueIndex } from "drizzle-orm/pg-core";
import { idCol, createdAt, tenantIsolation } from "./_rls";
import { tenant } from "./tenancy";

// Opt-in per-tenant supplier recipient allow-list (13c auto-send hardening). When a
// tenant has ≥1 row, price-guard auto-send only emails a recipient whose domain is
// listed; empty = no restriction. Manual delete removes a domain (no soft-delete).
export const supplierAllowlist = pgTable("supplier_allowlist", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  domain: text("domain").notNull(),
  label: text("label"),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex("supplier_allowlist_tenant_domain_uniq").on(t.tenantId, t.domain),
  tenantIsolation(),
]);
```

(Confirm `idCol`, `createdAt`, `tenantIsolation` are exported from `./_rls` — they are, used by `credit-request.ts`. Match that file's style.)

Add to `packages/db/src/schema/index.ts`: `export * from "./supplier-allowlist";`

- [ ] **Step 2: Generate the migration**

Run: `pnpm --filter @savvy/db db:generate` → produces `packages/db/drizzle/0051_*.sql`. **Inspect it:** confirm it `CREATE TABLE "supplier_allowlist"` with the 5 columns, the unique index, `ALTER TABLE … ENABLE ROW LEVEL SECURITY`, and the tenant-isolation policy, and touches NO other table. Paste the key SQL lines into your report. If `db:generate` numbers it other than 0051 or bundles unrelated changes, STOP and report.

- [ ] **Step 3: Apply locally + typecheck + commit**

```bash
pnpm --filter @savvy/db db:migrate        # local dev DB only (NOT prod)
pnpm --filter @savvy/db typecheck
git add packages/db/src/schema/supplier-allowlist.ts packages/db/src/schema/index.ts packages/db/drizzle/
git commit -m "feat(db): supplier_allowlist table + RLS (migration 0051)"
```
(Run on prod post-merge, alongside 0050.)

---

### Task 4: DB — supplier-allowlist lifecycle writers + RLS test

**Files:**
- Create: `packages/db/src/lifecycle/supplier-allowlist.ts`
- Modify: `packages/db/src/index.ts` (export)
- Create: `packages/db/src/lifecycle/supplier-allowlist.test.ts`
- Modify: `packages/db/tests/isolation.test.ts` (cross-tenant assertion)

**Interfaces:**
- Consumes: `supplierAllowlist` (Task 3).
- Produces:
  - `listSupplierAllowlist(tenantId): Promise<{ id: string; domain: string; label: string | null; createdAt: Date }[]>`
  - `listAllowedDomains(tenantId): Promise<string[]>`
  - `addSupplierAllowlistDomain(tenantId, input: { domain: string; label?: string | null }): Promise<{ id: string }>`
  - `removeSupplierAllowlistDomain(tenantId, id): Promise<void>`

- [ ] **Step 1: Write failing tests** — create `packages/db/src/lifecycle/supplier-allowlist.test.ts`:

```ts
import { it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { adminDb, tenant, supplierAllowlist, eq } from "../index";
import { listSupplierAllowlist, listAllowedDomains, addSupplierAllowlistDomain, removeSupplierAllowlistDomain } from "./supplier-allowlist";

let tenantId: string;
beforeAll(async () => {
  tenantId = randomUUID();
  await adminDb.insert(tenant).values({ id: tenantId, name: "AL Co", publicKey: `al-${tenantId.slice(0, 8)}` });
});
afterAll(async () => {
  await adminDb.delete(supplierAllowlist).where(eq(supplierAllowlist.tenantId, tenantId));
  await adminDb.delete(tenant).where(eq(tenant.id, tenantId));
});

it("add → list → listAllowedDomains → remove, lowercasing + idempotent", async () => {
  const { id } = await addSupplierAllowlistDomain(tenantId, { domain: "ABCSupply.com", label: "ABC" });
  await addSupplierAllowlistDomain(tenantId, { domain: "abcsupply.com" }); // idempotent (unique)
  const rows = await listSupplierAllowlist(tenantId);
  expect(rows.map((r) => r.domain)).toEqual(["abcsupply.com"]);
  expect(await listAllowedDomains(tenantId)).toEqual(["abcsupply.com"]);
  await removeSupplierAllowlistDomain(tenantId, id);
  expect(await listAllowedDomains(tenantId)).toEqual([]);
});
```

- [ ] **Step 2: Run to verify fail** — `cd packages/db && pnpm exec vitest run src/lifecycle/supplier-allowlist.test.ts`. Expected: FAIL (missing fns).

- [ ] **Step 3: Implement** — create `packages/db/src/lifecycle/supplier-allowlist.ts`:

```ts
import { and, eq, asc } from "drizzle-orm";
import { withTenant } from "../tenant";
import { supplierAllowlist } from "../schema/index";

const norm = (d: string) => d.trim().toLowerCase();

/** All allow-list rows for the settings UI. */
export async function listSupplierAllowlist(tenantId: string): Promise<{ id: string; domain: string; label: string | null; createdAt: Date }[]> {
  return withTenant(tenantId, (tx) =>
    tx.select({ id: supplierAllowlist.id, domain: supplierAllowlist.domain, label: supplierAllowlist.label, createdAt: supplierAllowlist.createdAt })
      .from(supplierAllowlist).where(eq(supplierAllowlist.tenantId, tenantId)).orderBy(asc(supplierAllowlist.domain)));
}

/** Just the domains — the handler gate. */
export async function listAllowedDomains(tenantId: string): Promise<string[]> {
  const rows = await withTenant(tenantId, (tx) =>
    tx.select({ domain: supplierAllowlist.domain }).from(supplierAllowlist).where(eq(supplierAllowlist.tenantId, tenantId)));
  return rows.map((r) => r.domain);
}

/** Add a domain (lowercased). Idempotent on the (tenant, domain) unique index. */
export async function addSupplierAllowlistDomain(tenantId: string, input: { domain: string; label?: string | null }): Promise<{ id: string }> {
  return withTenant(tenantId, async (tx) => {
    const [row] = await tx.insert(supplierAllowlist)
      .values({ tenantId, domain: norm(input.domain), label: input.label ?? null })
      .onConflictDoNothing({ target: [supplierAllowlist.tenantId, supplierAllowlist.domain] })
      .returning({ id: supplierAllowlist.id });
    if (row) return { id: row.id };
    // already existed → return the existing id
    const [existing] = await tx.select({ id: supplierAllowlist.id }).from(supplierAllowlist)
      .where(and(eq(supplierAllowlist.tenantId, tenantId), eq(supplierAllowlist.domain, norm(input.domain))));
    return { id: existing!.id };
  });
}

/** Remove one domain by id. */
export async function removeSupplierAllowlistDomain(tenantId: string, id: string): Promise<void> {
  await withTenant(tenantId, (tx) =>
    tx.delete(supplierAllowlist).where(and(eq(supplierAllowlist.tenantId, tenantId), eq(supplierAllowlist.id, id))));
}
```

- [ ] **Step 4: Export** — add to `packages/db/src/index.ts`:
```ts
export { listSupplierAllowlist, listAllowedDomains, addSupplierAllowlistDomain, removeSupplierAllowlistDomain } from "./lifecycle/supplier-allowlist";
```

- [ ] **Step 5: RLS cross-tenant test** — in `packages/db/tests/isolation.test.ts`, mirror the existing per-table pattern: seed a `supplier_allowlist` row under tenant A (or B), then assert a `withTenant(otherTenant, …)` select returns zero rows for `supplier_allowlist`. Follow exactly how the file seeds + asserts for `credit_request`/`supplier_invoice`. Clean teardown.

- [ ] **Step 6: Verify pass + typecheck + commit**

```bash
cd packages/db && pnpm exec vitest run src/lifecycle/supplier-allowlist.test.ts tests/isolation.test.ts   # PASS
cd ../.. && pnpm --filter @savvy/db typecheck
git add packages/db/src/lifecycle/supplier-allowlist.ts packages/db/src/index.ts packages/db/src/lifecycle/supplier-allowlist.test.ts packages/db/tests/isolation.test.ts
git commit -m "feat(db): supplier-allowlist lifecycle writers + RLS cross-tenant test"
```

---

### Task 5: Agents — allow-list as the 5th auto-send gate + observability

**Files:**
- Modify: `packages/agents/src/functions/supplier-invoice-guard.ts`
- Modify: `packages/agents/src/functions/supplier-invoice-guard.test.ts`

**Interfaces:**
- Consumes: `isRecipientAllowed` (Task 2), `listAllowedDomains` (Task 4).
- Produces: `PriceGuardDeps.loadAllowedDomains: (tenantId: string) => Promise<string[]>`; `PriceGuardDeps.logAudit: (o: { tenantId: string; recipientDomain: string; claimedCents: number; outcome: "sent" | "blocked_not_allowlisted" }) => void`.

**Observability approach:** the handler is a pure DI unit; direct `console.log`/logger calls inside it would pollute unit-test output. So observability is a **dependency** (`logAudit`), injected as a `vi.fn()` no-op in tests and as a real structured emitter in the Inngest wiring — keeping test output pristine and the emit assertable.

- [ ] **Step 1: Write failing tests** — in `packages/agents/src/functions/supplier-invoice-guard.test.ts`, add `loadAllowedDomains: vi.fn().mockResolvedValue([])` and `logAudit: vi.fn()` to `baseDeps` (empty list = current behavior, keeps existing cases green), then add two cases inside `describe("priceGuardHandler", …)`:

```ts
  it("auto-sends when the recipient domain is allow-listed", async () => {
    const deps = baseDeps();
    deps.loadAllowedDomains = vi.fn().mockResolvedValue(["abcsupply.com"]); // recipient ar@abcsupply.com
    await priceGuardHandler(input, deps);
    expect(deps.sendEmail).toHaveBeenCalled();
    expect(deps.createCredit).toHaveBeenCalledWith("t", expect.objectContaining({ status: "sent" }));
  });

  it("drafts (no email) when a non-empty allow-list excludes the recipient domain", async () => {
    const deps = baseDeps();
    deps.loadAllowedDomains = vi.fn().mockResolvedValue(["srs.com"]); // recipient ar@abcsupply.com NOT listed
    const res = await priceGuardHandler(input, deps);
    expect(res.status).toBe("guarded");
    expect(deps.sendEmail).not.toHaveBeenCalled();
    expect(deps.createCredit).toHaveBeenCalledWith("t", expect.objectContaining({ status: "drafted" }));
    expect(deps.raiseDraftCard).toHaveBeenCalled();
  });
```

(The shared `invoice` fixture already has `senderEmail: "ar@abcsupply.com"` and `baseDeps.resolveRecipient` returns `"ar@abcsupply.com"`.)

- [ ] **Step 2: Run to verify fail** — `cd packages/agents && pnpm exec vitest run src/functions/supplier-invoice-guard.test.ts`. Expected: the "drafts when excluded" case FAILS (currently sends).

- [ ] **Step 3: Add the deps** — in `packages/agents/src/functions/supplier-invoice-guard.ts`, add to `PriceGuardDeps`:
```ts
  loadAllowedDomains: (tenantId: string) => Promise<string[]>;
  logAudit: (o: { tenantId: string; recipientDomain: string; claimedCents: number; outcome: "sent" | "blocked_not_allowlisted" }) => void;
```

- [ ] **Step 4: Gate auto-send + audit** — the current block reads:
```ts
    const recipient = deps.resolveRecipient(inv.senderEmail);
    const autoSend =
      shouldAutoSendCredit({ claimedCents, parseConfidence: inv.parseConfidence, allOverageLinesMatched, cfg }) &&
      gate.proceed &&
      recipient !== null;

    if (autoSend) {
      const email = await deps.sendEmail(buildCreditEmail(inv, claimedCents, evidence, recipient!));
```
Change to load the allow-list, add it as a 5th conjunct, and emit an audit event via the `logAudit` dep (NOT a direct logger call — keep the handler pure):
```ts
    const recipient = deps.resolveRecipient(inv.senderEmail);
    const allowedDomains = await deps.loadAllowedDomains(tenantId);
    const allowed = recipient !== null && isRecipientAllowed(recipient, allowedDomains);
    const domainOf = (e: string) => e.slice(e.lastIndexOf("@") + 1);
    const autoSend =
      shouldAutoSendCredit({ claimedCents, parseConfidence: inv.parseConfidence, allOverageLinesMatched, cfg }) &&
      gate.proceed &&
      recipient !== null &&
      allowed;

    if (autoSend) {
      const email = await deps.sendEmail(buildCreditEmail(inv, claimedCents, evidence, recipient!));
      deps.logAudit({ tenantId, recipientDomain: domainOf(recipient!), claimedCents, outcome: "sent" });
```
And in the draft branch (just before `createCredit(... status:"drafted" ...)`), audit a recipient blocked by a non-empty list:
```ts
    if (recipient !== null && allowedDomains.length > 0 && !allowed) {
      deps.logAudit({ tenantId, recipientDomain: domainOf(recipient), claimedCents, outcome: "blocked_not_allowlisted" });
    }
```
Add import at the top: `isRecipientAllowed` from `@savvy/core`.

- [ ] **Step 5: Wire the real deps in the Inngest fn** — in the deps object that supplies `resolveRecipient`, add:
```ts
        loadAllowedDomains: (t) => listAllowedDomains(t),
        logAudit: (o) => console.log(JSON.stringify({ evt: "credit-request", ...o })),
```
Import `listAllowedDomains` from `@savvy/db`. (`console.log` is captured by the Inngest run logs; structured JSON keeps it queryable. This is the ONLY place a raw logger call lives — the pure handler stays side-effect-free via the dep.)

- [ ] **Step 6: Verify pass + full suite + typecheck + commit**

```bash
cd packages/agents && pnpm exec vitest run src/functions/supplier-invoice-guard.test.ts   # all PASS (13 cases)
pnpm --filter @savvy/agents test                                                            # full agents suite green
cd ../.. && pnpm --filter @savvy/agents typecheck
git add packages/agents/src/functions/supplier-invoice-guard.ts packages/agents/src/functions/supplier-invoice-guard.test.ts
git commit -m "feat(agents): supplier allow-list gate + auto-send observability logs"
```

---

### Task 6: Web — `settings/suppliers` allow-list management UI

**Files:**
- Create: `apps/web/src/lib/supplier-allowlist-queries.ts`
- Create: `apps/web/src/lib/supplier-allowlist-actions.ts`
- Create: `apps/web/src/app/(app)/settings/suppliers/page.tsx`
- Create: `apps/web/src/app/(app)/settings/suppliers/SuppliersClient.tsx`
- Modify: `apps/web/src/app/(app)/settings/page.tsx` (nav entry)

**Interfaces:**
- Consumes: `listSupplierAllowlist`, `addSupplierAllowlistDomain`, `removeSupplierAllowlistDomain` (Task 4).
- Produces: none (UI). Validated by typecheck + lint.

- [ ] **Step 1: Query loader** — create `apps/web/src/lib/supplier-allowlist-queries.ts`:
```ts
import "server-only";
import { listSupplierAllowlist } from "@savvy/db";
import { getTenantId } from "./tenant";

export async function getSupplierAllowlist() {
  const tenantId = await getTenantId();
  return listSupplierAllowlist(tenantId);
}
```

- [ ] **Step 2: Server actions** — create `apps/web/src/lib/supplier-allowlist-actions.ts`:
```ts
"use server";
import { revalidatePath } from "next/cache";
import { addSupplierAllowlistDomain, removeSupplierAllowlistDomain } from "@savvy/db";
import { getTenantId } from "./tenant";

// Accept a domain or a full email; store just the lowercased domain part.
function toDomain(raw: string): string | null {
  const v = raw.trim().toLowerCase();
  const dom = v.includes("@") ? v.slice(v.lastIndexOf("@") + 1) : v;
  // basic domain shape: label.tld, no spaces/@
  return /^[^\s@]+\.[^\s@]+$/.test(dom) ? dom : null;
}

export async function addSupplierDomain(formData: FormData): Promise<{ error?: string }> {
  const tenantId = await getTenantId();
  const domain = toDomain(String(formData.get("domain") ?? ""));
  if (!domain) return { error: "Enter a valid domain (e.g. abcsupply.com)." };
  const label = String(formData.get("label") ?? "").trim() || null;
  await addSupplierAllowlistDomain(tenantId, { domain, label });
  revalidatePath("/settings/suppliers");
  return {};
}

export async function removeSupplierDomain(id: string): Promise<void> {
  const tenantId = await getTenantId();
  await removeSupplierAllowlistDomain(tenantId, id);
  revalidatePath("/settings/suppliers");
}
```

- [ ] **Step 3: Page (server component)** — create `apps/web/src/app/(app)/settings/suppliers/page.tsx`:
```tsx
import { getSupplierAllowlist } from "@/lib/supplier-allowlist-queries";
import { SuppliersClient } from "./SuppliersClient";

export const dynamic = "force-dynamic";

export default async function SuppliersPage() {
  const rows = await getSupplierAllowlist();
  return (
    <div className="space-y-6">
      <SuppliersClient rows={rows} />
    </div>
  );
}
```

- [ ] **Step 4: Client component** — create `apps/web/src/app/(app)/settings/suppliers/SuppliersClient.tsx` (`"use client"`): render the `PageHeader` (eyebrow "Configuration", title "Supplier auto-send allow-list"), an explanatory line — "Empty = credit requests auto-send to any resolved supplier address. Add domains to restrict auto-send to only those suppliers." — an add form (domain input + optional label + submit that calls `addSupplierDomain`), and a list of rows (`domain`, `label`, `createdAt`) each with a Remove button calling `removeSupplierDomain(row.id)`. Show the returned `{ error }` inline. Mirror the structure/styles of `apps/web/src/app/(app)/settings/price-book/PriceBookClient.tsx` (read it first for the exact form/list/table conventions and imports). Add `data-testid="supplier-allowlist"` on the list container.

- [ ] **Step 5: Nav entry** — in `apps/web/src/app/(app)/settings/page.tsx`, add to the `SECTIONS` array:
```ts
  { href: "/settings/suppliers", label: "Supplier allow-list", desc: "Restrict which supplier domains receive automated credit requests." },
```

- [ ] **Step 6: Typecheck + lint + commit**

```bash
pnpm --filter @savvy/web typecheck && pnpm --filter @savvy/web lint   # clean (pre-existing warnings OK)
git add apps/web/src/lib/supplier-allowlist-queries.ts apps/web/src/lib/supplier-allowlist-actions.ts "apps/web/src/app/(app)/settings/suppliers/" "apps/web/src/app/(app)/settings/page.tsx"
git commit -m "feat(web): settings/suppliers allow-list management UI"
```

---

### Task 7: E2e — allow-list restricts auto-send to `drafted`

**Files:**
- Modify: `apps/web/tests/e2e/supplier-invoice-guard.spec.ts`

**Interfaces:** consumes the full pipeline (Tasks 2–5).

- [ ] **Step 1: Add a restrict-path case** — in `apps/web/tests/e2e/supplier-invoice-guard.spec.ts`, add a test (its own isolated tenant, mirroring the existing guard test's seeding) that: seeds a `supplier_allowlist` row with a domain that does NOT match the stubbed guard invoice's sender (`billing@abcsupply.com`) — e.g. insert `{ tenantId, domain: "srs.com" }` via `adminDb.insert(supplierAllowlist)`; POST the forwarded guard invoice; `expect.poll` the `supplier_invoice` until `status="guarded"`; assert the resulting `credit_request` has `status="drafted"` (recipient blocked by the non-matching allow-list), NOT `"sent"`. Import `supplierAllowlist` from `@savvy/db`. Clean up the row in teardown.

  (The existing "auto-sent" test stays unchanged — its tenant has an empty allow-list, so `sent` still holds.)

- [ ] **Step 2: Commit**

```bash
git add apps/web/tests/e2e/supplier-invoice-guard.spec.ts
git commit -m "test(e2e): non-matching supplier allow-list drafts instead of auto-sending"
```

- [ ] **Step 3: Open PR + watch + merge**

```bash
git push -u origin <branch>
gh pr create --base main --title "feat(security): supplier auto-send allow-list + observability + canvass gitignore" --body "…"
gh pr checks <n> --watch
gh pr merge <n> --squash --delete-branch
```
(Then run migrations 0050 + 0051 on prod.)

---

## Definition of Done

- [ ] `.gitignore` blocks `canvass-app/` + `packages/db/src/setup-canvass.ts`.
- [ ] `isRecipientAllowed` in `@savvy/core`, unit-tested (empty=allow, non-empty=restrict, case-insensitive, malformed=block).
- [ ] `supplier_allowlist` table + migration 0051 + RLS + cross-tenant test green.
- [ ] Lifecycle writers (list/listAllowedDomains/add/remove), tested.
- [ ] Handler gates auto-send on the allow-list (5th gate); empty preserves current behavior; non-matching drafts; observability logs on send + block.
- [ ] `settings/suppliers` UI (list/add/remove) + nav entry; typecheck + lint clean.
- [ ] E2e: empty list → `sent` (existing) and non-matching list → `drafted` (new). Full agents suite + packages vitest green.

## Self-Review

- **Spec coverage:** gitignore (Task 1) ✓; `isRecipientAllowed` empty=allow (Task 2) ✓; table+0051+RLS (Task 3, 4 step 5) ✓; lifecycle (Task 4) ✓; handler 5th gate + observability (Task 5) ✓; settings UI (Task 6) ✓; e2e restrict + existing sent (Task 7) ✓. Local `setup-canvass` CSPRNG + key rotation intentionally out of scope (untracked/ops).
- **Type consistency:** `isRecipientAllowed(recipientEmail, allowedDomains)→boolean` defined Task 2, consumed Task 5; `listAllowedDomains(tenantId)→string[]` defined Task 4, wired Task 5; `PriceGuardDeps.loadAllowedDomains` signature matches the wiring; `supplierAllowlist` columns consistent across Tasks 3/4/7; settings actions consume Task 4 writers.
- **Deferred:** `setup-canvass.ts` CSPRNG (local), tenant key rotation (ops), AI recipient extraction, richer supplier directory.
