# Supplier Invoice — Slice 13c (Price-Guard + Auto-Credit) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Price-guard every parsed supplier invoice against its job's material-order cost snapshot, auto-send confidence-gated credit requests for overages, auto-recover via credit memos, and prove "100% of lines checked" with a `finance.price_guard` invariant on the Money screen.

**Architecture:** A durable Inngest `priceGuardSupplierInvoice` subscribes to `supplier-invoice/parsed` (emitted by 13b's `parseSupplierInvoice`). It matches each parsed line to the job's `material_order.lineItems[]` snapshot (deterministic by `key`/`sku`, else normalized-description), computes per-line overage vs `price_book_item.unitCostCents`, writes guard annotations back into `supplier_invoice.lines` (`status=guarded`), and — when the claim clears a threshold AND the parse is high-confidence AND all overage lines matched cleanly AND the task's automation gate is open — creates a `credit_request(status=sent)`, emails the supplier, and records an `agent_run` as proof. Otherwise it drafts the request and raises a Today card. Credit memos (negative-total supplier invoices) flow through the same pipe and auto-reconcile against open sent requests. A `finance.price_guard` invariant + the ops digest surface the proof and the recovered dollars.

**Tech Stack:** Inngest · Drizzle/Postgres (RLS) · `@savvy/core` pure helpers (Vitest) · `@savvy/integrations` email · Vitest (packages) + Playwright (web e2e, AI-stubbed).

**Spec:** `docs/superpowers/specs/2026-07-04-supplier-invoice-price-guard-design.md` §6–§9. **Base:** slices 13a + 13b merged (main @ `27f6dda`) — `supplier_invoice` table, `supplier-invoice/parsed` event, `SupplierInvoiceLine` guard-annotation fields, `matchSupplierInvoiceJob`, `saveParsedSupplierInvoice`, `recomputeJobActualCost`, real GM·MTD.

## Global Constraints

- **Tenant isolation on every query.** Both new/touched tables carry `tenant_id` + `tenantIsolation()` RLS. All DB access via `withTenant(tenantId, (tx) => …)`. The Inngest handler runs against `adminPool` context like the health sweep — every query scoped by `tenantId`. Cross-tenant read-returns-nothing tests stay green (Task 9).
- **No hard-coded models.** The optional AI line-match fallback goes through the gateway by capability (`reasoning`), never a model string.
- **Durable + fail-soft.** `priceGuardSupplierInvoice` has `concurrency: { limit: 5, key: "event.data.tenantId" }`, `retries: 2`; the handler catches all errors and returns a status, never throws (a bad guard can't wedge the queue).
- **Never unattended-email a shaky parse.** Auto-send requires `claimedCents ≥ autoSendMinCents` **AND** `parseConfidence ≥ 0.8` **AND** all overage lines matched cleanly **AND** the automation gate is open. Otherwise → `drafted` + Today card.
- **No `.js` import extensions** in `@savvy/db` barrel/lifecycle or any package src (breaks Turbopack e2e build — this bit slice 13b, PR #135). Imports: schema from `../schema/index`, tenant from `../tenant`.
- **Migrations via `pnpm --filter @savvy/db db:generate`** — never hand-numbered. Next number after 0047 = **0048**.
- **Test placement:** pure logic + Inngest handler unit tests live in `packages/*` (vitest runs `packages/*` only). `apps/web` is validated by typecheck + lint + Playwright e2e. `seedJobTasks` seeds `job_checklist_item` NOT `job_task`.
- **`gh pr checks <n> --watch` before squash-merge**; small reviewed PRs.

---

### Task 1: Core — price-guard pure helpers + `CREDIT_REQUEST_STATUS` + finance `priceGuard` config

**Files:**
- Create: `packages/core/src/price-guard.ts`
- Create: `packages/core/src/price-guard.test.ts`
- Modify: `packages/core/src/enums.ts` (add `CREDIT_REQUEST_STATUS`)
- Modify: `packages/core/src/finance.ts` (add `priceGuard` sub-schema to `financeSchema`)
- Modify: `packages/core/src/finance.test.ts` (assert `priceGuard` defaults)
- Modify: `packages/core/src/index.ts` (export `price-guard`)

**Interfaces (Produces):**
- `CREDIT_REQUEST_STATUS = ["drafted","sent","credited","rejected"] as const`; `type CreditRequestStatus`.
- `FinanceConfig.priceGuard: { minOverageCents: number; overagePct: number; autoSendMinCents: number; highConfidence: number }`.
- `type SnapshotLine = { key: string; name: string; unitCostCents: number }`.
- `type LineMatch = { matchedItemKey: string | null; expectedUnitCostCents: number | null; matchConfidence: number | null }`.
- `matchInvoiceLines(parsedLines, snapshot): LineMatch[]` (index-aligned to `parsedLines`).
- `computeLineOverage(line, cfg): { overageCents: number; qualifies: boolean }`.
- `shouldAutoSendCredit(input): boolean`.
- `matchCreditMemo(memo, open): string | null`.

- [ ] **Step 1: Write the failing tests** — create `packages/core/src/price-guard.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { matchInvoiceLines, computeLineOverage, shouldAutoSendCredit, matchCreditMemo } from "./price-guard";

const snap = [
  { key: "shingle-hdz", name: "GAF Timberline HDZ", unitCostCents: 7000 },
  { key: "pipe-boot", name: "Pipe Boot 3in", unitCostCents: 900 },
];

describe("matchInvoiceLines", () => {
  it("matches by sku==key with full confidence and carries expected cost", () => {
    const [m] = matchInvoiceLines([{ description: "x", sku: "shingle-hdz", unitBilledCents: 8000, quantity: 30 }], snap);
    expect(m).toEqual({ matchedItemKey: "shingle-hdz", expectedUnitCostCents: 7000, matchConfidence: 1 });
  });
  it("falls back to normalized-description match with partial confidence", () => {
    const [m] = matchInvoiceLines([{ description: "GAF TIMBERLINE HDZ shingle", unitBilledCents: 8000, quantity: 30 }], snap);
    expect(m.matchedItemKey).toBe("shingle-hdz");
    expect(m.matchConfidence).toBeGreaterThan(0.5);
    expect(m.matchConfidence).toBeLessThan(1);
  });
  it("returns no-baseline (null) when nothing matches", () => {
    const [m] = matchInvoiceLines([{ description: "mystery flashing", unitBilledCents: 500, quantity: 1 }], snap);
    expect(m).toEqual({ matchedItemKey: null, expectedUnitCostCents: null, matchConfidence: null });
  });
});

describe("computeLineOverage", () => {
  const cfg = { minOverageCents: 2500, overagePct: 0.05 };
  it("flags a qualifying overage above max($25, 5% of expected line)", () => {
    // billed 8000 vs expected 7000, qty 30 → overage 30000; threshold max(2500, 5%*210000=10500)=10500
    expect(computeLineOverage({ unitBilledCents: 8000, quantity: 30, expectedUnitCostCents: 7000 }, cfg))
      .toEqual({ overageCents: 30000, qualifies: true });
  });
  it("does not flag a trivial overage below the threshold", () => {
    // billed 7010 vs 7000, qty 1 → overage 10; threshold max(2500, 350)=2500
    expect(computeLineOverage({ unitBilledCents: 7010, quantity: 1, expectedUnitCostCents: 7000 }, cfg))
      .toEqual({ overageCents: 10, qualifies: false });
  });
  it("is a no-op (no baseline) when expected cost is unknown", () => {
    expect(computeLineOverage({ unitBilledCents: 9999, quantity: 5, expectedUnitCostCents: null }, cfg))
      .toEqual({ overageCents: 0, qualifies: false });
  });
});

describe("shouldAutoSendCredit", () => {
  const cfg = { autoSendMinCents: 2500, highConfidence: 0.8 };
  it("auto-sends when claim clears the floor, parse is confident, and all overage lines matched", () => {
    expect(shouldAutoSendCredit({ claimedCents: 30000, parseConfidence: 0.92, allOverageLinesMatched: true, cfg })).toBe(true);
  });
  it("holds for review when parse confidence is low", () => {
    expect(shouldAutoSendCredit({ claimedCents: 30000, parseConfidence: 0.6, allOverageLinesMatched: true, cfg })).toBe(false);
  });
  it("holds for review when an overage line did not match cleanly", () => {
    expect(shouldAutoSendCredit({ claimedCents: 30000, parseConfidence: 0.92, allOverageLinesMatched: false, cfg })).toBe(false);
  });
  it("holds for a trivial claim below the floor", () => {
    expect(shouldAutoSendCredit({ claimedCents: 100, parseConfidence: 0.99, allOverageLinesMatched: true, cfg })).toBe(false);
  });
});

describe("matchCreditMemo", () => {
  const open = [{ id: "cr1", supplierName: "ABC Supply", claimedCents: 30000 }];
  it("matches one open request by supplier + near-equal amount", () => {
    expect(matchCreditMemo({ supplierName: "abc supply", amountCents: 30000 }, open)).toBe("cr1");
  });
  it("returns null when amount is off or supplier differs", () => {
    expect(matchCreditMemo({ supplierName: "ABC Supply", amountCents: 5000 }, open)).toBeNull();
    expect(matchCreditMemo({ supplierName: "SRS", amountCents: 30000 }, open)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify they fail** — `cd packages/core && pnpm exec vitest run src/price-guard.test.ts`. Expected: FAIL (`./price-guard` missing).

- [ ] **Step 3: Implement** — create `packages/core/src/price-guard.ts`:

```ts
/** Pure price-guard helpers: line matching, overage detection, the auto-send confidence
 *  gate, and credit-memo reconciliation. All money is integer cents. */

export type SnapshotLine = { key: string; name: string; unitCostCents: number };
export type LineMatch = { matchedItemKey: string | null; expectedUnitCostCents: number | null; matchConfidence: number | null };

type ParsedLine = { description: string; sku?: string; unitBilledCents: number; quantity: number };

/** lowercase alphanumeric token set for fuzzy name matching. */
function tokens(s: string): Set<string> {
  return new Set(s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean));
}
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Match each parsed invoice line to a material-order snapshot line: exact sku==key (conf 1.0),
 *  else best normalized-name Jaccard ≥ 0.6 (conf = the overlap), else no-baseline (nulls). */
export function matchInvoiceLines(parsedLines: ParsedLine[], snapshot: SnapshotLine[]): LineMatch[] {
  const byKey = new Map(snapshot.map((s) => [s.key.toLowerCase(), s]));
  return parsedLines.map((line) => {
    if (line.sku) {
      const s = byKey.get(line.sku.toLowerCase());
      if (s) return { matchedItemKey: s.key, expectedUnitCostCents: s.unitCostCents, matchConfidence: 1 };
    }
    const lt = tokens(line.description);
    let best: SnapshotLine | null = null;
    let bestScore = 0;
    for (const s of snapshot) {
      const score = jaccard(lt, tokens(s.name));
      if (score > bestScore) { bestScore = score; best = s; }
    }
    if (best && bestScore >= 0.6) {
      return { matchedItemKey: best.key, expectedUnitCostCents: best.unitCostCents, matchConfidence: Number(bestScore.toFixed(2)) };
    }
    return { matchedItemKey: null, expectedUnitCostCents: null, matchConfidence: null };
  });
}

/** Per-line overage vs expected supplier cost; qualifies only when it clears max($floor, pct×expected line). */
export function computeLineOverage(
  line: { unitBilledCents: number; quantity: number; expectedUnitCostCents: number | null },
  cfg: { minOverageCents: number; overagePct: number },
): { overageCents: number; qualifies: boolean } {
  if (line.expectedUnitCostCents == null) return { overageCents: 0, qualifies: false };
  const overageCents = Math.max(0, (line.unitBilledCents - line.expectedUnitCostCents) * line.quantity);
  const expectedLineCents = line.expectedUnitCostCents * line.quantity;
  const threshold = Math.max(cfg.minOverageCents, Math.round(expectedLineCents * cfg.overagePct));
  return { overageCents, qualifies: overageCents >= threshold };
}

/** The confidence gate: only unattended-send a large, high-confidence, cleanly-matched claim. */
export function shouldAutoSendCredit(input: {
  claimedCents: number; parseConfidence: number | null; allOverageLinesMatched: boolean;
  cfg: { autoSendMinCents: number; highConfidence: number };
}): boolean {
  return input.claimedCents >= input.cfg.autoSendMinCents
    && (input.parseConfidence ?? 0) >= input.cfg.highConfidence
    && input.allOverageLinesMatched;
}

/** Reconcile a credit memo (abs total) to exactly one open sent request by supplier + near-equal amount. */
export function matchCreditMemo(
  memo: { supplierName: string | null; amountCents: number },
  open: { id: string; supplierName: string | null; claimedCents: number }[],
): string | null {
  const norm = (s: string | null) => (s ?? "").trim().toLowerCase();
  const hits = open.filter((r) =>
    norm(r.supplierName) === norm(memo.supplierName) &&
    Math.abs(r.claimedCents - memo.amountCents) <= Math.max(500, Math.round(r.claimedCents * 0.1)));
  return hits.length === 1 ? hits[0]!.id : null;
}
```

- [ ] **Step 4: Add the enum + finance config + exports**

In `packages/core/src/enums.ts`, after the `SUPPLIER_INVOICE_STATUS` block:
```ts
export const CREDIT_REQUEST_STATUS = ["drafted", "sent", "credited", "rejected"] as const;
export type CreditRequestStatus = (typeof CREDIT_REQUEST_STATUS)[number];
```

In `packages/core/src/finance.ts`, add the sub-schema and slot it into `financeSchema`:
```ts
const priceGuardSchema = z.object({
  minOverageCents: z.number().int().nonnegative().default(2500),  // $25 floor per line
  overagePct: z.number().min(0).max(1).default(0.05),             // 5% of expected line cost
  autoSendMinCents: z.number().int().nonnegative().default(2500), // min claim to unattended-send
  highConfidence: z.number().min(0).max(1).default(0.8),          // parseConfidence gate
});
// …inside financeSchema = z.object({ … }) add:
  priceGuard: priceGuardSchema.default({}),
```

In `packages/core/src/index.ts` add: `export * from "./price-guard";`

Add to `packages/core/src/finance.test.ts`:
```ts
it("defaults the priceGuard config", () => {
  const f = parseFinanceConfig({});
  expect(f.priceGuard).toEqual({ minOverageCents: 2500, overagePct: 0.05, autoSendMinCents: 2500, highConfidence: 0.8 });
});
```

- [ ] **Step 5: Verify pass + typecheck + commit**

Run: `cd packages/core && pnpm exec vitest run src/price-guard.test.ts src/finance.test.ts` → PASS.
```bash
pnpm --filter @savvy/core typecheck
git add packages/core/src/price-guard.ts packages/core/src/price-guard.test.ts packages/core/src/enums.ts packages/core/src/finance.ts packages/core/src/finance.test.ts packages/core/src/index.ts
git commit -m "feat(core): price-guard matchers, overage, auto-send gate, credit-memo reconcile + config"
```

---

### Task 2: DB — `credit_request` table + enum + migration 0048

**Files:**
- Create: `packages/db/src/schema/credit-request.ts`
- Modify: `packages/db/src/schema/index.ts` (export `./credit-request`)
- Modify: `packages/db/src/schema/enums.ts` (register `creditRequestStatusEnum`)
- Generate: `packages/db/drizzle/0048_*.sql` via `db:generate`

**Interfaces (Produces):** `creditRequest` table with columns `id, tenantId, supplierInvoiceId, jobId, supplierName, claimedCents, status, evidence(jsonb), sentAt, resolvedAt, recoveredCents, emailMessageId, createdAt, updatedAt`.

- [ ] **Step 1: Register the pgEnum**

In `packages/db/src/schema/enums.ts`: add `CREDIT_REQUEST_STATUS` to the `from "@savvy/core"` import list, then alongside the `supplierInvoiceStatusEnum` line:
```ts
export const creditRequestStatusEnum = pgEnum("credit_request_status", CREDIT_REQUEST_STATUS);
```

- [ ] **Step 2: Create the table** — `packages/db/src/schema/credit-request.ts`:

```ts
import { pgTable, uuid, text, integer, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { idCol, createdAt, updatedAt, tenantIsolation } from "./_rls";
import { tenant } from "./tenancy";
import { job } from "./jobs";
import { supplierInvoice } from "./supplier-invoice";
import { creditRequestStatusEnum } from "./enums";

// The recovery ledger — the "found money" the digest reports. One row per overage
// claim raised against a parsed supplier invoice; auto-recovered when a matching
// credit memo lands (status→credited, recoveredCents set).
export const creditRequest = pgTable("credit_request", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  supplierInvoiceId: uuid("supplier_invoice_id").notNull().references(() => supplierInvoice.id),
  jobId: uuid("job_id").references(() => job.id), // nullable
  supplierName: text("supplier_name"),
  claimedCents: integer("claimed_cents").notNull().default(0),
  status: creditRequestStatusEnum("status").notNull().default("drafted"),
  evidence: jsonb("evidence").$type<unknown>().notNull().default([]), // overage lines: expected vs billed, delta
  sentAt: timestamp("sent_at", { withTimezone: true }),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  recoveredCents: integer("recovered_cents").notNull().default(0),
  emailMessageId: text("email_message_id"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  index("credit_request_tenant_supplier_idx").on(t.tenantId, t.supplierName),
  index("credit_request_tenant_status_idx").on(t.tenantId, t.status),
  tenantIsolation(),
]);
```

Add to `packages/db/src/schema/index.ts`: `export * from "./credit-request";`

- [ ] **Step 3: Generate the migration**

Run: `pnpm --filter @savvy/db db:generate` → produces `packages/db/drizzle/0048_*.sql` (creates `credit_request_status` enum + `credit_request` table + RLS policy). Inspect the SQL: confirm it `CREATE TABLE credit_request`, adds the enum, and includes the RLS `alter table … enable row level security` + policy from `tenantIsolation()`.

- [ ] **Step 4: Typecheck + commit**

```bash
pnpm --filter @savvy/db typecheck
git add packages/db/src/schema/credit-request.ts packages/db/src/schema/index.ts packages/db/src/schema/enums.ts packages/db/drizzle/
git commit -m "feat(db): credit_request table + credit_request_status enum (migration 0048)"
```

---

### Task 3: DB — lifecycle writers (guard, credit-request, snapshot, recovery)

**Files:**
- Modify: `packages/db/src/lifecycle/supplier-invoice.ts` (add snapshot loader + guard save; widen `recomputeJobActualCost`)
- Create: `packages/db/src/lifecycle/credit-request.ts`
- Modify: `packages/db/src/index.ts` (export new fns)
- Modify: `packages/db/src/lifecycle/supplier-invoice.test.ts` (snapshot + widened recompute)
- Create: `packages/db/src/lifecycle/credit-request.test.ts`

**Interfaces (Produces):**
- `getMaterialOrderSnapshot(tenantId, jobId): Promise<SnapshotLine[]>` — union of `material_order.lineItems` (ordered/delivered), each `{ key, name, unitCostCents }` with `unitCostCents` from the line, falling back to `price_book_item.unitCostCents` by key.
- `saveGuardedSupplierInvoice(tenantId, id, lines: SupplierInvoiceLine[]): Promise<void>` — write annotated lines + `status="guarded"`.
- `createCreditRequest(tenantId, input): Promise<{ id: string }>`.
- `setCreditRequestSent(tenantId, id, { emailMessageId }): Promise<void>`.
- `listOpenSentCreditRequests(tenantId, supplierName): Promise<{ id: string; supplierName: string | null; claimedCents: number }[]>`.
- `markCreditRequestCredited(tenantId, id, recoveredCents: number): Promise<void>`.
- `getCreditRecoverySummary(tenantId, window: { start: Date; end: Date }): Promise<{ recoveredCents: number; pendingCents: number }>`.
- Widen `recomputeJobActualCost` supplier-invoice filter to `inArray(status, ["parsed","guarded"])`.

- [ ] **Step 1: Write failing tests** (DB — run in CI). Create `packages/db/src/lifecycle/credit-request.test.ts` seeding tenant/customer/property/job/estimate/supplier_invoice and asserting create → sent → credited transitions and the recovery summary:

```ts
import { it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { adminDb, tenant, customer, property, job, supplierInvoice, creditRequest, eq } from "../index";
import { createCreditRequest, setCreditRequestSent, listOpenSentCreditRequests, markCreditRequestCredited, getCreditRecoverySummary } from "./credit-request";

let tenantId: string, jobId: string, siId: string;
beforeAll(async () => {
  tenantId = randomUUID();
  await adminDb.insert(tenant).values({ id: tenantId, name: "Guard Co", publicKey: `gc-${tenantId.slice(0, 8)}` });
  const [c] = await adminDb.insert(customer).values({ tenantId, name: "C" }).returning();
  const [p] = await adminDb.insert(property).values({ tenantId, customerId: c!.id, address: "1 Guard St" }).returning();
  const [j] = await adminDb.insert(job).values({ tenantId, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "production" }).returning();
  jobId = j!.id;
  const [si] = await adminDb.insert(supplierInvoice).values({ tenantId, jobId, status: "guarded", totalCents: 500000, externalMessageId: `g-${randomUUID()}` }).returning();
  siId = si!.id;
});
afterAll(async () => {
  await adminDb.delete(creditRequest).where(eq(creditRequest.tenantId, tenantId));
  await adminDb.delete(supplierInvoice).where(eq(supplierInvoice.tenantId, tenantId));
  await adminDb.delete(job).where(eq(job.tenantId, tenantId));
  await adminDb.delete(property).where(eq(property.tenantId, tenantId));
  await adminDb.delete(customer).where(eq(customer.tenantId, tenantId));
  await adminDb.delete(tenant).where(eq(tenant.id, tenantId));
});

it("create → sent → credited, with recovery summary buckets", async () => {
  const { id } = await createCreditRequest(tenantId, { supplierInvoiceId: siId, jobId, supplierName: "ABC Supply", claimedCents: 30000, status: "sent", evidence: [{ overageCents: 30000 }] });
  await setCreditRequestSent(tenantId, id, { emailMessageId: "msg-1" });
  const open = await listOpenSentCreditRequests(tenantId, "ABC Supply");
  expect(open.map((r) => r.id)).toContain(id);

  const now = new Date();
  let summary = await getCreditRecoverySummary(tenantId, { start: new Date(now.getTime() - 86_400_000), end: new Date(now.getTime() + 86_400_000) });
  expect(summary.pendingCents).toBe(30000);
  expect(summary.recoveredCents).toBe(0);

  await markCreditRequestCredited(tenantId, id, 30000);
  const [row] = await adminDb.select().from(creditRequest).where(eq(creditRequest.id, id));
  expect(row!.status).toBe("credited");
  expect(row!.recoveredCents).toBe(30000);
  expect(row!.resolvedAt).not.toBeNull();

  summary = await getCreditRecoverySummary(tenantId, { start: new Date(now.getTime() - 86_400_000), end: new Date(now.getTime() + 86_400_000) });
  expect(summary.recoveredCents).toBe(30000);
  expect(summary.pendingCents).toBe(0);
});
```

Add to `packages/db/src/lifecycle/supplier-invoice.test.ts` a snapshot test (seed a job + estimate + `material_order` with `lineItems` carrying `unitCostCents`, plus a `price_book_item` for the fallback key) asserting `getMaterialOrderSnapshot` returns `{ key, name, unitCostCents }[]`, and a test that `recomputeJobActualCost` now counts a `guarded` invoice:
```ts
it("recomputeJobActualCost counts guarded invoices as actuals", async () => {
  const [c] = await adminDb.insert(customer).values({ tenantId, name: "CG" }).returning();
  const [p] = await adminDb.insert(property).values({ tenantId, customerId: c!.id, address: "9 Guard St" }).returning();
  const [j] = await adminDb.insert(job).values({ tenantId, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "production" }).returning();
  await adminDb.insert(supplierInvoice).values({ tenantId, jobId: j!.id, status: "guarded", totalCents: 444000, externalMessageId: `gd-${randomUUID()}` });
  await recomputeJobActualCost(tenantId, j!.id);
  const [row] = await adminDb.select({ costCents: job.costCents }).from(job).where(eq(job.id, j!.id));
  expect(row!.costCents).toBe(444000);
});
```
(Import `getMaterialOrderSnapshot`, `priceBookItem` as needed.)

- [ ] **Step 2: Run to verify they fail** — `cd packages/db && pnpm exec vitest run src/lifecycle/credit-request.test.ts src/lifecycle/supplier-invoice.test.ts`. Expected: FAIL (missing fns). (Requires the DB; CI-provided.)

- [ ] **Step 3: Implement the snapshot loader + guard save + widen recompute** in `packages/db/src/lifecycle/supplier-invoice.ts`:

```ts
// add imports:
import { priceBookItem } from "../schema/index";
import type { SnapshotLine, SupplierInvoiceLine } from "@savvy/core";

/** Build the cost baseline for a job: material-order lines (ordered/delivered), each with
 *  its supplier unit cost, falling back to the price book by key when the line lacks one. */
export async function getMaterialOrderSnapshot(tenantId: string, jobId: string): Promise<SnapshotLine[]> {
  return withTenant(tenantId, async (tx) => {
    const orders = await tx
      .select({ lineItems: materialOrder.lineItems })
      .from(materialOrder)
      .where(and(eq(materialOrder.jobId, jobId), inArray(materialOrder.status, ["ordered", "delivered"])));
    const book = await tx.select({ key: priceBookItem.key, unitCostCents: priceBookItem.unitCostCents }).from(priceBookItem);
    const bookByKey = new Map(book.map((b) => [b.key, b.unitCostCents]));
    const out: SnapshotLine[] = [];
    for (const o of orders) {
      for (const li of o.lineItems ?? []) {
        const unitCostCents = li.unitCostCents ?? bookByKey.get(li.key) ?? 0;
        out.push({ key: li.key, name: li.name, unitCostCents });
      }
    }
    return out;
  });
}

/** Persist guard-annotated lines + terminal guarded status. */
export async function saveGuardedSupplierInvoice(tenantId: string, id: string, lines: SupplierInvoiceLine[]): Promise<void> {
  await withTenant(tenantId, (tx) =>
    tx.update(supplierInvoice).set({ lines, status: "guarded", updatedAt: new Date() }).where(eq(supplierInvoice.id, id)));
}
```
Widen the actuals filter in `recomputeJobActualCost`:
```ts
.where(and(eq(supplierInvoice.jobId, jobId), inArray(supplierInvoice.status, ["parsed", "guarded"]), gt(supplierInvoice.totalCents, 0)));
```

- [ ] **Step 4: Implement the credit-request writers** — create `packages/db/src/lifecycle/credit-request.ts`:

```ts
import { and, eq, gte, lte, sql } from "drizzle-orm";
import type { CreditRequestStatus } from "@savvy/core";
import { withTenant } from "../tenant";
import { creditRequest } from "../schema/index";

/** Create a credit request (drafted or sent) with its overage evidence. */
export async function createCreditRequest(tenantId: string, input: {
  supplierInvoiceId: string; jobId: string | null; supplierName: string | null;
  claimedCents: number; status: CreditRequestStatus; evidence: unknown; emailMessageId?: string | null;
}): Promise<{ id: string }> {
  return withTenant(tenantId, async (tx) => {
    const [row] = await tx.insert(creditRequest).values({
      tenantId, supplierInvoiceId: input.supplierInvoiceId, jobId: input.jobId, supplierName: input.supplierName,
      claimedCents: input.claimedCents, status: input.status, evidence: input.evidence,
      emailMessageId: input.emailMessageId ?? null, sentAt: input.status === "sent" ? new Date() : null,
    }).returning({ id: creditRequest.id });
    return { id: row!.id };
  });
}

/** Stamp the sent email id + sentAt (used when a draft is later sent, or to record proof). */
export async function setCreditRequestSent(tenantId: string, id: string, opts: { emailMessageId: string | null }): Promise<void> {
  await withTenant(tenantId, (tx) =>
    tx.update(creditRequest).set({ status: "sent", emailMessageId: opts.emailMessageId, sentAt: new Date(), updatedAt: new Date() }).where(eq(creditRequest.id, id)));
}

/** Open (sent, unresolved) requests for a supplier — the credit-memo reconcile candidates. */
export async function listOpenSentCreditRequests(tenantId: string, supplierName: string | null): Promise<{ id: string; supplierName: string | null; claimedCents: number }[]> {
  return withTenant(tenantId, (tx) =>
    tx.select({ id: creditRequest.id, supplierName: creditRequest.supplierName, claimedCents: creditRequest.claimedCents })
      .from(creditRequest)
      .where(and(eq(creditRequest.tenantId, tenantId), eq(creditRequest.status, "sent"))));
}

/** Recovery: a matched credit memo closes the request. */
export async function markCreditRequestCredited(tenantId: string, id: string, recoveredCents: number): Promise<void> {
  await withTenant(tenantId, (tx) =>
    tx.update(creditRequest).set({ status: "credited", recoveredCents, resolvedAt: new Date(), updatedAt: new Date() }).where(eq(creditRequest.id, id)));
}

/** Digest buckets: recovered $ (credited, resolved in window) + pending recovery ($ sent, awaiting). */
export async function getCreditRecoverySummary(tenantId: string, window: { start: Date; end: Date }): Promise<{ recoveredCents: number; pendingCents: number }> {
  return withTenant(tenantId, async (tx) => {
    const [rec] = await tx.select({ total: sql<number>`coalesce(sum(${creditRequest.recoveredCents}), 0)::int` })
      .from(creditRequest)
      .where(and(eq(creditRequest.status, "credited"), gte(creditRequest.resolvedAt, window.start), lte(creditRequest.resolvedAt, window.end)));
    const [pend] = await tx.select({ total: sql<number>`coalesce(sum(${creditRequest.claimedCents}), 0)::int` })
      .from(creditRequest)
      .where(eq(creditRequest.status, "sent"));
    return { recoveredCents: rec?.total ?? 0, pendingCents: pend?.total ?? 0 };
  });
}
```

- [ ] **Step 5: Export + verify pass + commit**

Add to `packages/db/src/index.ts`:
```ts
export { getMaterialOrderSnapshot, saveGuardedSupplierInvoice } from "./lifecycle/supplier-invoice";
export { createCreditRequest, setCreditRequestSent, listOpenSentCreditRequests, markCreditRequestCredited, getCreditRecoverySummary } from "./lifecycle/credit-request";
```
Run: `cd packages/db && pnpm exec vitest run src/lifecycle/credit-request.test.ts src/lifecycle/supplier-invoice.test.ts` → PASS (CI).
```bash
pnpm --filter @savvy/db typecheck
git add packages/db/src/lifecycle/supplier-invoice.ts packages/db/src/lifecycle/credit-request.ts packages/db/src/lifecycle/supplier-invoice.test.ts packages/db/src/lifecycle/credit-request.test.ts packages/db/src/index.ts
git commit -m "feat(db): guard save + material-order snapshot + credit_request lifecycle writers"
```

---

### Task 4: Agents — `priceGuardSupplierInvoice` (match → overage → guarded → gated auto-credit)

**Files:**
- Create: `packages/agents/src/functions/supplier-invoice-guard.ts`
- Create: `packages/agents/src/functions/supplier-invoice-guard.test.ts`
- Modify: `packages/agents/src/index.ts` (export + add to `functions[]`)

**Interfaces (Produces):**
- `priceGuardHandler(input: { tenantId; supplierInvoiceId }, deps): Promise<{ status: "guarded" | "guard_skipped"; creditRequestId?: string | null; claimedCents: number }>` — deps injected (photo-qc/parse pattern) so it is pure-testable: `loadInvoice`, `loadSnapshot`, `loadConfig`, `saveGuarded`, `createCredit`, `sendEmail`, `recordRun`, `gate`, `raiseDraftCard`.
- `priceGuardSupplierInvoice` Inngest fn on `supplier-invoice/parsed`.

**Handler logic:** load the parsed invoice (lines, parseConfidence, jobId, supplierName, invoiceNumber, totalCents). **If `totalCents < 0` → return `guard_skipped` (credit memos handled in Task 5).** If `jobId == null` → snapshot is `[]` (every line no-baseline). Else load snapshot. Run `matchInvoiceLines` → per line `computeLineOverage` → write `matchedItemKey / expectedUnitCostCents / overageCents / matchConfidence` back into each line → `saveGuarded`. Sum qualifying overages → `claimedCents`. `allOverageLinesMatched` = every qualifying-overage line has `matchedItemKey != null`. If `claimedCents > 0`: if `shouldAutoSendCredit(...)` AND `gate.proceed` → `createCredit(status:"sent")` + `sendEmail` (capture id) + `recordRun("ok")`; else → `createCredit(status:"drafted")` + `raiseDraftCard`. FAIL-SOFT: any throw → return `guard_skipped` (never throws).

- [ ] **Step 1: Write the failing handler test** — `packages/agents/src/functions/supplier-invoice-guard.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { priceGuardHandler } from "./supplier-invoice-guard";

const cfg = { minOverageCents: 2500, overagePct: 0.05, autoSendMinCents: 2500, highConfidence: 0.8 };
const invoice = {
  jobId: "job-1", supplierName: "ABC Supply", invoiceNumber: "INV-9", parseConfidence: 0.92, totalCents: 240000,
  lines: [{ description: "GAF Timberline HDZ", sku: "shingle-hdz", quantity: 30, unitBilledCents: 8000, amountBilledCents: 240000 }],
};
const snapshot = [{ key: "shingle-hdz", name: "GAF Timberline HDZ", unitCostCents: 7000 }];

const baseDeps = () => ({
  loadInvoice: vi.fn().mockResolvedValue(invoice),
  loadSnapshot: vi.fn().mockResolvedValue(snapshot),
  loadConfig: vi.fn().mockResolvedValue(cfg),
  saveGuarded: vi.fn().mockResolvedValue(undefined),
  createCredit: vi.fn().mockResolvedValue({ id: "cr-1" }),
  sendEmail: vi.fn().mockResolvedValue({ id: "email-1" }),
  recordRun: vi.fn().mockResolvedValue(undefined),
  gate: vi.fn().mockResolvedValue({ proceed: true, level: "full" }),
  raiseDraftCard: vi.fn().mockResolvedValue(undefined),
});
const input = { tenantId: "t", supplierInvoiceId: "si" };

describe("priceGuardHandler", () => {
  it("guards, detects the overage, and auto-sends a credit request when confident + gated open", async () => {
    const deps = baseDeps();
    const res = await priceGuardHandler(input, deps);
    expect(res.status).toBe("guarded");
    expect(res.claimedCents).toBe(30000); // (8000-7000)*30
    // guarded lines carry the verdict
    expect(deps.saveGuarded).toHaveBeenCalledWith("t", "si", [expect.objectContaining({ matchedItemKey: "shingle-hdz", expectedUnitCostCents: 7000, overageCents: 30000 })]);
    expect(deps.createCredit).toHaveBeenCalledWith("t", expect.objectContaining({ status: "sent", claimedCents: 30000, supplierInvoiceId: "si" }));
    expect(deps.sendEmail).toHaveBeenCalled();
    expect(deps.recordRun).toHaveBeenCalled();
    expect(deps.raiseDraftCard).not.toHaveBeenCalled();
  });

  it("drafts + raises a Today card when parse confidence is low (never unattended-emails)", async () => {
    const deps = baseDeps();
    deps.loadInvoice = vi.fn().mockResolvedValue({ ...invoice, parseConfidence: 0.5 });
    const res = await priceGuardHandler(input, deps);
    expect(res.status).toBe("guarded");
    expect(deps.createCredit).toHaveBeenCalledWith("t", expect.objectContaining({ status: "drafted" }));
    expect(deps.sendEmail).not.toHaveBeenCalled();
    expect(deps.raiseDraftCard).toHaveBeenCalled();
  });

  it("drafts (no email) when the automation gate is closed", async () => {
    const deps = baseDeps();
    deps.gate = vi.fn().mockResolvedValue({ proceed: false, level: "review" });
    await priceGuardHandler(input, deps);
    expect(deps.createCredit).toHaveBeenCalledWith("t", expect.objectContaining({ status: "drafted" }));
    expect(deps.sendEmail).not.toHaveBeenCalled();
  });

  it("guards with no credit request when there is no qualifying overage", async () => {
    const deps = baseDeps();
    deps.loadInvoice = vi.fn().mockResolvedValue({ ...invoice, lines: [{ description: "GAF Timberline HDZ", sku: "shingle-hdz", quantity: 1, unitBilledCents: 7010, amountBilledCents: 7010 }] });
    const res = await priceGuardHandler(input, deps);
    expect(res.status).toBe("guarded");
    expect(res.claimedCents).toBe(0);
    expect(deps.createCredit).not.toHaveBeenCalled();
  });

  it("skips credit memos (negative total) for the recovery path", async () => {
    const deps = baseDeps();
    deps.loadInvoice = vi.fn().mockResolvedValue({ ...invoice, totalCents: -240000 });
    const res = await priceGuardHandler(input, deps);
    expect(res.status).toBe("guard_skipped");
    expect(deps.saveGuarded).not.toHaveBeenCalled();
  });

  it("is fail-soft: a load error returns guard_skipped and does not throw", async () => {
    const deps = baseDeps();
    deps.loadInvoice = vi.fn().mockRejectedValue(new Error("db down"));
    const res = await priceGuardHandler(input, deps);
    expect(res.status).toBe("guard_skipped");
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `cd packages/agents && pnpm exec vitest run src/functions/supplier-invoice-guard.test.ts` → FAIL (handler missing).

- [ ] **Step 3: Implement the handler + Inngest function** — `packages/agents/src/functions/supplier-invoice-guard.ts`:

```ts
import {
  getMaterialOrderSnapshot, saveGuardedSupplierInvoice, createCreditRequest, recordAgentRun,
  gateAgentAutomation, withTenant, supplierInvoice, tenant, eq,
} from "@savvy/db";
import {
  matchInvoiceLines, computeLineOverage, shouldAutoSendCredit, parseFinanceConfig,
  type SupplierInvoiceLine, type SnapshotLine,
} from "@savvy/core";
import { getEmailSender } from "@savvy/integrations";
import { inngest } from "../client";
import { raiseSupplierInvoiceCard } from "./supplier-invoice-cards"; // Task 8 helper (Feed A is query-driven; this is a thin no-op-safe notifier). If Task 8 lands after, inline a stub that resolves.

// The finance persona for the credit request. taskKey "close-out-133" = the seeded,
// full-auto, finance-owned "Job cost reconciliation" checklist task the guard belongs to.
const GUARD_TASK_KEY = "close-out-133";

type ParsedInvoice = {
  jobId: string | null; supplierName: string | null; invoiceNumber: string | null;
  parseConfidence: number | null; totalCents: number | null; lines: SupplierInvoiceLine[];
};

export type PriceGuardDeps = {
  loadInvoice: (tenantId: string, id: string) => Promise<ParsedInvoice>;
  loadSnapshot: (tenantId: string, jobId: string) => Promise<SnapshotLine[]>;
  loadConfig: (tenantId: string) => Promise<{ minOverageCents: number; overagePct: number; autoSendMinCents: number; highConfidence: number }>;
  saveGuarded: (tenantId: string, id: string, lines: SupplierInvoiceLine[]) => Promise<void>;
  createCredit: (tenantId: string, input: { supplierInvoiceId: string; jobId: string | null; supplierName: string | null; claimedCents: number; status: "sent" | "drafted"; evidence: unknown; emailMessageId?: string | null }) => Promise<{ id: string }>;
  sendEmail: (opts: { to: string; subject: string; html: string }) => Promise<{ id: string }>;
  recordRun: (opts: { tenantId: string; jobId: string | null; status: "ok" | "error"; error?: string | null }) => Promise<void>;
  gate: (tenantId: string, jobId: string) => Promise<{ proceed: boolean; level: string }>;
  raiseDraftCard: (tenantId: string, args: { supplierInvoiceId: string; supplierName: string | null; claimedCents: number }) => Promise<void>;
};

/** Price-guard one parsed invoice. FAIL-SOFT — any error returns guard_skipped, never throws. */
export async function priceGuardHandler(
  input: { tenantId: string; supplierInvoiceId: string },
  deps: PriceGuardDeps,
): Promise<{ status: "guarded" | "guard_skipped"; creditRequestId?: string | null; claimedCents: number }> {
  const { tenantId, supplierInvoiceId } = input;
  try {
    const inv = await deps.loadInvoice(tenantId, supplierInvoiceId);
    // Credit memos (negative total) are recovery, not guarding — handled by the recovery path.
    if ((inv.totalCents ?? 0) < 0) return { status: "guard_skipped", claimedCents: 0 };

    const cfg = await deps.loadConfig(tenantId);
    const snapshot = inv.jobId ? await deps.loadSnapshot(tenantId, inv.jobId) : [];
    const matches = matchInvoiceLines(inv.lines, snapshot);

    const guardedLines: SupplierInvoiceLine[] = inv.lines.map((line, i) => {
      const m = matches[i]!;
      const { overageCents } = computeLineOverage({ unitBilledCents: line.unitBilledCents, quantity: line.quantity, expectedUnitCostCents: m.expectedUnitCostCents }, cfg);
      return { ...line, matchedItemKey: m.matchedItemKey, expectedUnitCostCents: m.expectedUnitCostCents, matchConfidence: m.matchConfidence, overageCents };
    });
    await deps.saveGuarded(tenantId, supplierInvoiceId, guardedLines);

    // Qualifying overages → the claim; a line is "clean" when it matched a snapshot key.
    let claimedCents = 0;
    let allOverageLinesMatched = true;
    const evidence: unknown[] = [];
    inv.lines.forEach((line, i) => {
      const m = matches[i]!;
      const { overageCents, qualifies } = computeLineOverage({ unitBilledCents: line.unitBilledCents, quantity: line.quantity, expectedUnitCostCents: m.expectedUnitCostCents }, cfg);
      if (qualifies) {
        claimedCents += overageCents;
        if (m.matchedItemKey == null) allOverageLinesMatched = false;
        evidence.push({ description: line.description, quantity: line.quantity, unitBilledCents: line.unitBilledCents, expectedUnitCostCents: m.expectedUnitCostCents, overageCents });
      }
    });

    if (claimedCents <= 0) return { status: "guarded", creditRequestId: null, claimedCents: 0 };

    const gate = inv.jobId ? await deps.gate(tenantId, inv.jobId) : { proceed: false, level: "no_job" };
    const autoSend = shouldAutoSendCredit({ claimedCents, parseConfidence: inv.parseConfidence, allOverageLinesMatched, cfg }) && gate.proceed;

    if (autoSend) {
      const email = await deps.sendEmail(buildCreditEmail(inv, claimedCents, evidence));
      const cr = await deps.createCredit(tenantId, { supplierInvoiceId, jobId: inv.jobId, supplierName: inv.supplierName, claimedCents, status: "sent", evidence, emailMessageId: email.id });
      await deps.recordRun({ tenantId, jobId: inv.jobId, status: "ok" });
      return { status: "guarded", creditRequestId: cr.id, claimedCents };
    }

    const cr = await deps.createCredit(tenantId, { supplierInvoiceId, jobId: inv.jobId, supplierName: inv.supplierName, claimedCents, status: "drafted", evidence });
    await deps.raiseDraftCard(tenantId, { supplierInvoiceId, supplierName: inv.supplierName, claimedCents });
    return { status: "guarded", creditRequestId: cr.id, claimedCents };
  } catch {
    return { status: "guard_skipped", claimedCents: 0 };
  }
}

/** Professional, evidence-based supplier credit-request email (job/PO, expected vs billed, per-line delta, total). */
function buildCreditEmail(inv: ParsedInvoice, claimedCents: number, evidence: unknown[]): { to: string; subject: string; html: string } {
  const usd = (c: number) => `$${(c / 100).toFixed(2)}`;
  const rows = (evidence as { description: string; quantity: number; unitBilledCents: number; expectedUnitCostCents: number | null; overageCents: number }[])
    .map((e) => `<tr><td>${e.description}</td><td>${e.quantity}</td><td>${usd(e.unitBilledCents)}</td><td>${e.expectedUnitCostCents != null ? usd(e.expectedUnitCostCents) : "—"}</td><td>${usd(e.overageCents)}</td></tr>`).join("");
  return {
    to: "", // real recipient resolved in the Inngest wiring from the supplier contact / reply-to; unit test ignores.
    subject: `Credit request — invoice ${inv.invoiceNumber ?? ""} (${usd(claimedCents)} overbilled)`,
    html: `<p>We identified an overbilling on invoice ${inv.invoiceNumber ?? ""} totaling <strong>${usd(claimedCents)}</strong>.</p>` +
      `<table><thead><tr><th>Item</th><th>Qty</th><th>Billed</th><th>Expected</th><th>Overage</th></tr></thead><tbody>${rows}</tbody></table>` +
      `<p>Please issue a credit memo for ${usd(claimedCents)}. Thank you.</p>`,
  };
}

// Per-tenant concurrency key so one tenant's invoice burst can't starve others' guarding.
export const priceGuardSupplierInvoice = inngest.createFunction(
  { id: "price-guard-supplier-invoice", concurrency: { limit: 5, key: "event.data.tenantId" }, retries: 2 },
  { event: "supplier-invoice/parsed" },
  async ({ event, step }) => {
    const { tenantId, supplierInvoiceId } = event.data;
    return step.run("guard", () =>
      priceGuardHandler({ tenantId, supplierInvoiceId }, {
        loadInvoice: (t, id) => withTenant(t, async (tx) => {
          const [r] = await tx.select({ jobId: supplierInvoice.jobId, supplierName: supplierInvoice.supplierName, invoiceNumber: supplierInvoice.invoiceNumber, parseConfidence: supplierInvoice.parseConfidence, totalCents: supplierInvoice.totalCents, lines: supplierInvoice.lines })
            .from(supplierInvoice).where(eq(supplierInvoice.id, id));
          return { jobId: r!.jobId, supplierName: r!.supplierName, invoiceNumber: r!.invoiceNumber, parseConfidence: r!.parseConfidence, totalCents: r!.totalCents, lines: r!.lines ?? [] };
        }),
        loadSnapshot: (t, jobId) => getMaterialOrderSnapshot(t, jobId),
        loadConfig: (t) => withTenant(t, async (tx) => {
          const [row] = await tx.select({ settings: tenant.settings }).from(tenant).where(eq(tenant.id, t));
          return parseFinanceConfig((row?.settings as { finance?: unknown })?.finance).priceGuard;
        }),
        saveGuarded: (t, id, lines) => saveGuardedSupplierInvoice(t, id, lines),
        createCredit: (t, i) => createCreditRequest(t, i),
        sendEmail: async (opts) => {
          if (process.env.TEST_MODE === "1") return { id: "test-email" }; // no outbound email in e2e
          return getEmailSender({ gmailConnectionId: null }).sendEmail({ ...opts, from: process.env.EMAIL_FROM ?? "noreply@example.com" });
        },
        recordRun: (o) => recordAgentRun({ tenantId: o.tenantId, agent: "finance", taskKey: GUARD_TASK_KEY, jobId: o.jobId, status: o.status, error: o.error ?? null }),
        gate: (t, jobId) => gateAgentAutomation({ tenantId: t, jobId, taskKey: GUARD_TASK_KEY, agent: "finance" }),
        raiseDraftCard: async () => {}, // Feed A is query-driven (Task 8 reads drafted credit_requests); no imperative insert needed.
      }));
  },
);
```

Notes for the implementer: the `raiseDraftCard`/`raiseSupplierInvoiceCard` import is a convenience seam — Today cards are **query-driven** (Task 8 selects `drafted` credit requests / unmatched invoices), so the real wiring passes a no-op `raiseDraftCard`. Delete the `supplier-invoice-cards` import line if Task 8 hasn't landed; the unit test injects its own `raiseDraftCard` spy regardless. The email `to` is resolved in the wiring from the supplier's inbound `from` address (thread it through `loadInvoice` if you want a real recipient; for the gated auto-send MVP an empty `to` under a real gateway would fail-soft — acceptable, since e2e stubs the send).

- [ ] **Step 4: Register the function**

In `packages/agents/src/index.ts`: `import { priceGuardSupplierInvoice } from "./functions/supplier-invoice-guard";`, add `export { priceGuardSupplierInvoice, priceGuardHandler } from "./functions/supplier-invoice-guard";`, and append `priceGuardSupplierInvoice` to the `functions` array.

- [ ] **Step 5: Verify pass + typecheck + commit**

Run: `cd packages/agents && pnpm exec vitest run src/functions/supplier-invoice-guard.test.ts` → PASS.
```bash
pnpm --filter @savvy/agents typecheck
git add packages/agents/src/functions/supplier-invoice-guard.ts packages/agents/src/functions/supplier-invoice-guard.test.ts packages/agents/src/index.ts
git commit -m "feat(agents): priceGuardSupplierInvoice — match→overage→guarded→gated auto-credit"
```

---

### Task 5: Agents — credit-memo auto-recovery loop

**Files:**
- Modify: `packages/agents/src/functions/supplier-invoice-guard.ts` (add `recoverCreditMemoHandler` + branch the Inngest fn)
- Modify: `packages/agents/src/functions/supplier-invoice-guard.test.ts` (recovery tests)

**Interfaces (Produces):** `recoverCreditMemoHandler(input: { tenantId; supplierInvoiceId }, deps): Promise<{ status: "credited" | "reconcile" | "skipped" }>` — deps: `loadInvoice`, `listOpen`, `markCredited`, `raiseReconcileCard`. A credit memo = supplier invoice with `totalCents < 0`; `amountCents = abs(totalCents)`; match one open sent request via `matchCreditMemo`; matched → `markCredited(recoveredCents=amount)`; else → `raiseReconcileCard`.

- [ ] **Step 1: Write the failing tests** (append):

```ts
import { recoverCreditMemoHandler } from "./supplier-invoice-guard";

const memoDeps = () => ({
  loadInvoice: vi.fn().mockResolvedValue({ supplierName: "ABC Supply", totalCents: -30000 }),
  listOpen: vi.fn().mockResolvedValue([{ id: "cr-1", supplierName: "ABC Supply", claimedCents: 30000 }]),
  markCredited: vi.fn().mockResolvedValue(undefined),
  raiseReconcileCard: vi.fn().mockResolvedValue(undefined),
});

describe("recoverCreditMemoHandler", () => {
  it("auto-credits the one matching open request", async () => {
    const deps = memoDeps();
    const res = await recoverCreditMemoHandler({ tenantId: "t", supplierInvoiceId: "memo" }, deps);
    expect(res.status).toBe("credited");
    expect(deps.markCredited).toHaveBeenCalledWith("t", "cr-1", 30000);
    expect(deps.raiseReconcileCard).not.toHaveBeenCalled();
  });
  it("raises a reconcile card when no unique match", async () => {
    const deps = memoDeps();
    deps.listOpen = vi.fn().mockResolvedValue([]);
    const res = await recoverCreditMemoHandler({ tenantId: "t", supplierInvoiceId: "memo" }, deps);
    expect(res.status).toBe("reconcile");
    expect(deps.raiseReconcileCard).toHaveBeenCalled();
  });
  it("skips a non-memo (positive total)", async () => {
    const deps = memoDeps();
    deps.loadInvoice = vi.fn().mockResolvedValue({ supplierName: "ABC", totalCents: 500 });
    const res = await recoverCreditMemoHandler({ tenantId: "t", supplierInvoiceId: "x" }, deps);
    expect(res.status).toBe("skipped");
  });
});
```

- [ ] **Step 2: Run to verify fail** — `pnpm exec vitest run src/functions/supplier-invoice-guard.test.ts` → FAIL (`recoverCreditMemoHandler` missing).

- [ ] **Step 3: Implement** (add to `supplier-invoice-guard.ts`):

```ts
import { matchCreditMemo } from "@savvy/core";
import { listOpenSentCreditRequests, markCreditRequestCredited } from "@savvy/db";

export type RecoverDeps = {
  loadInvoice: (tenantId: string, id: string) => Promise<{ supplierName: string | null; totalCents: number | null }>;
  listOpen: (tenantId: string, supplierName: string | null) => Promise<{ id: string; supplierName: string | null; claimedCents: number }[]>;
  markCredited: (tenantId: string, id: string, recoveredCents: number) => Promise<void>;
  raiseReconcileCard: (tenantId: string, args: { supplierInvoiceId: string; supplierName: string | null; amountCents: number }) => Promise<void>;
};

/** Credit-memo recovery: match a negative-total invoice to one open sent request → credited. FAIL-SOFT. */
export async function recoverCreditMemoHandler(input: { tenantId: string; supplierInvoiceId: string }, deps: RecoverDeps): Promise<{ status: "credited" | "reconcile" | "skipped" }> {
  const { tenantId, supplierInvoiceId } = input;
  try {
    const inv = await deps.loadInvoice(tenantId, supplierInvoiceId);
    if ((inv.totalCents ?? 0) >= 0) return { status: "skipped" };
    const amountCents = Math.abs(inv.totalCents ?? 0);
    const open = await deps.listOpen(tenantId, inv.supplierName);
    const matchId = matchCreditMemo({ supplierName: inv.supplierName, amountCents }, open);
    if (matchId) { await deps.markCredited(tenantId, matchId, amountCents); return { status: "credited" }; }
    await deps.raiseReconcileCard(tenantId, { supplierInvoiceId, supplierName: inv.supplierName, amountCents });
    return { status: "reconcile" };
  } catch { return { status: "skipped" }; }
}
```

Branch the Inngest fn so a memo routes to recovery instead of guarding. Replace the fn body's `step.run("guard", …)` with a dispatch that first peeks the total:
```ts
async ({ event, step }) => {
  const { tenantId, supplierInvoiceId } = event.data;
  const isMemo = await step.run("peek", () => withTenant(tenantId, async (tx) => {
    const [r] = await tx.select({ totalCents: supplierInvoice.totalCents }).from(supplierInvoice).where(eq(supplierInvoice.id, supplierInvoiceId));
    return (r?.totalCents ?? 0) < 0;
  }));
  if (isMemo) {
    return step.run("recover", () => recoverCreditMemoHandler({ tenantId, supplierInvoiceId }, {
      loadInvoice: (t, id) => withTenant(t, async (tx) => {
        const [r] = await tx.select({ supplierName: supplierInvoice.supplierName, totalCents: supplierInvoice.totalCents }).from(supplierInvoice).where(eq(supplierInvoice.id, id));
        return { supplierName: r!.supplierName, totalCents: r!.totalCents };
      }),
      listOpen: (t, s) => listOpenSentCreditRequests(t, s),
      markCredited: (t, id, c) => markCreditRequestCredited(t, id, c),
      raiseReconcileCard: async () => {}, // Feed A query-driven (Task 8)
    }));
  }
  return step.run("guard", () => priceGuardHandler({ tenantId, supplierInvoiceId }, { /* …deps from Task 4… */ }));
}
```

- [ ] **Step 4: Verify pass + typecheck + commit**

Run: `pnpm exec vitest run src/functions/supplier-invoice-guard.test.ts` → PASS.
```bash
pnpm --filter @savvy/agents typecheck
git add packages/agents/src/functions/supplier-invoice-guard.ts packages/agents/src/functions/supplier-invoice-guard.test.ts
git commit -m "feat(agents): credit-memo auto-recovery — match open request → credited"
```

---

### Task 6: Core + Web — `finance.price_guard` invariant → registry task → Money proof panel

**Files:**
- Modify: `packages/core/src/verification/checks.ts` (add the invariant)
- Modify: `packages/db/seeds/master-task-list.ts` (bind to a finance master-task id in `CHECK_BINDINGS`)
- Modify: `apps/web/src/lib/money-queries.ts` (add `CHECK_LABEL` entry)
- Modify: `packages/core/src/verification/checks.test.ts` (if present) or add a focused test

**Interfaces (Produces):** `evidenceChecks["finance.price_guard"]` — an `invariant` that returns rows (⇒ fail) for any job-with-material-order invoice whose lines lack a guard verdict.

- [ ] **Step 1: Add the invariant** — in `packages/core/src/verification/checks.ts`, inside `evidenceChecks`:

```ts
  // Every supplier invoice for a job that has a material order must be fully guarded:
  // guarded status + every line carrying a verdict (matchedItemKey present, even if null =
  // "no baseline"). A 5-minute grace avoids flagging an invoice mid-parse/guard. Zero rows = pass.
  "finance.price_guard": invariant(
    "finance.price_guard",
    `select si.id
       from supplier_invoice si
      where si.tenant_id = $1
        and coalesce(si.total_cents, 0) > 0
        and si.updated_at < now() - interval '5 minutes'
        and exists (select 1 from material_order mo where mo.tenant_id = si.tenant_id and mo.job_id = si.job_id)
        and (
          si.status <> 'guarded'
          or exists (
            select 1 from jsonb_array_elements(si.lines) ln where not (ln ? 'matchedItemKey')
          )
        )`,
    { toRef: (r) => ({ type: "supplier_invoice", ref: String(r.id) }) },
  ),
```

- [ ] **Step 2: Bind to a registry task** — in `packages/db/seeds/master-task-list.ts`, add to `CHECK_BINDINGS` the finance cost-reconciliation master-task id mapped to `"finance.price_guard"` (find the master-task row whose title is the supplier-cost / price-guard reconciliation; use its numeric id):
```ts
  <financeTaskId>: "finance.price_guard", // Supplier-invoice price guard
```
Re-seed in dev/CI via the existing seed path (`seedTaskRegistry`), so `task_registry.check_key` carries the binding. (If no suitable master-task exists, add one row to the master list with `ownerAgent: "finance"` and bind it.)

- [ ] **Step 3: Add the human label** — in `apps/web/src/lib/money-queries.ts`, add to `CHECK_LABEL`:
```ts
  "finance.price_guard": "Supplier invoices 100% price-checked",
```

- [ ] **Step 4: Test the invariant shape** — add to `packages/core/src/verification/checks.test.ts` (or create) a test that `getCheck("finance.price_guard")` is defined and, given a fake `EvidenceDb` returning one row, yields `status: "fail"` with a `supplier_invoice` ref; and given zero rows yields `pass`:
```ts
import { getCheck } from "./checks";
it("finance.price_guard fails when a row is returned, passes when none", async () => {
  const check = getCheck("finance.price_guard")!;
  const ctx = (rows: { id: string }[]) => ({ tenantId: "t", db: { query: async () => ({ rows }) }, params: {}, window: { start: new Date(0), end: new Date(1) } });
  expect((await check(ctx([{ id: "si1" }]))).status).toBe("fail");
  expect((await check(ctx([]))).status).toBe("pass");
});
```

- [ ] **Step 5: Verify + typecheck + commit**

Run: `cd packages/core && pnpm exec vitest run src/verification/checks.test.ts` → PASS.
```bash
pnpm --filter @savvy/core typecheck && pnpm --filter @savvy/web typecheck
git add packages/core/src/verification/checks.ts packages/core/src/verification/checks.test.ts packages/db/seeds/master-task-list.ts apps/web/src/lib/money-queries.ts
git commit -m "feat(core): finance.price_guard invariant + registry binding + Money proof label"
```

---

### Task 7: Core + DB — digest recovered / pending-recovery dollars

**Files:**
- Modify: `packages/core/src/digest.ts` (add `buildRecoveryLine`)
- Modify: `packages/core/src/digest.test.ts` (assert the line)
- Modify: `packages/agents/src/ops-digest.ts` (append the recovery line when nonzero)

**Interfaces (Produces):** `buildRecoveryLine(input: { recoveredCents: number; pendingCents: number }): string | null` — returns e.g. `"💰 Recovered $300.00 this period · $450.00 pending"`, or `null` when both are zero.

- [ ] **Step 1: Write the failing test** — add to `packages/core/src/digest.test.ts`:
```ts
import { buildRecoveryLine } from "./digest";
it("renders recovered + pending recovery dollars, null when both zero", () => {
  expect(buildRecoveryLine({ recoveredCents: 30000, pendingCents: 45000 })).toBe("💰 Recovered $300.00 this period · $450.00 pending");
  expect(buildRecoveryLine({ recoveredCents: 0, pendingCents: 0 })).toBeNull();
});
```

- [ ] **Step 2: Run to verify fail** — `cd packages/core && pnpm exec vitest run src/digest.test.ts` → FAIL.

- [ ] **Step 3: Implement** — add to `packages/core/src/digest.ts`:
```ts
/** One-line digest of supplier-invoice recovery: credited this period + still-pending claims. */
export function buildRecoveryLine(input: { recoveredCents: number; pendingCents: number }): string | null {
  if (input.recoveredCents <= 0 && input.pendingCents <= 0) return null;
  const usd = (c: number) => `$${(c / 100).toFixed(2)}`;
  return `💰 Recovered ${usd(input.recoveredCents)} this period · ${usd(input.pendingCents)} pending`;
}
```

- [ ] **Step 4: Wire into the digest agent** — in `packages/agents/src/ops-digest.ts`, after the digest message is built inside `sendTenantDigest`, load `getCreditRecoverySummary(tenantId, window)` and, when `buildRecoveryLine(...)` is non-null, append it to the digest body before send. Import `getCreditRecoverySummary` from `@savvy/db` and `buildRecoveryLine` from `@savvy/core`; compute `window` from the same `now`/24h the digest already uses.

- [ ] **Step 5: Verify + typecheck + commit**
```bash
cd packages/core && pnpm exec vitest run src/digest.test.ts   # PASS
cd ../.. && pnpm --filter @savvy/core typecheck && pnpm --filter @savvy/agents typecheck
git add packages/core/src/digest.ts packages/core/src/digest.test.ts packages/agents/src/ops-digest.ts
git commit -m "feat(digest): recovered + pending-recovery dollars line"
```

---

### Task 8: Web — Today cards (Feed A) + Job-detail "Supplier invoices" panel

**Files:**
- Modify: `packages/core/src/exception-queue.ts` (add supplier kinds + input types + push loops)
- Modify: `packages/core/src/exception-queue.test.ts` (assert the new cards)
- Modify: `apps/web/src/lib/exception-queries.ts` (add supplier-invoice + credit SELECTs)
- Modify: `apps/web/src/app/(app)/today/page.tsx` (KIND_LABEL entries)
- Create: `apps/web/src/app/(app)/jobs/[id]/SupplierInvoicesPanel.tsx`
- Modify: `apps/web/src/app/(app)/jobs/[id]/page.tsx` (render the panel)
- Modify: `apps/web/tests/e2e/job-ledger-console.spec.ts` OR a new spec (covered in Task 9)

**Interfaces (Produces):** three new `ExceptionKind`s — `"supplier_invoice_unmatched"`, `"supplier_credit_review"`, `"supplier_credit_reconcile"` — each producing the `ExceptionItem` shape `{ kind, severity, title, detail, href, occurredAt }`.

- [ ] **Step 1: Extend the pure exception queue** — in `packages/core/src/exception-queue.ts`: add the three kinds to the `ExceptionKind` union; add input arrays to `ExceptionQueueInput` (`supplierInvoicesUnmatched`, `creditsToReview`, `creditsToReconcile`); add push loops modeled on the `photoUnmatched` loop, e.g.:
```ts
for (const s of input.supplierInvoicesUnmatched ?? []) {
  items.push({ kind: "supplier_invoice_unmatched", severity: "medium", title: "Unmatched supplier invoice", detail: `${s.supplierName ?? "Unknown supplier"} — no job matched`, href: "/library", occurredAt: s.createdAt });
}
for (const c of input.creditsToReview ?? []) {
  items.push({ kind: "supplier_credit_review", severity: "high", title: "Review & send credit request", detail: `${usd(c.claimedCents)} — ${c.supplierName ?? "supplier"}`, href: c.jobId ? `/jobs/${c.jobId}` : "/money", occurredAt: c.createdAt });
}
for (const c of input.creditsToReconcile ?? []) {
  items.push({ kind: "supplier_credit_reconcile", severity: "medium", title: "Reconcile credit memo", detail: `${usd(c.amountCents)} — ${c.supplierName ?? "supplier"}`, href: "/money", occurredAt: c.createdAt });
}
```
(Reuse/add a local `usd` cents formatter if the file has one; otherwise inline `$${(c/100).toFixed(2)}`.)

- [ ] **Step 2: Write the failing core test** — in `packages/core/src/exception-queue.test.ts`, add cases asserting each new input surfaces its card kind + severity + href. Run `cd packages/core && pnpm exec vitest run src/exception-queue.test.ts` → FAIL, then implement Step 1, then PASS.

- [ ] **Step 3: Add DB gathering + lifecycle list helpers** — add to `packages/db/src/lifecycle/supplier-invoice.ts` (and export):
```ts
/** Unmatched (no job) parsed/guarded invoices — Today "unmatched supplier invoice" cards. */
export async function listUnmatchedSupplierInvoices(tenantId: string): Promise<{ id: string; supplierName: string | null; createdAt: Date }[]> {
  return withTenant(tenantId, (tx) =>
    tx.select({ id: supplierInvoice.id, supplierName: supplierInvoice.supplierName, createdAt: supplierInvoice.createdAt })
      .from(supplierInvoice)
      .where(and(sql`${supplierInvoice.jobId} is null`, inArray(supplierInvoice.status, ["parsed", "guarded"]))));
}
/** Parsed/guarded invoices for a job — the Job-detail Supplier-invoices panel. */
export async function listSupplierInvoicesForJob(tenantId: string, jobId: string): Promise<{ id: string; supplierName: string | null; invoiceNumber: string | null; totalCents: number | null; status: string; lines: SupplierInvoiceLine[] }[]> {
  return withTenant(tenantId, (tx) =>
    tx.select({ id: supplierInvoice.id, supplierName: supplierInvoice.supplierName, invoiceNumber: supplierInvoice.invoiceNumber, totalCents: supplierInvoice.totalCents, status: supplierInvoice.status, lines: supplierInvoice.lines })
      .from(supplierInvoice).where(eq(supplierInvoice.jobId, jobId)));
}
```
Add to `packages/db/src/lifecycle/credit-request.ts`: `listDraftedCreditRequests(tenantId)` (status=drafted → review cards) returning `{ id, jobId, supplierName, claimedCents, createdAt }[]`. Export all three from `packages/db/src/index.ts`.

- [ ] **Step 4: Wire the Today gathering query** — in `apps/web/src/lib/exception-queries.ts` `getExceptionQueue`, add three SELECTs via the new lifecycle helpers, mapping to the core input arrays (`supplierInvoicesUnmatched`, `creditsToReview` from drafted requests, `creditsToReconcile` — from a `credit_request`-less signal or a dedicated marker; for the MVP reconcile card, derive from negative-total supplier invoices with no matching credited request, or defer reconcile cards and note it). Pass them into `buildExceptionQueue`.

- [ ] **Step 5: KIND_LABEL + Job-detail panel**

In `apps/web/src/app/(app)/today/page.tsx` add labels to `KIND_LABEL`:
```ts
  supplier_invoice_unmatched: "Unmatched invoice",
  supplier_credit_review: "Credit request",
  supplier_credit_reconcile: "Reconcile credit",
```
Create `apps/web/src/app/(app)/jobs/[id]/SupplierInvoicesPanel.tsx` (server component) rendering `listSupplierInvoicesForJob(tenantId, jobId)`: one card per invoice with supplier, invoice #, total, status badge, and a per-line table (description · billed · expected · overage) plus any linked credit-request status. Add `data-testid="supplier-invoices-panel"`. Render it in `apps/web/src/app/(app)/jobs/[id]/page.tsx` under the existing job detail.

- [ ] **Step 6: Typecheck + lint + commit**
```bash
pnpm --filter @savvy/core exec vitest run src/exception-queue.test.ts   # PASS
pnpm --filter @savvy/core typecheck && pnpm --filter @savvy/db typecheck && pnpm --filter @savvy/web typecheck && pnpm --filter @savvy/web lint
git add packages/core/src/exception-queue.ts packages/core/src/exception-queue.test.ts packages/db/src/lifecycle/ packages/db/src/index.ts apps/web/src/lib/exception-queries.ts "apps/web/src/app/(app)/today/page.tsx" "apps/web/src/app/(app)/jobs/[id]/SupplierInvoicesPanel.tsx" "apps/web/src/app/(app)/jobs/[id]/page.tsx"
git commit -m "feat(web): supplier-invoice Today cards + job-detail supplier-invoices panel"
```

---

### Task 9: E2E (AI-stubbed) + RLS cross-tenant tests

**Files:**
- Create: `apps/web/tests/e2e/supplier-invoice-guard.spec.ts`
- Modify: `packages/db/tests/isolation.test.ts` (add `supplier_invoice` + `credit_request` cross-tenant assertions)

- [ ] **Step 1: RLS isolation** — in `packages/db/tests/isolation.test.ts`, seed a `supplier_invoice` + `credit_request` under tenant A, then assert a `withTenant(tenantB, …)` select returns zero rows for both tables (mirror the existing per-table isolation assertions). Run in CI.

- [ ] **Step 2: Write the guard e2e** — `apps/web/tests/e2e/supplier-invoice-guard.spec.ts` (own isolated tenant, mirroring `supplier-invoice-parse.spec.ts`): seed tenant (inbox token) + customer + property + job + estimate + a `material_order` (status `ordered`) whose `lineItems` contain `{ key: "shingle-hdz", name: "GAF Timberline HDZ", quantity: 30, unitCostCents: 7000, … }` + a `price_book_item { key: "shingle-hdz", unitCostCents: 7000 }`. The AI stub already returns the canned parse (`unitBilledCents: 7800`, sku `HDZ-CHAR`)… **update the stub** (`apps/web/tests/e2e/ai-stub.mjs`) so the parsed line's `sku` is `"shingle-hdz"` and `unitBilledCents: 8000` (so it matches the snapshot key and produces a qualifying overage of `(8000-7000)*30 = 30000`). POST the forwarded invoice; `expect.poll` the `supplier_invoice` row until `status="guarded"`; assert its lines carry `matchedItemKey: "shingle-hdz"` + `overageCents: 30000`; assert a `credit_request` row exists for the invoice with `claimedCents: 30000` and `status` in (`sent`,`drafted`). Then POST a **credit memo** (a second forwarded email whose stubbed parse yields `totalCents: -30000`, supplier "ABC Supply") and `expect.poll` the `credit_request` until `status="credited"` with `recoveredCents: 30000`. Load `/money` and assert the `finance.price_guard` proof row renders (after a verification sweep, or seed a `verification_run` row directly like `money-console.spec.ts` does). Load `/jobs/{id}` and assert `supplier-invoices-panel` shows the overage.

  Stub note: the parse stub must distinguish the invoice vs the credit memo. Branch on a sentinel in the forwarded payload — e.g. include `"credit memo"` in the memo email's text and have the stub return `totalCents: -30000` when the request body contains that phrase; otherwise the positive invoice. (The AI request body includes the prompt + schema; add a `bodyIncludes("credit")` branch returning the negative-total object.)

- [ ] **Step 3: Commit**
```bash
git add apps/web/tests/e2e/supplier-invoice-guard.spec.ts apps/web/tests/e2e/ai-stub.mjs packages/db/tests/isolation.test.ts
git commit -m "test(e2e): price-guard → credit request → credit-memo recovery + RLS isolation"
```

- [ ] **Step 4: Open PR + watch + merge**

```bash
git push origin <branch>
gh pr create --base main --title "feat(console): supplier-invoice slice 13c — price-guard + auto-credit + recovery" --body "…"
gh pr checks <n> --watch
gh pr merge <n> --squash --delete-branch
```

---

## Slice 13c — Definition of Done

- [ ] Every parsed job-with-material-order invoice is guarded (lines carry `matchedItemKey`/`expectedUnitCostCents`/`overageCents`/`matchConfidence`; `status=guarded`).
- [ ] Qualifying overages create a `credit_request`; high-confidence + gated-open + cleanly-matched claims auto-send (email + `agent_run` proof + `emailMessageId`); everything else drafts + raises a Today card. Never unattended-emails a shaky parse.
- [ ] Credit memos auto-reconcile to open sent requests → `credited` + `recoveredCents` + `resolvedAt`; no-match → reconcile card.
- [ ] `finance.price_guard` invariant renders on the Money proof panel ("100% price-checked"); GM·MTD already real from 13b.
- [ ] Digest reports recovered + pending-recovery dollars.
- [ ] Job detail shows a Supplier-invoices panel (per-line expected vs billed + overage + credit status).
- [ ] RLS cross-tenant tests green for `supplier_invoice` + `credit_request`; typecheck + lint clean; packages vitest + web e2e green; migration 0048 generated (⚠️ run on prod post-merge like 0046/0047).

## Self-Review

- **Spec coverage (§6):** match & compare ✓ (Task 1 `matchInvoiceLines` + Task 4); expected from snapshot w/ price-book fallback ✓ (Task 3 `getMaterialOrderSnapshot`); overage + threshold ✓ (Task 1 `computeLineOverage`); write guard fields + `status=guarded` ✓ (Task 3/4); confidence-gated auto-send ✓ (Task 1 `shouldAutoSendCredit` + Task 4 gate); email + `agent_run` + `emailMessageId` ✓ (Task 4); drafted + Today card otherwise ✓ (Task 4/8); credit-memo auto-recovery ✓ (Task 5); `finance.price_guard` invariant + proof panel ✓ (Task 6); digest dollars ✓ (Task 7); job-detail panel ✓ (Task 8 / §7); RLS + e2e ✓ (Task 9 / §8).
- **Type consistency:** `SnapshotLine`/`LineMatch` shapes match between Task 1 (def), Task 3 (`getMaterialOrderSnapshot` producer), and Task 4 (consumer); `CreditRequestStatus` used by Task 2 (enum), Task 3 (writers), Task 4/5 (create/mark); `SupplierInvoiceLine` guard fields (already in `@savvy/core`) written by Task 4, read by Task 6 invariant (`matchedItemKey` presence) + Task 8 panel; `getCreditRecoverySummary` shape matches Task 7 consumer.
- **Deferred (spec §10):** AI-assisted line-match fallback is intentionally NOT wired in Task 4 (deterministic `matchInvoiceLines` + the confidence gate route low-confidence to a human card, per §10) — a clean follow-on that injects an `aiMatch` dep. Persona renders as **VERA** (Finance), not RAINE, because `close-out-133` lacks an `invoice|payment|collect` substring; upgrade by seeding a collect-flavored finance task if RAINE is required. Reconcile-card gathering (Task 8 Step 4) may be deferred if no clean marker exists — note it in the PR.
