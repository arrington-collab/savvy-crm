# Honor `automationLevel` at Runtime (C Part 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make agents honor `job_task.automationLevel` at runtime — when an agent would auto-perform work tied to a non-`full` task it defers to a human (logs a skipped agent_run, marks the task, surfaces it in `/exceptions`). Proven end-to-end on estimate generation, via a reusable gate primitive.

**Architecture:** A pure `shouldAutoAct` (core) + a `gateAgentAutomation` db primitive that reads the owning task's level and, on non-full, sets a durable `job_task.deferred_at` marker and logs `agent_run('skipped')`. `estimate-generate` calls the gate as its first step. A new `task_needs_approval` exception vector surfaces deferred tasks in `/exceptions`. Gate is dormant by default (template marks the estimate task `full`) → zero behavior change for existing jobs/tests.

**Tech Stack:** TypeScript, Drizzle ORM (Postgres + RLS), Inngest, Vitest (core unit + db/agents integration), Playwright (web e2e).

## Global Constraints

- **`.js` import rule:** db/agents `.test.ts` files USE `.js` extensions on relative imports; core/web/db/agents **source** files use NO `.js` (Turbopack). Inside `packages/core`, import other core modules by plain relative path.
- **apps/web is NOT in the vitest workspace** — verify the web layer via `pnpm typecheck` + Playwright e2e only.
- **`shouldAutoAct` rule:** only `full` auto-acts; `partial`/`manual`/null/unknown → defer (return false).
- **`resolveTaskAutomation` default:** when no `job_task` matches `(jobId, taskKey)`, return `"full"` — an unmapped key must never block an agent.
- **Gate is dormant by default:** the template marks `estimating-049` `automationLevel: "full"`, so the existing suite (which doesn't set tasks non-full) must stay green. **Do not change the template.**
- **`ESTIMATE_TASK_KEY = "estimating-049"`** — the owning task for estimate generation. `agent: "claims"` matches its template `ownerAgent`.
- **Migration discipline (CI gotcha):** after `pnpm db:generate`, the generated `.sql` AND its drizzle meta (`packages/db/drizzle/meta/_journal.json` entry + the new `NNNN_snapshot.json`) MUST all be committed — CI runs migrations on a FRESH DB and silently skips a migration whose journal entry is missing. Inspect the generated SQL: it must be a plain `ALTER TABLE "job_task" ADD COLUMN "deferred_at" timestamptz;` with NO unintended drops.
- **Two required ExceptionQueueInput fields now:** D2b added `materialDeliveries`; this slice adds `taskNeedsApprovals`. Both required → every `buildExceptionQueue` caller (the core test + `exception-queries.ts`) must pass them; typecheck enforces it.
- **e2e:** assertions scope to per-run stamped customer names — never `queue.total` (shared e2e tenant aggregates all rows).
- **Tenant isolation:** all queries via `withTenant`; the new column lives on the already-RLS'd `job_task`.
- Focused test commands:
  - core → `pnpm --filter @savvy/core exec vitest run src/task-automation.test.ts src/exception-queue.test.ts`
  - db → `pnpm --filter @savvy/db exec vitest run tests/task-automation.test.ts` (needs docker `savvy_db`; `pnpm db:up && pnpm --filter @savvy/db db:migrate` if `ECONNREFUSED`)
  - agents → `pnpm --filter @savvy/agents exec vitest run src/functions/estimate-generate.test.ts`
  - e2e → from `apps/web`: `npx tsx tests/e2e/create-tenant.ts && export TEST_TENANT_ID=$(node -e "console.log(require('/tmp/savvy-e2e-tenant.json').id)") && ./node_modules/.bin/playwright test tests/e2e/automation-defer.spec.ts`
- Final gate: `pnpm test && pnpm typecheck && pnpm lint` all green.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `packages/core/src/task-automation.ts` | `shouldAutoAct` pure helper | Create |
| `packages/core/src/task-automation.test.ts` | unit tests for it | Create |
| `packages/core/src/index.ts` | export the new module | Modify (append) |
| `packages/db/src/schema/jobs.ts` | add `deferredAt` column to `jobTask` | Modify |
| `packages/db/drizzle/*` | generated migration + meta | Create (via `db:generate`) |
| `packages/db/src/lifecycle/task-automation.ts` | `resolveTaskAutomation` + `gateAgentAutomation` | Create |
| `packages/db/src/index.ts` | export the new lifecycle fns | Modify |
| `packages/db/tests/task-automation.test.ts` | gate integration tests | Create |
| `packages/agents/src/functions/estimate-generate.ts` | gate as first step | Modify |
| `packages/core/src/exception-queue.ts` | `task_needs_approval` vector | Modify |
| `packages/core/src/exception-queue.test.ts` | vector tests + add field to inputs | Modify |
| `apps/web/src/lib/exception-queries.ts` | 6th query (deferred tasks) | Modify |
| `apps/web/src/app/(app)/exceptions/page.tsx` | `KIND_LABEL` entry | Modify |
| `apps/web/tests/e2e/automation-defer.spec.ts` | e2e: deferred task → /exceptions | Create |
| `docs/jobs-pipeline.md` | document the gate + vector | Modify |

---

## Task 1: Core — `shouldAutoAct` (haiku)

**Files:**
- Create: `packages/core/src/task-automation.ts`
- Create: `packages/core/src/task-automation.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Produces: `shouldAutoAct(level: string | null | undefined): boolean`.

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/task-automation.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { shouldAutoAct } from "./task-automation";

describe("shouldAutoAct", () => {
  it("only full auto-acts", () => {
    expect(shouldAutoAct("full")).toBe(true);
    expect(shouldAutoAct(" Full ")).toBe(true);
    expect(shouldAutoAct("partial")).toBe(false);
    expect(shouldAutoAct("manual")).toBe(false);
    expect(shouldAutoAct(null)).toBe(false);
    expect(shouldAutoAct(undefined)).toBe(false);
    expect(shouldAutoAct("whatever")).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @savvy/core exec vitest run src/task-automation.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `packages/core/src/task-automation.ts`:
```ts
/** Only `full`-automation tasks run without a human. partial/manual/unknown defer. */
export function shouldAutoAct(level: string | null | undefined): boolean {
  return (level ?? "").trim().toLowerCase() === "full";
}
```

Append to `packages/core/src/index.ts` (at the END):
```ts
export * from "./task-automation";
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @savvy/core exec vitest run src/task-automation.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/task-automation.ts packages/core/src/task-automation.test.ts packages/core/src/index.ts
git commit -m "feat(core): shouldAutoAct automation-gate helper"
```

---

## Task 2: DB — `deferred_at` column + gate primitive (sonnet)

**Files:**
- Modify: `packages/db/src/schema/jobs.ts`
- Create: migration via `pnpm db:generate`
- Create: `packages/db/src/lifecycle/task-automation.ts`
- Modify: `packages/db/src/index.ts`
- Test: `packages/db/tests/task-automation.test.ts`

**Interfaces:**
- Consumes: `shouldAutoAct` (Task 1); `recordAgentRun`, `jobTask` from db.
- Produces:
  - `resolveTaskAutomation(tx, jobId: string, taskKey: string): Promise<string>` — owning task's level, default `"full"`.
  - `gateAgentAutomation(input: { tenantId: string; jobId: string; taskKey: string; agent: Agent }): Promise<{ proceed: boolean; level: string }>`.

- [ ] **Step 1: Add the column to the schema**

In `packages/db/src/schema/jobs.ts`, add to the `jobTask` table definition (next to `completedAt`):
```ts
  deferredAt: timestamp("deferred_at", { withTimezone: true }),
```
(Confirm `timestamp` is already imported in that file — it is, used by `dueAt`/`completedAt`.)

- [ ] **Step 2: Generate + inspect + apply the migration**

```bash
pnpm db:generate
```
Inspect the newest `packages/db/drizzle/NNNN_*.sql`: it must be exactly
`ALTER TABLE "job_task" ADD COLUMN "deferred_at" timestamp with time zone;` (no drops). Confirm
`packages/db/drizzle/meta/_journal.json` gained the new entry and a new `NNNN_snapshot.json` exists.
Then apply (start the DB first if needed):
```bash
pnpm db:up && pnpm --filter @savvy/db db:migrate
```

- [ ] **Step 3: Write the failing gate tests**

Create `packages/db/tests/task-automation.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { withTenant } from "../src/tenant.js";
import { resolveTaskAutomation, gateAgentAutomation } from "../src/lifecycle/task-automation.js";
import { jobTask, agentRun } from "../src/schema/index.js";
import { adminDb } from "../src/admin-client.js";
import { eq, and } from "drizzle-orm";
import { makeTenant, makeJobWithCustomer } from "./helpers.js";

const KEY = "estimating-049";

async function seedTaskedJob(level: string): Promise<{ tenantId: string; jobId: string }> {
  const { tenantId } = await makeTenant();
  const { jobId } = await makeJobWithCustomer(tenantId);
  await adminDb.insert(jobTask).values({ tenantId, jobId, key: KEY, title: "Estimate import", automationLevel: level as never, status: "pending" });
  return { tenantId, jobId };
}

describe("resolveTaskAutomation", () => {
  it("returns the task's level, or 'full' when no matching task", async () => {
    const { tenantId, jobId } = await seedTaskedJob("manual");
    const lvl = await withTenant(tenantId, (tx) => resolveTaskAutomation(tx, jobId, KEY));
    expect(lvl).toBe("manual");
    const missing = await withTenant(tenantId, (tx) => resolveTaskAutomation(tx, jobId, "nope-999"));
    expect(missing).toBe("full");
  });
});

describe("gateAgentAutomation", () => {
  it("proceeds for a full task and writes no defer marker / no skip log", async () => {
    const { tenantId, jobId } = await seedTaskedJob("full");
    const res = await gateAgentAutomation({ tenantId, jobId, taskKey: KEY, agent: "claims" });
    expect(res).toEqual({ proceed: true, level: "full" });
    const [t] = await withTenant(tenantId, (tx) => tx.select({ d: jobTask.deferredAt }).from(jobTask).where(and(eq(jobTask.jobId, jobId), eq(jobTask.key, KEY))));
    expect(t!.d).toBeNull();
    const runs = await withTenant(tenantId, (tx) => tx.select().from(agentRun).where(eq(agentRun.jobId, jobId)));
    expect(runs).toHaveLength(0);
  });

  it("defers a manual task: sets deferred_at + writes a skipped agent_run", async () => {
    const { tenantId, jobId } = await seedTaskedJob("manual");
    const res = await gateAgentAutomation({ tenantId, jobId, taskKey: KEY, agent: "claims" });
    expect(res).toEqual({ proceed: false, level: "manual" });
    const [t] = await withTenant(tenantId, (tx) => tx.select({ d: jobTask.deferredAt }).from(jobTask).where(and(eq(jobTask.jobId, jobId), eq(jobTask.key, KEY))));
    expect(t!.d).not.toBeNull();
    const runs = await withTenant(tenantId, (tx) => tx.select().from(agentRun).where(and(eq(agentRun.jobId, jobId), eq(agentRun.status, "skipped"))));
    expect(runs).toHaveLength(1);
    expect(runs[0]!.taskKey).toBe(KEY);
  });

  it("defers a partial task too (only full auto-acts)", async () => {
    const { tenantId, jobId } = await seedTaskedJob("partial");
    const res = await gateAgentAutomation({ tenantId, jobId, taskKey: KEY, agent: "claims" });
    expect(res.proceed).toBe(false);
  });
});
```

- [ ] **Step 4: Run to verify they fail**

Run: `pnpm --filter @savvy/db exec vitest run tests/task-automation.test.ts`
Expected: FAIL — `resolveTaskAutomation`/`gateAgentAutomation` not exported.

- [ ] **Step 5: Implement the lifecycle module**

Create `packages/db/src/lifecycle/task-automation.ts`:
```ts
import { and, eq, sql } from "drizzle-orm";
import { jobTask } from "../schema/index";
import { db } from "../client";
import { withTenant } from "../tenant";
import { recordAgentRun } from "./agent-run";
import { shouldAutoAct } from "@savvy/core";
import type { Agent } from "@savvy/core";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** The owning task's automationLevel for (jobId, key); "full" when no task matches (never blocks). */
export async function resolveTaskAutomation(tx: Tx, jobId: string, taskKey: string): Promise<string> {
  const [t] = await tx
    .select({ level: jobTask.automationLevel })
    .from(jobTask)
    .where(and(eq(jobTask.jobId, jobId), eq(jobTask.key, taskKey)))
    .limit(1);
  return t?.level ?? "full";
}

/**
 * Runtime automation gate. Reads the owning task's automationLevel; if it is not
 * `full`, DEFERS: marks the task `deferred_at = now` (so it surfaces in /exceptions)
 * and logs a skipped agent_run. Returns whether the caller may proceed.
 */
export async function gateAgentAutomation(input: {
  tenantId: string; jobId: string; taskKey: string; agent: Agent;
}): Promise<{ proceed: boolean; level: string }> {
  const level = await withTenant(input.tenantId, (tx) => resolveTaskAutomation(tx, input.jobId, input.taskKey));
  if (shouldAutoAct(level)) return { proceed: true, level };

  await withTenant(input.tenantId, (tx) =>
    tx.update(jobTask)
      .set({ deferredAt: new Date() })
      .where(and(
        eq(jobTask.jobId, input.jobId),
        eq(jobTask.key, input.taskKey),
        sql`${jobTask.status} not in ('done','skipped')`,
      )),
  );
  await recordAgentRun({
    tenantId: input.tenantId, agent: input.agent, taskKey: input.taskKey, jobId: input.jobId,
    status: "skipped", error: `automation:${level} — deferred to human`,
  });
  return { proceed: false, level };
}
```

Add to `packages/db/src/index.ts` (with the other lifecycle re-exports):
```ts
export { resolveTaskAutomation, gateAgentAutomation } from "./lifecycle/task-automation";
```

- [ ] **Step 6: Run to verify they pass**

Run: `pnpm --filter @savvy/db exec vitest run tests/task-automation.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 7: Commit**

```bash
git add packages/db/src/schema/jobs.ts packages/db/drizzle packages/db/src/lifecycle/task-automation.ts packages/db/src/index.ts packages/db/tests/task-automation.test.ts
git commit -m "feat(db): job_task.deferred_at + gateAgentAutomation runtime automation gate"
```

---

## Task 3: Agents — wire `estimate-generate` to the gate (sonnet)

**Files:**
- Modify: `packages/agents/src/functions/estimate-generate.ts`

**Interfaces:**
- Consumes: `gateAgentAutomation` from `@savvy/db`.

- [ ] **Step 1: Add the gate as the first step**

In `packages/agents/src/functions/estimate-generate.ts`:

(a) add `gateAgentAutomation` to the `@savvy/db` import (the line that imports `withTenant, eq, createEstimateFromMeasurement, estimate, measurement, priceBookItem`):
```ts
import { withTenant, eq, createEstimateFromMeasurement, estimate, measurement, priceBookItem, gateAgentAutomation } from "@savvy/db";
```

(b) add the task-key constant near the top (after imports):
```ts
/** Seeded template task that represents "parse the measurement into an estimate". */
const ESTIMATE_TASK_KEY = "estimating-049";
```

(c) inside `generateEstimateOnMeasurement`'s handler, make the gate the FIRST step — before the `generate` step:
```ts
  async ({ event, step }) => {
    const { tenantId, jobId, measurementId } = event.data;

    // Runtime automation gate: defer to a human if the owning task isn't full-auto.
    const gate = await step.run("gate", () =>
      gateAgentAutomation({ tenantId, jobId, taskKey: ESTIMATE_TASK_KEY, agent: "claims" }));
    if (!gate.proceed) return { skipped: "automation_deferred", level: gate.level };

    // Step 1: generate the deterministic estimate from the price book.
    const est = await step.run("generate", () =>
      createEstimateFromMeasurement({ tenantId, jobId, measurementId }),
    );
    // ... (rest unchanged)
```

- [ ] **Step 2: Typecheck + confirm the existing agents test still passes**

Run: `pnpm typecheck`
Expected: PASS.
Run: `pnpm --filter @savvy/agents exec vitest run src/functions/estimate-generate.test.ts`
Expected: PASS (the `generateUpsells` tests are untouched; no full-function test exists to gate).

- [ ] **Step 3: Commit**

```bash
git add packages/agents/src/functions/estimate-generate.ts
git commit -m "feat(agents): estimate-generate honors automationLevel via gateAgentAutomation"
```

---

## Task 4: Core — `task_needs_approval` exception vector (haiku)

**Files:**
- Modify: `packages/core/src/exception-queue.ts`
- Test: `packages/core/src/exception-queue.test.ts`

**Interfaces:**
- Produces: `ExceptionKind` += `"task_needs_approval"`; `TaskNeedsApprovalInput`; `ExceptionQueueInput.taskNeedsApprovals` (required).

- [ ] **Step 1: Write the failing tests**

In `packages/core/src/exception-queue.test.ts`: first add `taskNeedsApprovals: []` to EVERY existing `buildExceptionQueue` input (the `base` const at line ~4, the `baseInput` at line ~78, and every inline call) so existing tests compile. Then append:
```ts
describe("buildExceptionQueue task_needs_approval vector", () => {
  const base = { atRiskJobs: [], overdueInvoices: [], missedAppointments: [], overdueTasks: [], materialDeliveries: [] };
  it("emits a medium needs-approval item", () => {
    const deferredAt = new Date("2026-07-03T00:00:00Z");
    const q = buildExceptionQueue({
      ...base,
      taskNeedsApprovals: [{ taskId: "t1", jobId: "j1", title: "Estimate import", customerName: "Appro Amy", deferredAt }],
    });
    const row = q.items.find((i) => i.kind === "task_needs_approval");
    expect(row).toBeTruthy();
    expect(row!.severity).toBe("medium");
    expect(row!.title).toBe("Appro Amy");
    expect(row!.detail).toBe("Needs approval: Estimate import");
    expect(row!.href).toBe("/jobs/j1");
    expect(row!.occurredAt).toEqual(deferredAt);
    expect(q.counts.task_needs_approval).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @savvy/core exec vitest run src/exception-queue.test.ts`
Expected: FAIL — `task_needs_approval` not assignable / `taskNeedsApprovals` missing.

- [ ] **Step 3: Implement**

In `packages/core/src/exception-queue.ts`:

(a) extend the kind union + `KINDS`:
```ts
export type ExceptionKind = "job_at_risk" | "invoice_overdue" | "appointment_missed" | "task_overdue" | "material_delivery" | "task_needs_approval";
```
```ts
const KINDS: ExceptionKind[] = ["job_at_risk", "invoice_overdue", "appointment_missed", "task_overdue", "material_delivery", "task_needs_approval"];
```

(b) add the input type (next to the other `*Input` types):
```ts
export type TaskNeedsApprovalInput = { taskId: string; jobId: string; title: string; customerName: string | null; deferredAt: Date };
```

(c) add the field to `ExceptionQueueInput`:
```ts
  taskNeedsApprovals: TaskNeedsApprovalInput[];
```

(d) add the loop after the `materialDeliveries` loop and before the sort block:
```ts
  for (const t of input.taskNeedsApprovals) {
    items.push({
      kind: "task_needs_approval",
      severity: "medium",
      title: t.customerName ?? "—",
      detail: `Needs approval: ${t.title}`,
      href: `/jobs/${t.jobId}`,
      occurredAt: t.deferredAt,
    });
  }
```

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm --filter @savvy/core exec vitest run src/exception-queue.test.ts`
Expected: PASS (existing + new).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/exception-queue.ts packages/core/src/exception-queue.test.ts
git commit -m "feat(core): task_needs_approval exception vector"
```

---

## Task 5: Web — gather deferred tasks + page label (sonnet)

**Files:**
- Modify: `apps/web/src/lib/exception-queries.ts`
- Modify: `apps/web/src/app/(app)/exceptions/page.tsx`

**Interfaces:**
- Consumes: `TaskNeedsApprovalInput` (Task 4); `jobTask` from `@savvy/db`.

- [ ] **Step 1: Add the 6th query**

In `apps/web/src/lib/exception-queries.ts`:

(a) add `jobTask` to the `@savvy/db` import if not already present (it currently imports `withTenant, job, invoice, appointment, jobTask, customer, tenant, materialOrder, eq, or, sql` — `jobTask` IS already there). Add `TaskNeedsApprovalInput` to the `@savvy/core` type import.

(b) add this block AFTER the `materialDeliveries` block and BEFORE the final `return buildExceptionQueue(...)`:
```ts
    // --- tasks an agent deferred to a human (deferred_at set, not yet resolved) ---
    const deferredRows = await tx
      .select({ taskId: jobTask.id, jobId: jobTask.jobId, title: jobTask.title, deferredAt: jobTask.deferredAt, customerName: customer.name })
      .from(jobTask)
      .leftJoin(job, eq(job.id, jobTask.jobId))
      .leftJoin(customer, eq(customer.id, job.customerId))
      .where(sql`${jobTask.deferredAt} is not null and ${jobTask.status} not in ('done','skipped')`);
    const taskNeedsApprovals: TaskNeedsApprovalInput[] = deferredRows.map((r) => ({
      taskId: r.taskId, jobId: r.jobId, title: r.title, customerName: r.customerName, deferredAt: r.deferredAt as Date,
    }));
```

(c) update the final return to include the new vector:
```ts
    return buildExceptionQueue({ atRiskJobs, overdueInvoices, missedAppointments, overdueTasks, materialDeliveries, taskNeedsApprovals });
```

- [ ] **Step 2: Add the page label**

In `apps/web/src/app/(app)/exceptions/page.tsx`, add to `KIND_LABEL`:
```ts
  task_needs_approval: "Needs approval",
```

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: PASS — proves `taskNeedsApprovals` is supplied at the call site and the row maps cleanly.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/lib/exception-queries.ts "apps/web/src/app/(app)/exceptions/page.tsx"
git commit -m "feat(web): surface agent-deferred tasks in the exception queue"
```

---

## Task 6: e2e + docs + full verification (sonnet)

**Files:**
- Create: `apps/web/tests/e2e/automation-defer.spec.ts`
- Modify: `docs/jobs-pipeline.md`

- [ ] **Step 1: Write the e2e spec**

Create `apps/web/tests/e2e/automation-defer.spec.ts`. It seeds a job + a deferred `job_task` via adminDb, then asserts the `/exceptions` page shows a "Needs approval" row. Scope to stamped names.
```ts
/**
 * e2e: agent-deferred tasks surface in /exceptions (C Part 2).
 *
 * Seeds a job_task with deferred_at set (as gateAgentAutomation would on a
 * manual/partial task) and asserts the /exceptions page renders a "Needs
 * approval" row for the stamped customer. Seeded via adminDb; assertions scope
 * to the stamped name (the page aggregates ALL tenant rows).
 */
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { adminDb, customer, property, job, jobTask, eq } from "@savvy/db";

const { id: tenantId } = JSON.parse(readFileSync("/tmp/savvy-e2e-tenant.json", "utf8")) as { id: string };

test("a deferred task appears as a Needs approval exception", async ({ page }) => {
  const stamp = randomUUID().slice(0, 8);
  const name = `Defer Dan ${stamp}`;
  const [cust] = await adminDb.insert(customer).values({ tenantId, name, email: `defer-${stamp}@e2e.test` }).returning();
  const [prop] = await adminDb.insert(property).values({ tenantId, customerId: cust!.id, address: `${stamp} Defer Way` }).returning();
  const [j] = await adminDb.insert(job).values({ tenantId, customerId: cust!.id, propertyId: prop!.id, type: "retail", stage: "estimate" }).returning();
  await adminDb.insert(jobTask).values({
    tenantId, jobId: j!.id, key: "estimating-049", title: "Estimate import",
    automationLevel: "manual", status: "pending", deferredAt: new Date(),
  });

  await page.goto("/exceptions");
  await expect(page.getByTestId("exceptions-page")).toBeVisible();

  const row = page.locator('[data-testid="exception-row"]', { hasText: name });
  await expect(row).toContainText("Needs approval");
  await expect(row).toContainText("Needs approval: Estimate import");
  await expect(row).toHaveAttribute("data-severity", "medium");
});
```

- [ ] **Step 2: Run the e2e**

Run from `apps/web`:
```bash
npx tsx tests/e2e/create-tenant.ts
export TEST_TENANT_ID=$(node -e "console.log(require('/tmp/savvy-e2e-tenant.json').id)")
./node_modules/.bin/playwright test tests/e2e/automation-defer.spec.ts
```
Expected: PASS (1 test). (Inngest `ECONNREFUSED` warnings are benign.)
If Postgres is down: `pnpm db:up && pnpm --filter @savvy/db db:migrate` from the worktree root first.

- [ ] **Step 3: Document the gate + vector**

In `docs/jobs-pipeline.md`, add a section describing the runtime automation gate. Match the surrounding tone. Use this content:
```markdown
### Runtime automation gate (C Part 2)

Agents honor `job_task.automationLevel` at runtime. Before an agent auto-performs work tied to a
task, it calls `gateAgentAutomation({ tenantId, jobId, taskKey, agent })`: it reads the owning
task's level and, if it is not `full` (i.e. `partial` or `manual`), **defers** — it stamps the task
`deferred_at`, logs a `skipped` `agent_run`, and returns `proceed: false` so the agent skips the
action. Only `full` tasks run automatically. Deferred tasks surface in `/exceptions` as a medium
`task_needs_approval` row ("Needs approval: …") until a human completes them. The first wired
capability is estimate generation (`estimating-049`); because that task's template default is
`full`, the gate is dormant until a job's task is set non-full. `resolveTaskAutomation` defaults to
`full` when no matching task exists, so an unmapped agent action is never blocked.
```

- [ ] **Step 4: Commit docs + e2e**

```bash
git add "apps/web/tests/e2e/automation-defer.spec.ts" docs/jobs-pipeline.md
git commit -m "test(e2e): agent-deferred tasks in /exceptions + docs"
```

- [ ] **Step 5: Full verification gate**

Run from the worktree root:
```bash
pnpm test && pnpm typecheck && pnpm lint
```
Expected: all green — full suite (≥659 tests: prior 651 + new core/db tests), typecheck clean, lint 0 errors.
(If the db suite hits `ECONNREFUSED`: `pnpm db:up && pnpm --filter @savvy/db db:migrate`, then re-run.)

---

## Self-Review notes

- **Spec coverage:** core helper (T1) · db column+gate (T2) · agents wiring (T3) · exception vector (T4) · web gather+label (T5) · e2e+docs+verify (T6). All map to a task.
- **Type consistency:** `shouldAutoAct` / `gateAgentAutomation` / `{ proceed, level }` / `deferredAt`/`deferred_at` / `task_needs_approval` / `TaskNeedsApprovalInput` / `taskNeedsApprovals` / `ESTIMATE_TASK_KEY="estimating-049"` used identically across tasks.
- **Backward compatible:** gate dormant by default (template `full`); `resolveTaskAutomation` defaults `full`; existing suite untouched. Migration is a pure column add on an already-RLS'd table.
- **Durable defer signal:** `deferred_at` (not transient agent_run) drives the self-clearing exception (excludes done/skipped).
- **e2e robustness:** scoped to stamped names, never `queue.total`.
