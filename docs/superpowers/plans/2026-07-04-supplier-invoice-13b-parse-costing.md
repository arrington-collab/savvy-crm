# Supplier Invoice — Slice 13b (Parse → Real Costing) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** AI-parse a received supplier invoice into line-level actuals, attach them to the job so `job.costCents` reflects real supplier bills instead of the price-book estimate, and light up the Money screen's `GM·MTD`.

**Architecture:** A durable Inngest function on `supplier-invoice/received` fetches the stored PDF, parses it through the LiteLLM gateway (`completeObject`, capability `reasoning`) into a validated schema, matches it to a job, persists the parsed lines, and recomputes the job's cost from parsed supplier-invoice actuals (falling back to the material-order estimate when none exist). The Money KPI query then computes real month-to-date gross margin from `job.costCents`.

**Tech Stack:** Inngest · LiteLLM gateway via `@savvy/ai` (`completeObject`) · Drizzle/Postgres (RLS) · Cloudflare R2 (`presignDownload`) · Vitest (packages) + Playwright (web e2e, AI-stubbed).

**Spec:** `docs/superpowers/specs/2026-07-04-supplier-invoice-price-guard-design.md` §5. **Base:** slice 13a merged (`supplier_invoice` table, `supplier-invoice/received` event, `SupplierInvoiceLine` type in `@savvy/core`).

## Global Constraints

- **Tenant isolation on every query.** Lifecycle writes use `withTenant`; the Inngest handler runs against `adminPool`/admin context like the health sweep — scope every query by `tenantId`.
- **AI via the gateway by capability** — `completeObject({ capability: "reasoning", … })`; never a hard-coded model. Inject the AI client into the handler for unit tests (photo-qc / estimate-generate pattern).
- **Durable + fail-soft** — the parse function has `concurrency: { limit: 5, key: "event.data.tenantId" }`, `retries: 2`, and on any parse error sets `status="parse_failed"` (never throws), so a bad PDF can't wedge the queue.
- **No fabricated numbers** — `GM·MTD` renders a real % only when actuals exist for the period, else `—` (unchanged graceful path).
- **Test placement:** pure logic + the parse handler unit test live in `packages/*` (vitest runs `packages/*` only). apps/web is validated by e2e. Migrations via `pnpm db:generate`.
- **Package import rules + `gh pr checks <n> --watch` before squash-merge** — as slice 13a.

---

### Task 1: Core — parse schema, cost selection, MTD gross margin

**Files:**
- Modify: `packages/core/src/supplier-invoice.ts` (add `supplierInvoiceParseSchema`, `selectJobCost`)
- Create: `packages/core/src/money-margin.ts` (`computeMtdGrossMargin`)
- Modify: `packages/core/src/index.ts` (export `money-margin`)
- Modify: `packages/core/src/supplier-invoice.test.ts` (add `selectJobCost` tests)
- Create: `packages/core/src/money-margin.test.ts`

**Interfaces:**
- Produces: `supplierInvoiceParseSchema` (Zod, shape `{ supplierName, invoiceNumber, invoiceDate: string|null, totalCents, lines: {description, sku?, quantity, unit?, unitBilledCents, amountBilledCents}[], confidence }`); `selectJobCost(input: { actualsCents: number | null; estimateCents: number }): number`; `computeMtdGrossMargin(jobs: { revenueCents: number; costCents: number | null }[]): number | null`.

- [ ] **Step 1: Write the failing tests**

Add to `packages/core/src/supplier-invoice.test.ts`:

```ts
import { selectJobCost } from "./supplier-invoice";

describe("selectJobCost", () => {
  it("uses supplier-invoice actuals when present", () => {
    expect(selectJobCost({ actualsCents: 812300, estimateCents: 790000 })).toBe(812300);
  });
  it("falls back to the material-order estimate when no actuals", () => {
    expect(selectJobCost({ actualsCents: null, estimateCents: 790000 })).toBe(790000);
    expect(selectJobCost({ actualsCents: 0, estimateCents: 790000 })).toBe(790000);
  });
});
```

Create `packages/core/src/money-margin.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { computeMtdGrossMargin } from "./money-margin";

describe("computeMtdGrossMargin", () => {
  it("computes GM% from revenue and cost across jobs with known cost", () => {
    const gm = computeMtdGrossMargin([
      { revenueCents: 100_000, costCents: 60_000 },
      { revenueCents: 100_000, costCents: 62_000 },
    ]);
    expect(gm).toBe(39); // (200000 - 122000) / 200000 = 39%
  });
  it("ignores jobs with unknown cost", () => {
    const gm = computeMtdGrossMargin([
      { revenueCents: 100_000, costCents: 60_000 },
      { revenueCents: 100_000, costCents: null },
    ]);
    expect(gm).toBe(40); // only the first job counts
  });
  it("returns null when no job has a known cost (render as —)", () => {
    expect(computeMtdGrossMargin([{ revenueCents: 100_000, costCents: null }])).toBeNull();
    expect(computeMtdGrossMargin([])).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd packages/core && pnpm exec vitest run src/supplier-invoice.test.ts src/money-margin.test.ts`
Expected: FAIL — `selectJobCost` / `computeMtdGrossMargin` / `./money-margin` missing.

- [ ] **Step 3: Implement**

Append to `packages/core/src/supplier-invoice.ts`:

```ts
import { z } from "zod";

export const supplierInvoiceParseSchema = z.object({
  supplierName: z.string().nullable(),
  invoiceNumber: z.string().nullable(),
  invoiceDate: z.string().nullable(), // ISO date or null
  totalCents: z.number().int(),
  lines: z.array(z.object({
    description: z.string(),
    sku: z.string().optional(),
    quantity: z.number(),
    unit: z.string().optional(),
    unitBilledCents: z.number().int(),
    amountBilledCents: z.number().int(),
  })),
  confidence: z.number().min(0).max(1),
});
export type SupplierInvoiceParse = z.infer<typeof supplierInvoiceParseSchema>;

/** Prefer real supplier-invoice actuals; fall back to the material-order estimate until any land. */
export function selectJobCost(input: { actualsCents: number | null; estimateCents: number }): number {
  return input.actualsCents && input.actualsCents > 0 ? input.actualsCents : input.estimateCents;
}
```

(Confirm `zod` is a dependency of `@savvy/core` — it is, used by other schemas.)

Create `packages/core/src/money-margin.ts`:

```ts
/**
 * Month-to-date gross margin from job actuals. Pure; the Money KPI query passes
 * this period's invoiced jobs. Jobs with unknown cost are excluded so GM reflects
 * only jobs whose cost is real. Null (no known-cost jobs) → the page renders "—".
 */
export function computeMtdGrossMargin(jobs: { revenueCents: number; costCents: number | null }[]): number | null {
  const known = jobs.filter((j) => j.costCents != null);
  if (known.length === 0) return null;
  const revenue = known.reduce((a, j) => a + j.revenueCents, 0);
  const cost = known.reduce((a, j) => a + (j.costCents ?? 0), 0);
  if (revenue === 0) return null;
  return Math.round(((revenue - cost) / revenue) * 100);
}
```

- [ ] **Step 4: Export + verify pass**

Add `export * from "./money-margin";` to `packages/core/src/index.ts`.
Run: `cd packages/core && pnpm exec vitest run src/supplier-invoice.test.ts src/money-margin.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm --filter @savvy/core typecheck
git add packages/core/src/supplier-invoice.ts packages/core/src/money-margin.ts packages/core/src/money-margin.test.ts packages/core/src/supplier-invoice.test.ts packages/core/src/index.ts
git commit -m "feat(core): supplier-invoice parse schema, selectJobCost, computeMtdGrossMargin"
```

---

### Task 2: DB — `recomputeJobActualCost` lifecycle writer

**Files:**
- Create: `packages/db/src/lifecycle/supplier-invoice.ts` (`recomputeJobActualCost`, `saveParsedSupplierInvoice`)
- Modify: `packages/db/src/index.ts` (export)
- Create: `packages/db/src/lifecycle/supplier-invoice.test.ts`

**Interfaces:**
- Consumes: `selectJobCost` (`@savvy/core`), `supplierInvoice`, `job`, `materialOrder`.
- Produces:
  - `recomputeJobActualCost(tenantId: string, jobId: string): Promise<void>` — sets `job.costCents = selectJobCost({ actualsCents: sum(parsed supplier_invoice.total_cents > 0 for the job), estimateCents: sum(material_order.cost_subtotal_cents for ordered/delivered) })`.
  - `saveParsedSupplierInvoice(tenantId: string, id: string, parsed: { supplierName; invoiceNumber; invoiceDate: Date | null; totalCents; lines: SupplierInvoiceLine[]; confidence; jobId: string | null }): Promise<void>` — updates the row to `status="parsed"` with parsed fields + jobId.

- [ ] **Step 1: Write the failing test**

Create `packages/db/src/lifecycle/supplier-invoice.test.ts` (seed a tenant + job + a material order + two parsed supplier invoices; assert `job.costCents` = sum of positive supplier-invoice totals):

```ts
import { it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { adminDb, tenant, customer, property, job, materialOrder, supplierInvoice, eq } from "../index.js";
import { recomputeJobActualCost } from "./supplier-invoice.js";

let tenantId: string, jobId: string;

beforeAll(async () => {
  tenantId = randomUUID();
  await adminDb.insert(tenant).values({ id: tenantId, name: "Cost Co", publicKey: `cc-${tenantId.slice(0, 8)}` });
  const [c] = await adminDb.insert(customer).values({ tenantId, name: "C" }).returning();
  const [p] = await adminDb.insert(property).values({ tenantId, customerId: c!.id, address: "1 Cost St" }).returning();
  const [j] = await adminDb.insert(job).values({ tenantId, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "production" }).returning();
  jobId = j!.id;
});
afterAll(async () => {
  await adminDb.delete(supplierInvoice).where(eq(supplierInvoice.tenantId, tenantId));
  await adminDb.delete(materialOrder).where(eq(materialOrder.tenantId, tenantId));
  await adminDb.delete(job).where(eq(job.tenantId, tenantId));
  await adminDb.delete(property).where(eq(property.tenantId, tenantId));
  await adminDb.delete(customer).where(eq(customer.tenantId, tenantId));
  await adminDb.delete(tenant).where(eq(tenant.id, tenantId));
});

it("sets job.costCents to the sum of parsed supplier-invoice actuals", async () => {
  await adminDb.insert(supplierInvoice).values([
    { tenantId, jobId, status: "parsed", totalCents: 500000, externalMessageId: `a-${randomUUID()}` },
    { tenantId, jobId, status: "parsed", totalCents: 312300, externalMessageId: `b-${randomUUID()}` },
  ]);
  await recomputeJobActualCost(tenantId, jobId);
  const [row] = await adminDb.select({ costCents: job.costCents }).from(job).where(eq(job.id, jobId));
  expect(row!.costCents).toBe(812300);
});

it("falls back to the material-order estimate when no parsed actuals exist", async () => {
  const t2 = randomUUID();
  await adminDb.insert(tenant).values({ id: t2, name: "Est Co", publicKey: `ec-${t2.slice(0, 8)}` });
  const [c] = await adminDb.insert(customer).values({ tenantId: t2, name: "C2" }).returning();
  const [p] = await adminDb.insert(property).values({ tenantId: t2, customerId: c!.id, address: "2 Est St" }).returning();
  const [j] = await adminDb.insert(job).values({ tenantId: t2, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "production" }).returning();
  const [est] = await adminDb.insert(job).values({ tenantId: t2, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "estimate" }).returning();
  await adminDb.insert(materialOrder).values({ tenantId: t2, jobId: j!.id, estimateId: est!.id, status: "ordered", lineItems: [], subtotalCents: 0, costSubtotalCents: 790000 });
  await recomputeJobActualCost(t2, j!.id);
  const [row] = await adminDb.select({ costCents: job.costCents }).from(job).where(eq(job.id, j!.id));
  expect(row!.costCents).toBe(790000);
  await adminDb.delete(materialOrder).where(eq(materialOrder.tenantId, t2));
  await adminDb.delete(job).where(eq(job.tenantId, t2));
  await adminDb.delete(property).where(eq(property.tenantId, t2));
  await adminDb.delete(customer).where(eq(customer.tenantId, t2));
  await adminDb.delete(tenant).where(eq(tenant.id, t2));
});
```

(Note: `materialOrder.estimateId` is `unique notNull` — the test creates a throwaway `estimate`-stage job to satisfy the FK; confirm `materialOrder` required columns against `packages/db/src/schema/procurement.ts` and adjust the insert.)

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/db && pnpm exec vitest run src/lifecycle/supplier-invoice.test.ts`
Expected: FAIL — `./supplier-invoice.js` missing. (Requires the DB; CI-provided.)

- [ ] **Step 3: Implement**

Create `packages/db/src/lifecycle/supplier-invoice.ts`:

```ts
import { and, eq, gt, inArray, sql } from "drizzle-orm";
import { selectJobCost, type SupplierInvoiceLine } from "@savvy/core";
import { withTenant } from "../tenant.js";
import { job, materialOrder, supplierInvoice } from "../schema/index.js";

/** Recompute job.costCents from parsed supplier-invoice actuals, falling back to the material-order estimate. */
export async function recomputeJobActualCost(tenantId: string, jobId: string): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    const [actuals] = await tx
      .select({ total: sql<number>`coalesce(sum(${supplierInvoice.totalCents}), 0)::int` })
      .from(supplierInvoice)
      .where(and(eq(supplierInvoice.jobId, jobId), eq(supplierInvoice.status, "parsed"), gt(supplierInvoice.totalCents, 0)));
    const [estimate] = await tx
      .select({ total: sql<number>`coalesce(sum(${materialOrder.costSubtotalCents}), 0)::int` })
      .from(materialOrder)
      .where(and(eq(materialOrder.jobId, jobId), inArray(materialOrder.status, ["ordered", "delivered"])));
    const costCents = selectJobCost({ actualsCents: actuals?.total ?? 0, estimateCents: estimate?.total ?? 0 });
    await tx.update(job).set({ costCents }).where(eq(job.id, jobId));
  });
}

/** Persist a parsed invoice: fields + lines + matched job + status=parsed. */
export async function saveParsedSupplierInvoice(
  tenantId: string,
  id: string,
  parsed: { supplierName: string | null; invoiceNumber: string | null; invoiceDate: Date | null; totalCents: number; lines: SupplierInvoiceLine[]; confidence: number; jobId: string | null },
): Promise<void> {
  await withTenant(tenantId, (tx) =>
    tx.update(supplierInvoice).set({
      supplierName: parsed.supplierName, invoiceNumber: parsed.invoiceNumber, invoiceDate: parsed.invoiceDate,
      totalCents: parsed.totalCents, lines: parsed.lines, parseConfidence: parsed.confidence,
      jobId: parsed.jobId, status: "parsed", updatedAt: new Date(),
    }).where(eq(supplierInvoice.id, id)),
  );
}
```

- [ ] **Step 4: Export + verify pass**

Add to `packages/db/src/index.ts`: `export { recomputeJobActualCost, saveParsedSupplierInvoice } from "./lifecycle/supplier-invoice.js";`
Run: `cd packages/db && pnpm exec vitest run src/lifecycle/supplier-invoice.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm --filter @savvy/db typecheck
git add packages/db/src/lifecycle/supplier-invoice.ts packages/db/src/lifecycle/supplier-invoice.test.ts packages/db/src/index.ts
git commit -m "feat(db): recomputeJobActualCost + saveParsedSupplierInvoice"
```

---

### Task 3: Agents — `parseSupplierInvoice` Inngest function

**Files:**
- Create: `packages/agents/src/functions/supplier-invoice-parse.ts` (handler + function)
- Modify: `packages/agents/src/client.ts` (register `supplier-invoice/parsed` event)
- Modify: `packages/agents/src/index.ts` (add function to the exported `functions` array)
- Create: `packages/agents/src/functions/supplier-invoice-parse.test.ts` (handler unit test, stub AI client)

**Interfaces:**
- Consumes: `completeObject` (`@savvy/ai`), `supplierInvoiceParseSchema`/`selectJobCost` (`@savvy/core`), `recomputeJobActualCost`/`saveParsedSupplierInvoice` (`@savvy/db`), `r2Storage.presignDownload` (`@savvy/integrations`), `supplier-invoice/received` event (13a).
- Produces: `parseSupplierInvoiceHandler(input: { tenantId; supplierInvoiceId; documentId }, deps: { ai: { completeObject: typeof completeObject }; fetchBytes: (key: string) => Promise<Uint8Array>; loadDocKey: (tenantId, documentId) => Promise<string | null>; matchJob: (tenantId, parsed) => Promise<string | null> }): Promise<{ status: "parsed" | "parse_failed" }>`; event `"supplier-invoice/parsed": { data: { tenantId; supplierInvoiceId; jobId: string | null } }`.

Handler logic: load the document R2 key → fetch bytes → `ai.completeObject({ capability: "reasoning", schema: supplierInvoiceParseSchema, prompt })` → `matchJob` → `saveParsedSupplierInvoice` → `recomputeJobActualCost` (if matched) → return `parsed`. Any throw → set `status="parse_failed"` + return `parse_failed` (fail-soft).

- [ ] **Step 1: Write the failing handler test** (stub AI returns a canned parse; assert save + cost recompute called, and fail-soft on AI throw). Full test body:

```ts
import { it, expect, vi } from "vitest";
import { parseSupplierInvoiceHandler } from "./supplier-invoice-parse";

const parsed = { supplierName: "ABC Supply", invoiceNumber: "INV-9", invoiceDate: "2026-07-01", totalCents: 812300,
  lines: [{ description: "GAF HDZ Charcoal", quantity: 30, unitBilledCents: 27000, amountBilledCents: 810000 }], confidence: 0.92 };

const baseDeps = () => ({
  ai: { completeObject: vi.fn().mockResolvedValue({ object: parsed, model: "stub" }) },
  fetchBytes: vi.fn().mockResolvedValue(new Uint8Array([1])),
  loadDocKey: vi.fn().mockResolvedValue("tenant/t/supplier-invoice/x.pdf"),
  matchJob: vi.fn().mockResolvedValue("job-1"),
  save: vi.fn().mockResolvedValue(undefined),
  recompute: vi.fn().mockResolvedValue(undefined),
});

it("parses, saves, and recomputes job cost", async () => {
  const deps = baseDeps();
  const res = await parseSupplierInvoiceHandler({ tenantId: "t", supplierInvoiceId: "si", documentId: "d" }, deps);
  expect(res.status).toBe("parsed");
  expect(deps.save).toHaveBeenCalledWith("t", "si", expect.objectContaining({ jobId: "job-1", totalCents: 812300 }));
  expect(deps.recompute).toHaveBeenCalledWith("t", "job-1");
});

it("is fail-soft: an AI error marks parse_failed and does not throw", async () => {
  const deps = baseDeps();
  deps.ai.completeObject = vi.fn().mockRejectedValue(new Error("bad pdf"));
  deps.markFailed = vi.fn().mockResolvedValue(undefined);
  const res = await parseSupplierInvoiceHandler({ tenantId: "t", supplierInvoiceId: "si", documentId: "d" }, deps as never);
  expect(res.status).toBe("parse_failed");
});
```

Adjust `Deps` in the handler to accept `save`, `recompute`, `markFailed` (thin wrappers over the db fns) so the handler is pure-testable — the Inngest `createFunction` wiring passes the real `saveParsedSupplierInvoice`/`recomputeJobActualCost`/a status setter.

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/agents && pnpm exec vitest run src/functions/supplier-invoice-parse.test.ts`
Expected: FAIL — handler missing.

- [ ] **Step 3: Implement the handler + function** — model on `estimate-generate.ts`. The handler takes injected deps (as the test shows); the exported `parseSupplierInvoice = inngest.createFunction({ id, concurrency: { limit: 5, key: "event.data.tenantId" }, retries: 2 }, { event: "supplier-invoice/received" }, async ({ event, step }) => …)` wires real deps via `step.run` boundaries (load key, fetch, parse, save, recompute) and emits `supplier-invoice/parsed`. Register the event in `client.ts` and add the function to `index.ts`'s `functions` array. Include a `PARSE_SYSTEM`/`PARSE_PROMPT` constant instructing extraction of supplier, invoice number/date, per-line qty + unit + billed unit/amount cents, and total.

- [ ] **Step 4: Run to verify it passes**

Run: `cd packages/agents && pnpm exec vitest run src/functions/supplier-invoice-parse.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm --filter @savvy/agents typecheck
git add packages/agents/src/functions/supplier-invoice-parse.ts packages/agents/src/functions/supplier-invoice-parse.test.ts packages/agents/src/client.ts packages/agents/src/index.ts
git commit -m "feat(agents): parseSupplierInvoice — gateway parse → save + recompute job cost"
```

---

### Task 4: Web — wire real `GM·MTD` on Money

**Files:**
- Modify: `apps/web/src/lib/money-queries.ts` (replace `gmMtdPct: null` with a real MTD-GM query using `computeMtdGrossMargin`)
- Modify: `apps/web/tests/e2e/money-console.spec.ts` (assert GM shows a % once a costed job is invoiced this month)

**Interfaces:**
- Consumes: `computeMtdGrossMargin`, `computeJobMargin` (`@savvy/core`); `job`, `invoice` (`@savvy/db`).

- [ ] **Step 1: Implement the GM query** — in `getMoneyKpis`, add a query loading this month's invoiced jobs (`job` joined to a non-draft `invoice` with `created_at >= date_trunc('month', now())`), selecting `revenueCents = valueFinal ?? valueEstimate` and `costCents = job.costCents`; pass to `computeMtdGrossMargin`; return that as `gmMtdPct`. Keep the `MoneyKpis` type unchanged (`number | null`).

- [ ] **Step 2: Update the Money page GM cell** — in `apps/web/src/app/(app)/money/page.tsx`, render `kpis.gmMtdPct != null ? `${kpis.gmMtdPct}%` : "est —"` for the GM KPI (it currently hardcodes `"est —"`). Keep `data-testid` intact.

- [ ] **Step 3: Extend the money e2e** — seed a job with `costCents` + `valueFinal` + a `sent` invoice dated this month, load `/money`, assert the GM KPI shows a `%` (not `est —`).

- [ ] **Step 4: Typecheck + lint + commit**

```bash
pnpm --filter @savvy/web typecheck && pnpm --filter @savvy/web lint
git add apps/web/src/lib/money-queries.ts "apps/web/src/app/(app)/money/page.tsx" apps/web/tests/e2e/money-console.spec.ts
git commit -m "feat(web): real GM·MTD on Money from job cost actuals"
```

---

### Task 5: E2E — parse pipeline end-to-end (AI-stubbed)

**Files:**
- Modify: `apps/web/tests/e2e/ai-stub.mjs` (return a canned supplier-invoice parse for the parse prompt) — inspect its request-routing first; it keys off the model/prompt.
- Create: `apps/web/tests/e2e/supplier-invoice-parse.spec.ts`

- [ ] **Step 1: Teach the AI stub the parse response** — read `apps/web/tests/e2e/ai-stub.mjs`; add a branch that, when the prompt looks like a supplier-invoice parse (match on a sentinel phrase in `PARSE_PROMPT`), returns the structured object matching `supplierInvoiceParseSchema`. Keep existing branches intact.

- [ ] **Step 2: Write the e2e** — seed a job + material order (so match + fallback exist); POST a forwarded invoice referencing that job to `/api/inbound/supplier-invoice`; wait for the Inngest dev server to run `parseSupplierInvoice` (poll the `supplier_invoice` row until `status="parsed"`, `expect.poll`); assert the row parsed + `job.costCents` updated to the parsed total. Model the poll on existing Inngest e2e (e.g. `companycam.spec.ts` / `change-order.spec.ts`).

- [ ] **Step 3: Commit**

```bash
git add apps/web/tests/e2e/ai-stub.mjs apps/web/tests/e2e/supplier-invoice-parse.spec.ts
git commit -m "test(e2e): supplier-invoice parse pipeline → real job cost (AI-stubbed)"
```

---

## Slice 13b — Definition of Done

- [ ] A received supplier invoice is AI-parsed into `supplier_invoice.lines` + `status=parsed`, matched to a job.
- [ ] `job.costCents` reflects parsed supplier-invoice actuals (fallback to material-order estimate), verified by the db test.
- [ ] Money `GM·MTD` shows a real % once a costed job is invoiced this month; `—` otherwise.
- [ ] Parse is fail-soft (`parse_failed` on bad input, no queue wedging).
- [ ] `pnpm typecheck` + `pnpm lint` clean; packages vitest + web e2e green; PR squash-merged.
- [ ] **Next:** run writing-plans for slice 13c (price-guard vs material-order snapshot → confidence-gated auto-credit → credit-memo auto-recovery → `finance.price_guard` invariant).

## Self-Review

- **Spec coverage (§5):** parse via gateway ✓ (Task 3); job match ✓ (Task 3 `matchJob`); persist lines + confidence ✓ (Task 2 `saveParsedSupplierInvoice`); actuals → `job.costCents` with fallback ✓ (Task 2 `recomputeJobActualCost` + Task 1 `selectJobCost`); Money `GM·MTD` real ✓ (Task 4). Fail-soft ✓ (Task 3). `supplier-invoice/parsed` emitted for 13c ✓.
- **Placeholder scan:** the AI-stub branch (Task 5.1) and `matchJob` heuristic are described with concrete match criteria; no TBD. The Inngest `createFunction` wiring (Task 3.3) references the tested handler + named deps — real, not placeholder.
- **Type consistency:** `selectJobCost` signature matches between Task 1 (def), Task 2 (consumer), and the handler; `supplierInvoiceParseSchema` shape matches the AI stub (Task 5) + handler; event `supplier-invoice/parsed { tenantId, supplierInvoiceId, jobId }` matches registration + emit.
