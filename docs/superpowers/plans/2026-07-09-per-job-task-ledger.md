# Per-Job Task Ledger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the job-detail Tasks tab render the scope-correct, evidence-driven registry ledger (`job_task`), killing the bug where tenant-recurring marketing tasks appear on jobs, and add the conversion lifecycle gate.

**Architecture:** Unify the Tasks tab on `job_task` ⨝ `task_registry` (already scope/evidence-correct). Re-scope tenant-recurring tasks to `per_tenant_recurring` so they instantiate nowhere. Keep `job_checklist_item` only as the exceptions/SLA substrate (cleaned, not retired). Add evidence-driven rendering, phase sections, manual-only checkboxes, waiting-on = first unblocked task, a conversion resolution gate, a `scope_integrity` invariant, and an idempotent prod cleanup script.

**Tech Stack:** Next.js App Router, TypeScript, Drizzle ORM (Postgres + RLS), Vitest, Playwright, Inngest, pnpm/Turborepo.

## Global Constraints

- **Tenant isolation on every query** — reads/writes go through `withTenant(tenantId, tx => …)`; `job_task`/`lead_task` have `tenantIsolation()` RLS. No raw query bypasses RLS (admin scripts excepted, with preflight).
- **Every feature ships with tests**; `pnpm typecheck` + `pnpm lint` clean before commit. Run the **full** `pnpm typecheck` (all packages) before pushing — CI's build runs all packages.
- **TASK_SCOPE** = `["per_job","per_lead","per_tenant_recurring","one_time"]`. **TASK_MODE** = `["full_auto","assisted","manual"]`. **JOB_TASK_STATUS** = `["pending","in_progress","done","verified","exception","failed","skipped","not_applicable"]`.
- **Effective mode** = `tenant_task_config.mode ?? task_registry.default_mode`.
- **No new provider/model strings, no secrets, no un-awaited async** (use Inngest for async).
- Migrations via `pnpm db:generate`; do not hand-edit journal. Prod deploys are manual (out of this plan's scope; deploy after merge).

## File Structure

| File | Responsibility | Task |
|------|----------------|------|
| `packages/db/seeds/master-task-list.ts` | add `SCOPE_OVERRIDE` map; apply in `toRegistryRow` | 1 |
| `packages/db/seeds/master-task-list.test.ts` | assert re-scoped tasks | 1 |
| `packages/db/src/seed-data/task-lifecycle.json` | mark marketing tasks `orgLevel:true` | 2 |
| `packages/db/src/lifecycle/seed-job-tasks.test.ts` | assert marketing tasks not seeded | 2 |
| `packages/db/drizzle/00NN_task_note.sql` (generated) | `note` column on job_task + lead_task | 3 |
| `packages/db/src/schema/task-registry.ts` | add `note` to `jobTask`/`leadTask` | 3 |
| `packages/core/src/verification/checks.ts` | `job.scope_integrity` invariant | 4 |
| `packages/db/tests/scope-integrity.test.ts` | red-path bad row | 4 |
| `packages/core/src/job-ledger.ts` | pure status→glyph, effective-mode, section/collapse logic | 5 |
| `packages/core/src/job-ledger.test.ts` | unit tests for the pure logic | 5 |
| `packages/db/src/lifecycle/task-health.ts` | extend `getJobLedger` to union lead_task + effective mode | 6 |
| `packages/db/tests/job-ledger-reader.test.ts` | reader tests | 6 |
| `apps/web/src/app/(app)/jobs/[id]/LedgerTab.tsx` (new) | evidence-driven Tasks tab render | 7 |
| `apps/web/src/app/(app)/jobs/[id]/{tabs,page}.tsx` | wire LedgerTab, fetch job_task | 7 |
| `apps/web/src/lib/job-ledger-actions.ts` (new) | `completeManualTask` server action | 8 |
| `packages/db/tests/manual-complete.test.ts` | manual completion + audit | 8 |
| `apps/web/src/lib/pipeline-queries.ts`, `packages/core/src/pipeline-board.ts` | waiting-on = first unblocked job_task | 9 |
| `packages/db/src/lifecycle/appointments.ts` | conversion gate + resolutions | 10 |
| `packages/db/src/lifecycle/lead-tasks.ts` | `resolveOpenLeadTasks` helper | 10 |
| `packages/db/tests/conversion-gate.test.ts` | red-path manual block | 10 |
| `packages/agents/src/functions/{estimate-sign,canvass-contract}.ts` | catch `ConversionBlockedError` → needs-you | 11 |
| `packages/db/src/scripts/cleanup-out-of-scope-tasks.ts` (new) | idempotent prod cleanup | 12 |
| `packages/db/tests/cleanup-out-of-scope.test.ts` | cleanup removes only out-of-scope | 12 |
| `apps/web/tests/e2e/job-task-ledger.spec.ts` (new) | Tasks tab shows only job tasks | 13 |

---

## Task 1: Re-scope tenant-recurring tasks in the registry seed

**Files:**
- Modify: `packages/db/seeds/master-task-list.ts` (add `SCOPE_OVERRIDE`, apply at scope assignment ~line 113)
- Test: `packages/db/seeds/master-task-list.test.ts`

**Interfaces:**
- Produces: `SCOPE_OVERRIDE: Record<number, TaskScope>` and corrected `seedTaskRegistry` output where tasks 2/4/12/14 have `scope='per_tenant_recurring'`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/db/seeds/master-task-list.test.ts  (add to existing describe or new file)
import { describe, it, expect } from "vitest";
import { buildRegistryRows } from "./master-task-list"; // export this if not already

describe("master task list scope", () => {
  it("scopes tenant-recurring marketing tasks as per_tenant_recurring", () => {
    const rows = buildRegistryRows();
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const id of [2, 4, 12, 14]) {
      expect(byId.get(id)?.scope, `task ${id}`).toBe("per_tenant_recurring");
    }
  });
  it("leaves genuine per_job tasks alone", () => {
    const rows = buildRegistryRows();
    // a core production task (e.g. an install-phase task) stays per_job
    const install = rows.find((r) => r.phase >= 6 && r.phase <= 8);
    expect(install?.scope).toBe("per_job");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @savvy/db exec vitest run seeds/master-task-list.test.ts`
Expected: FAIL (`buildRegistryRows` not exported, or tasks 2/4/12/14 are `per_lead`).

- [ ] **Step 3: Implement the scope override**

In `packages/db/seeds/master-task-list.ts`, add near `PHASE_SCOPE` (~line 75) and export the row builder:

```ts
// Tenant-recurring tasks the Phase-1 heuristic mis-scopes as per_lead. These are
// tenant-level marketing/ops obligations that must instantiate NOWHERE (Coverage Map only).
// Audit result — Phase 1 recurring marketing + confirmed Phase 10/11/14/15 are already
// per_tenant_recurring via PHASE_SCOPE; these four are the Phase-1 exceptions.
const SCOPE_OVERRIDE: Record<number, TaskScope> = {
  2: "per_tenant_recurring",  // Website form submission capture
  4: "per_tenant_recurring",  // Google/Facebook ad lead capture
  12: "per_tenant_recurring", // Google Business Profile management
  14: "per_tenant_recurring", // SEO content & blog publishing
};
```

Then where `scope` is assigned (~line 113), apply the override first:

```ts
scope: SCOPE_OVERRIDE[t.id] ?? PHASE_SCOPE[t.phase] ?? "per_job",
```

Ensure the row-building loop is exported as `buildRegistryRows()` (extract the `.map` that produces registry rows into a named exported function if it is currently inline in `seedTaskRegistry`).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @savvy/db exec vitest run seeds/master-task-list.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/db/seeds/master-task-list.ts packages/db/seeds/master-task-list.test.ts
git commit -m "fix(tasks): re-scope tenant-recurring marketing tasks to per_tenant_recurring"
```

---

## Task 2: Stop `seedJobTasks` seeding marketing tasks (JSON substrate)

**Files:**
- Modify: `packages/db/src/seed-data/task-lifecycle.json` (set `orgLevel:true` on task nums 2, 4, 12, 14)
- Test: `packages/db/src/lifecycle/seed-job-tasks.test.ts`

**Interfaces:**
- Consumes: `seedJobTasks(tx, {id, tenantId, type})` (existing, `seed-job-tasks.ts:13`).
- Produces: no `job_checklist_item` row for tasks 2/4/12/14 on any job.

- [ ] **Step 1: Write the failing test**

```ts
// packages/db/src/lifecycle/seed-job-tasks.test.ts
import { describe, it, expect } from "vitest";
import { adminDb, withTenant, tenant, customer, property, job, jobChecklistItem, eq } from "..";
import { seedJobTasks } from "./seed-job-tasks";

describe("seedJobTasks scope", () => {
  it("does not seed tenant-recurring marketing tasks onto a job", async () => {
    const [t] = await adminDb.insert(tenant).values({ name: "seed", publicKey: `k-${Date.now()}-${Math.random()}`, clerkOrgId: `o-${Date.now()}-${Math.random()}` }).returning();
    const tid = t!.id;
    const jid = await withTenant(tid, async (tx) => {
      const [c] = await tx.insert(customer).values({ tenantId: tid, name: "C" }).returning({ id: customer.id });
      const [p] = await tx.insert(property).values({ tenantId: tid, customerId: c!.id, address: "1 St" }).returning({ id: property.id });
      const [j] = await tx.insert(job).values({ tenantId: tid, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "lead" }).returning({ id: job.id });
      await seedJobTasks(tx as never, { id: j!.id, tenantId: tid, type: "retail" });
      return j!.id;
    });
    const rows = await adminDb.select({ title: jobChecklistItem.title }).from(jobChecklistItem).where(eq(jobChecklistItem.jobId, jid));
    const titles = rows.map((r) => r.title);
    for (const marketing of ["SEO content & blog publishing", "Google Business Profile management", "Website form submission capture", "Google/Facebook ad lead capture"]) {
      expect(titles, marketing).not.toContain(marketing);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @savvy/db exec vitest run src/lifecycle/seed-job-tasks.test.ts`
Expected: FAIL (marketing titles present).

- [ ] **Step 3: Fix the JSON data**

In `packages/db/src/seed-data/task-lifecycle.json`, set `"orgLevel": true` on the four objects with `"num": 2`, `"num": 4`, `"num": 12`, `"num": 14`. (Their `seedJobTasks` filter is `!t.orgLevel && t.jobTypes.includes(job.type)`, so `orgLevel:true` excludes them.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @savvy/db exec vitest run src/lifecycle/seed-job-tasks.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/seed-data/task-lifecycle.json packages/db/src/lifecycle/seed-job-tasks.test.ts
git commit -m "fix(tasks): mark marketing tasks orgLevel so seedJobTasks skips them"
```

---

## Task 3: Migration — `note` column on job_task + lead_task

**Files:**
- Modify: `packages/db/src/schema/task-registry.ts` (add `note: text("note")` to `jobTask` and `leadTask`)
- Generate: `packages/db/drizzle/00NN_*.sql` via `pnpm db:generate`

**Interfaces:**
- Produces: `jobTask.note` / `leadTask.note` (nullable text) for `not_applicable` reasons.

- [ ] **Step 1: Add the columns**

In `packages/db/src/schema/task-registry.ts`, add to the `jobTask` column block and the `leadTask` column block (after `evidence`):

```ts
    note: text("note"), // resolution/not_applicable reason (conversion gate + manual)
```

Ensure `text` is imported from `drizzle-orm/pg-core` in that file (it is used elsewhere in the schema; confirm the import).

- [ ] **Step 2: Generate the migration**

Run: `pnpm db:generate`
Expected: a new `packages/db/drizzle/00NN_*.sql` adding `note` to both tables; journal updated. Do NOT hand-edit the journal.

- [ ] **Step 3: Apply locally + verify**

Run: `pnpm db:migrate`
Then verify: `pnpm --filter @savvy/db exec tsx -e "import {adminDb} from './src/admin-client'; import {sql} from 'drizzle-orm'; adminDb.execute(sql\`select column_name from information_schema.columns where table_name='job_task' and column_name='note'\`).then(r=>{console.log(r.rows);process.exit(0)})"`
Expected: one row `{ column_name: 'note' }`.

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @savvy/db typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/schema/task-registry.ts packages/db/drizzle/
git commit -m "feat(tasks): add note column to job_task and lead_task"
```

---

## Task 4: `job.scope_integrity` invariant

**Files:**
- Modify: `packages/core/src/verification/checks.ts` (add binding to `evidenceChecks`)
- Test: `packages/db/tests/scope-integrity.test.ts`

**Interfaces:**
- Consumes: the `invariant(key, sql, opts)` helper already used in `checks.ts`.
- Produces: `evidenceChecks["job.scope_integrity"]` — returns rows for any `job_task` whose registry scope ≠ `per_job`.

- [ ] **Step 1: Write the failing test (red-path)**

```ts
// packages/db/tests/scope-integrity.test.ts
import { describe, it, expect } from "vitest";
import { adminDb, withTenant, tenant, customer, property, job, jobTask, eq } from "../src";
import { runCheck } from "../src/verification/run-check"; // existing runner used by the sweep

describe("job.scope_integrity", () => {
  it("flags a per_tenant_recurring task instantiated on a job", async () => {
    const [t] = await adminDb.insert(tenant).values({ name: "si", publicKey: `k-${Date.now()}-${Math.random()}`, clerkOrgId: `o-${Date.now()}-${Math.random()}` }).returning();
    const tid = t!.id;
    const jid = await withTenant(tid, async (tx) => {
      const [c] = await tx.insert(customer).values({ tenantId: tid, name: "C" }).returning({ id: customer.id });
      const [p] = await tx.insert(property).values({ tenantId: tid, customerId: c!.id, address: "1 St" }).returning({ id: property.id });
      const [j] = await tx.insert(job).values({ tenantId: tid, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "lead" }).returning({ id: job.id });
      // task 14 (SEO) is per_tenant_recurring after Task 1 — seeding it on a job is the violation
      await tx.insert(jobTask).values({ tenantId: tid, jobId: j!.id, taskId: 14, status: "pending" });
      return j!.id;
    });
    const violations = await runCheck(tid, "job.scope_integrity");
    expect(violations.some((v) => v.ref)).toBe(true);
  });
});
```

> Note: confirm the exact runner name/shape in `packages/db/src/verification/` (the sweep already executes `evidenceChecks`). If the helper is `runEvidenceCheck` or takes different args, match it — the assertion is "the bad row is returned."

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @savvy/db exec vitest run tests/scope-integrity.test.ts`
Expected: FAIL (check key unknown).

- [ ] **Step 3: Add the invariant**

In `packages/core/src/verification/checks.ts`, add to `evidenceChecks` (near `job.stage_evidence`, keep it UNBOUND — do not add to `CHECK_BINDINGS`):

```ts
  // A job ledger must contain ONLY per_job tasks. Any job_task pointing at a
  // task whose registry scope != 'per_job' is a scope-integrity violation
  // (a tenant/lead-scoped task wrongly instantiated on a job).
  "job.scope_integrity": invariant(
    "job.scope_integrity",
    `select jt.id
       from job_task jt
       join task_registry tr on tr.id = jt.task_id
      where jt.tenant_id = $1 and tr.scope <> 'per_job'`,
    { toRef: (r) => ({ type: "job_task", ref: String(r.id) }) },
  ),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @savvy/db exec vitest run tests/scope-integrity.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/verification/checks.ts packages/db/tests/scope-integrity.test.ts
git commit -m "feat(tasks): job.scope_integrity invariant (zero non-per_job tasks on a job)"
```

---

## Task 5: Pure ledger-view logic in core

**Files:**
- Create: `packages/core/src/job-ledger-view.ts` (keep existing `job-ledger.ts` `summarizeLedgerProgress`)
- Test: `packages/core/src/job-ledger-view.test.ts`
- Modify: `packages/core/src/index.ts` (export)

**Interfaces:**
- Produces:
  - `effectiveMode(defaultMode: TaskMode, override: TaskMode | null): TaskMode`
  - `ledgerGlyph(status: JobTaskStatus, blockedBy: number[]): { glyph: string; state: LedgerState }` where `LedgerState = "pending"|"blocked"|"done"|"verified"|"exception"|"na"`
  - `isManual(mode: TaskMode): boolean`
  - `groupLedgerByPhase(rows: LedgerRowInput[]): PhaseGroup[]` where `PhaseGroup = { phase: number; done: number; total: number; collapsed: boolean; rows: LedgerRowInput[] }` — a group is `collapsed` when every row is terminal (done/verified/not_applicable/skipped)
  - `currentPhase(groups: PhaseGroup[]): number` — first non-collapsed phase, else the last phase
  - `firstUnblockedIncomplete(rows: LedgerRowInput[]): LedgerRowInput | null` — status ∉ terminal AND `blockedBy.length===0`, in input order

- [ ] **Step 1: Write the failing tests**

```ts
// packages/core/src/job-ledger-view.test.ts
import { describe, it, expect } from "vitest";
import { effectiveMode, ledgerGlyph, isManual, groupLedgerByPhase, currentPhase, firstUnblockedIncomplete } from "./job-ledger-view";

describe("effectiveMode", () => {
  it("prefers the tenant override", () => expect(effectiveMode("full_auto", "manual")).toBe("manual"));
  it("falls back to default", () => expect(effectiveMode("assisted", null)).toBe("assisted"));
});

describe("ledgerGlyph", () => {
  it("pending with a blocker renders blocked", () => expect(ledgerGlyph("pending", [3]).state).toBe("blocked"));
  it("pending with no blocker renders pending", () => expect(ledgerGlyph("pending", []).state).toBe("pending"));
  it("verified renders verified", () => expect(ledgerGlyph("verified", []).state).toBe("verified"));
  it("not_applicable renders na", () => expect(ledgerGlyph("not_applicable", []).state).toBe("na"));
});

describe("groupLedgerByPhase + currentPhase", () => {
  const rows = [
    { taskId: 1, phase: 1, status: "verified", blockedBy: [] },
    { taskId: 2, phase: 1, status: "done", blockedBy: [] },
    { taskId: 3, phase: 2, status: "pending", blockedBy: [] },
    { taskId: 4, phase: 2, status: "pending", blockedBy: [3] },
  ] as const;
  it("collapses a fully-terminal phase", () => {
    const g = groupLedgerByPhase(rows as never);
    expect(g.find((x) => x.phase === 1)?.collapsed).toBe(true);
    expect(g.find((x) => x.phase === 2)?.collapsed).toBe(false);
  });
  it("opens at the first incomplete phase", () => {
    expect(currentPhase(groupLedgerByPhase(rows as never))).toBe(2);
  });
});

describe("firstUnblockedIncomplete", () => {
  it("skips blocked and terminal rows", () => {
    const rows = [
      { taskId: 1, phase: 1, status: "done", blockedBy: [] },
      { taskId: 4, phase: 2, status: "pending", blockedBy: [3] },
      { taskId: 5, phase: 2, status: "pending", blockedBy: [] },
    ];
    expect(firstUnblockedIncomplete(rows as never)?.taskId).toBe(5);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @savvy/core exec vitest run src/job-ledger-view.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement the pure logic**

```ts
// packages/core/src/job-ledger-view.ts
import type { TaskMode, JobTaskStatus } from "./enums";

export type LedgerState = "pending" | "blocked" | "done" | "verified" | "exception" | "na";
export interface LedgerRowInput { taskId: number; phase: number; status: JobTaskStatus; blockedBy: number[]; }
export interface PhaseGroup { phase: number; done: number; total: number; collapsed: boolean; rows: LedgerRowInput[]; }

const TERMINAL: JobTaskStatus[] = ["done", "verified", "not_applicable", "skipped"];
const isTerminal = (s: JobTaskStatus) => TERMINAL.includes(s);

export function effectiveMode(defaultMode: TaskMode, override: TaskMode | null): TaskMode {
  return override ?? defaultMode;
}
export function isManual(mode: TaskMode): boolean {
  return mode === "manual";
}
export function ledgerGlyph(status: JobTaskStatus, blockedBy: number[]): { glyph: string; state: LedgerState } {
  if (status === "verified") return { glyph: "✓", state: "verified" };
  if (status === "done") return { glyph: "✓", state: "done" };
  if (status === "exception" || status === "failed") return { glyph: "✗", state: "exception" };
  if (status === "not_applicable" || status === "skipped") return { glyph: "–", state: "na" };
  if (blockedBy.length > 0) return { glyph: "⊘", state: "blocked" };
  return { glyph: "○", state: "pending" };
}
export function groupLedgerByPhase(rows: LedgerRowInput[]): PhaseGroup[] {
  const byPhase = new Map<number, LedgerRowInput[]>();
  for (const r of rows) (byPhase.get(r.phase) ?? byPhase.set(r.phase, []).get(r.phase)!).push(r);
  return [...byPhase.entries()]
    .sort(([a], [b]) => a - b)
    .map(([phase, rs]) => ({
      phase,
      total: rs.length,
      done: rs.filter((r) => isTerminal(r.status)).length,
      collapsed: rs.every((r) => isTerminal(r.status)),
      rows: rs,
    }));
}
export function currentPhase(groups: PhaseGroup[]): number {
  return groups.find((g) => !g.collapsed)?.phase ?? groups.at(-1)?.phase ?? 1;
}
export function firstUnblockedIncomplete<T extends LedgerRowInput>(rows: T[]): T | null {
  return rows.find((r) => !isTerminal(r.status) && r.blockedBy.length === 0) ?? null;
}
```

- [ ] **Step 4: Export + run tests**

Add to `packages/core/src/index.ts`: `export * from "./job-ledger-view";`
Run: `pnpm --filter @savvy/core exec vitest run src/job-ledger-view.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/job-ledger-view.ts packages/core/src/job-ledger-view.test.ts packages/core/src/index.ts
git commit -m "feat(tasks): pure ledger-view logic (glyph, sections, effective mode, first-unblocked)"
```

---

## Task 6: Extend `getJobLedger` — union lead history + effective mode

**Files:**
- Modify: `packages/db/src/lifecycle/task-health.ts` (`getJobLedger` + `JobLedgerRow`)
- Test: `packages/db/tests/job-ledger-reader.test.ts`

**Interfaces:**
- Consumes: existing `getJobLedger(tenantId, jobId)` and `JobLedgerRow` (task-health.ts:585-627).
- Produces: `JobLedgerRow` gains `mode: TaskMode` (effective), `defaultMode`, `origin: "job" | "lead"`, `note: string | null`; `getJobLedger` unions `lead_task` (by `job.lead_id`) as `origin:"lead"` rows joined to registry, ordered phase→id.

- [ ] **Step 1: Write the failing test**

```ts
// packages/db/tests/job-ledger-reader.test.ts
import { describe, it, expect } from "vitest";
import { adminDb, withTenant, tenant, customer, property, lead, job, jobTask, leadTask, tenantTaskConfig, getJobLedger } from "../src";

describe("getJobLedger", () => {
  it("includes lead_task history (origin=lead) and applies effective mode override", async () => {
    const [t] = await adminDb.insert(tenant).values({ name: "lr", publicKey: `k-${Date.now()}-${Math.random()}`, clerkOrgId: `o-${Date.now()}-${Math.random()}` }).returning();
    const tid = t!.id;
    const { jid } = await withTenant(tid, async (tx) => {
      const [c] = await tx.insert(customer).values({ tenantId: tid, name: "C" }).returning({ id: customer.id });
      const [p] = await tx.insert(property).values({ tenantId: tid, customerId: c!.id, address: "1 St" }).returning({ id: property.id });
      const [l] = await tx.insert(lead).values({ tenantId: tid, customerId: c!.id, propertyId: p!.id, source: "test" }).returning({ id: lead.id });
      const [j] = await tx.insert(job).values({ tenantId: tid, customerId: c!.id, propertyId: p!.id, leadId: l!.id, type: "retail", stage: "inspected" }).returning({ id: job.id });
      // a job task (per_job registry id, e.g. an inspection-phase task) + a lead task
      await tx.insert(jobTask).values({ tenantId: tid, jobId: j!.id, taskId: 60, status: "pending" });
      await tx.insert(leadTask).values({ tenantId: tid, leadId: l!.id, taskId: 18, status: "done" });
      // override task 60 to manual for this tenant
      await tx.insert(tenantTaskConfig).values({ tenantId: tid, taskId: 60, mode: "manual" });
      return { jid: j!.id };
    });
    const rows = await getJobLedger(tid, jid);
    expect(rows.some((r) => r.origin === "lead" && r.taskId === 18)).toBe(true);
    const job60 = rows.find((r) => r.taskId === 60 && r.origin === "job");
    expect(job60?.mode).toBe("manual");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @savvy/db exec vitest run tests/job-ledger-reader.test.ts`
Expected: FAIL (`origin`/`mode` undefined; lead rows absent).

- [ ] **Step 3: Extend the reader**

In `packages/db/src/lifecycle/task-health.ts`, extend `JobLedgerRow` with `mode: TaskMode; defaultMode: TaskMode; origin: "job" | "lead"; note: string | null;`. In `getJobLedger`, after fetching job rows, also select `lead_task` for the job's `lead_id` (left-join registry + `tenant_task_config` for `mode`), map both sets to `JobLedgerRow` computing `mode = tenantConfig.mode ?? registry.default_mode`, tag `origin`, and return concatenated ordered by `phase, taskId`. Follow the existing join/mapping style in that function (registry join already exists for the job path).

Key SQL shape for the lead union (mirror the job select):

```ts
const leadRows = job.leadId
  ? await tx.select({
      taskId: leadTask.taskId, name: taskRegistry.name, phase: taskRegistry.phase, slug: taskRegistry.slug,
      status: leadTask.status, owner: leadTask.owner, evidence: leadTask.evidence, blockedBy: leadTask.blockedBy,
      note: leadTask.note, defaultMode: taskRegistry.defaultMode, overrideMode: tenantTaskConfig.mode,
    })
    .from(leadTask)
    .innerJoin(taskRegistry, eq(taskRegistry.id, leadTask.taskId))
    .leftJoin(tenantTaskConfig, and(eq(tenantTaskConfig.tenantId, tenantId), eq(tenantTaskConfig.taskId, leadTask.taskId)))
    .where(and(eq(leadTask.tenantId, tenantId), eq(leadTask.leadId, job.leadId)))
  : [];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @savvy/db exec vitest run tests/job-ledger-reader.test.ts`
Expected: PASS. Also run the existing `tests/master-task-list.test.ts` and `job-ledger-console.spec` reader deps unaffected.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/lifecycle/task-health.ts packages/db/tests/job-ledger-reader.test.ts
git commit -m "feat(tasks): getJobLedger unions lead history + effective mode + note/origin"
```

---

## Task 7: Tasks tab renders the evidence ledger

**Files:**
- Create: `apps/web/src/app/(app)/jobs/[id]/LedgerTab.tsx`
- Modify: `apps/web/src/app/(app)/jobs/[id]/page.tsx` (fetch via `getJobLedger`, pass rows), `tabs.tsx` (render `LedgerTab` for the Tasks tab)

**Interfaces:**
- Consumes: `getJobLedger`, `groupLedgerByPhase`, `currentPhase`, `ledgerGlyph`, `isManual`, `effectiveMode` (already effective in row), `completeManualTask` (Task 8).
- Produces: the Tasks tab UI. `data-testid="task-row"` retained (e2e + existing selectors), plus `data-testid="ledger-phase"`, `data-origin`, `data-task-status`.

- [ ] **Step 1: Write the component (server-rendered sections + client checkbox)**

`LedgerTab.tsx` maps `groupLedgerByPhase(rows)`; each group renders a `<section data-testid="ledger-phase">` with a header `Phase N · done/total ✓`; collapsed groups render a `<details>` closed unless `phase === currentPhase(groups)`. Each row: if `isManual(row.mode)` render a `<Checkbox>` bound to a client action `completeManualTask(row.taskId, next)`; else render `ledgerGlyph(row.status, row.blockedBy).glyph` + `AgentAvatar` for `row.owner` + evidence link when `row.evidence`. Blocked rows show `blocked by <names>` (resolve id→name from the rows set). Follow the existing `JobLedgerCard.tsx` styling (glyph colors, evidence `<a>`).

- [ ] **Step 2: Wire the fetch + tab**

In `page.tsx`, replace the `jobChecklistItem` task fetch used by the Tasks tab with `const ledgerRows = await getJobLedger(tenantId, id);` and pass `ledgerRows` to `JobTabs`. In `tabs.tsx`, render `<LedgerTab rows={ledgerRows} />` in the `tasks` TabsContent (remove the old `TaskItem`/`tasksByPhase` path). Keep the separate `JobLedgerCard` OR remove it if now redundant (the tab supersedes it — remove to avoid duplication, updating `job-ledger-console.spec.ts` selectors to the tab in Task 13).

- [ ] **Step 3: Typecheck + lint**

Run: `pnpm --filter @savvy/web typecheck && pnpm --filter @savvy/web lint`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/app/\(app\)/jobs/\[id\]/
git commit -m "feat(tasks): Tasks tab renders evidence ledger with phase sections + manual checkboxes"
```

---

## Task 8: Manual completion server action

**Files:**
- Create: `apps/web/src/lib/job-ledger-actions.ts`
- Modify: `packages/db/src/lifecycle/job-tasks.ts` (add `completeJobTaskManually`)
- Test: `packages/db/tests/manual-complete.test.ts`

**Interfaces:**
- Produces: `completeJobTaskManually(tx, {tenantId, jobId, taskId, userId, done})` → sets `status = done ? "done" : "pending"`, `owner = userId | null`, `completedAt`, writes an `audit_log` row. Rejects if the task's effective mode ≠ manual (`throw new Error("not_manual")`). Server action `completeManualTask(taskId, done)` resolves tenant + user via Clerk and calls it in `withTenant`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/db/tests/manual-complete.test.ts
import { describe, it, expect } from "vitest";
import { adminDb, withTenant, tenant, customer, property, job, jobTask, auditLog, eq, and } from "../src";
import { completeJobTaskManually } from "../src/lifecycle/job-tasks";

describe("completeJobTaskManually", () => {
  it("ticks a manual task to done with owner + audit", async () => {
    const [t] = await adminDb.insert(tenant).values({ name: "mc", publicKey: `k-${Date.now()}-${Math.random()}`, clerkOrgId: `o-${Date.now()}-${Math.random()}` }).returning();
    const tid = t!.id;
    const { jid } = await withTenant(tid, async (tx) => {
      const [c] = await tx.insert(customer).values({ tenantId: tid, name: "C" }).returning({ id: customer.id });
      const [p] = await tx.insert(property).values({ tenantId: tid, customerId: c!.id, address: "1 St" }).returning({ id: property.id });
      const [j] = await tx.insert(job).values({ tenantId: tid, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "production" }).returning({ id: job.id });
      // task 44 is Manual (compliance.contract_template); default_mode manual
      await tx.insert(jobTask).values({ tenantId: tid, jobId: j!.id, taskId: 44, status: "pending" });
      await completeJobTaskManually(tx, { tenantId: tid, jobId: j!.id, taskId: 44, userId: "user_x", done: true });
      return { jid: j!.id };
    });
    const [row] = await adminDb.select({ status: jobTask.status, owner: jobTask.owner }).from(jobTask).where(and(eq(jobTask.jobId, jid), eq(jobTask.taskId, 44)));
    expect(row).toMatchObject({ status: "done", owner: "user_x" });
    const audits = await adminDb.select({ action: auditLog.action }).from(auditLog).where(eq(auditLog.entityId, jid));
    expect(audits.some((a) => a.action === "task_completed")).toBe(true);
  });
  it("rejects a non-manual task", async () => {
    const [t] = await adminDb.insert(tenant).values({ name: "mc2", publicKey: `k-${Date.now()}-${Math.random()}`, clerkOrgId: `o-${Date.now()}-${Math.random()}` }).returning();
    const tid = t!.id;
    await expect(withTenant(tid, async (tx) => {
      const [c] = await tx.insert(customer).values({ tenantId: tid, name: "C" }).returning({ id: customer.id });
      const [p] = await tx.insert(property).values({ tenantId: tid, customerId: c!.id, address: "1 St" }).returning({ id: property.id });
      const [j] = await tx.insert(job).values({ tenantId: tid, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "production" }).returning({ id: job.id });
      await tx.insert(jobTask).values({ tenantId: tid, jobId: j!.id, taskId: 141, status: "pending" }); // full_auto
      await completeJobTaskManually(tx, { tenantId: tid, jobId: j!.id, taskId: 141, userId: "u", done: true });
    })).rejects.toThrow("not_manual");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @savvy/db exec vitest run tests/manual-complete.test.ts`
Expected: FAIL (function missing).

- [ ] **Step 3: Implement `completeJobTaskManually`**

```ts
// packages/db/src/lifecycle/job-tasks.ts  (add)
import { taskRegistry, tenantTaskConfig, jobTask, auditLog } from "../schema/index";
import { effectiveMode, isManual } from "@savvy/core";

export async function completeJobTaskManually(
  tx: Tx,
  args: { tenantId: string; jobId: string; taskId: number; userId: string; done: boolean },
): Promise<void> {
  const [reg] = await tx.select({ defaultMode: taskRegistry.defaultMode }).from(taskRegistry).where(eq(taskRegistry.id, args.taskId));
  const [cfg] = await tx.select({ mode: tenantTaskConfig.mode }).from(tenantTaskConfig)
    .where(and(eq(tenantTaskConfig.tenantId, args.tenantId), eq(tenantTaskConfig.taskId, args.taskId)));
  if (!reg || !isManual(effectiveMode(reg.defaultMode, cfg?.mode ?? null))) throw new Error("not_manual");
  await tx.update(jobTask)
    .set({ status: args.done ? "done" : "pending", owner: args.done ? args.userId : null, completedAt: args.done ? new Date() : null })
    .where(and(eq(jobTask.tenantId, args.tenantId), eq(jobTask.jobId, args.jobId), eq(jobTask.taskId, args.taskId)));
  await tx.insert(auditLog).values({
    tenantId: args.tenantId, userId: args.userId, entityType: "job", entityId: args.jobId,
    action: args.done ? "task_completed" : "task_reopened", diff: { taskId: args.taskId },
  });
}
```

(Confirm `Tx` type import at top of file; it exists for the other helpers.)

- [ ] **Step 4: Server action + run tests**

```ts
// apps/web/src/lib/job-ledger-actions.ts
"use server";
import { withTenant, completeJobTaskManually } from "@savvy/db";
import { getTenantId } from "./tenant";
import { auth } from "@clerk/nextjs/server";
import { revalidatePath } from "next/cache";

export async function completeManualTask(jobId: string, taskId: number, done: boolean): Promise<void> {
  const tenantId = await getTenantId();
  const { userId } = await auth();
  await withTenant(tenantId, (tx) => completeJobTaskManually(tx, { tenantId, jobId, taskId, userId: userId ?? "unknown", done }));
  revalidatePath(`/jobs/${jobId}`);
}
```

Run: `pnpm --filter @savvy/db exec vitest run tests/manual-complete.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/lifecycle/job-tasks.ts apps/web/src/lib/job-ledger-actions.ts packages/db/tests/manual-complete.test.ts
git commit -m "feat(tasks): manual task completion (job_task done + owner + audit), mode-gated"
```

Then wire the checkbox in `LedgerTab.tsx` to `completeManualTask(jobId, taskId, next)` and commit that wiring with a `feat(tasks): wire ledger checkbox` message.

---

## Task 9: Waiting-on = first unblocked incomplete job_task

**Files:**
- Modify: `apps/web/src/lib/pipeline-queries.ts` (`getPipelineBoard` next-task query), `packages/core/src/pipeline-board.ts` (`deriveWaitingOn` — mode source)
- Test: `packages/core/src/pipeline-board.test.ts` (extend)

**Interfaces:**
- Consumes: `firstUnblockedIncomplete` (Task 5), `getJobLedger` rows or a lean per-job query.
- Produces: `deriveWaitingOn` names the first unblocked incomplete `job_task`; `isHuman = effectiveMode === "manual"`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/pipeline-board.test.ts  (add)
import { deriveWaitingOn } from "./pipeline-board";
it("names the first unblocked incomplete task", () => {
  const w = deriveWaitingOn({ column: "production", nextTask: { title: "Order materials", ownerAgent: "MILO", isHuman: false }, missingEvidence: null });
  expect(w.label).toBe("Order materials");
});
```

(Adapt to the exact `deriveWaitingOn` input shape; the behavior change is upstream in the query.)

- [ ] **Step 2: Change the query**

In `pipeline-queries.ts`, replace the earliest-due `jobChecklistItem` per-job selection with: for each board job, load its `job_task` rows (join registry for phase/name/mode + `tenant_task_config` for override) ordered `phase, taskId`, compute `firstUnblockedIncomplete(rows)`, and set `nextTask = { title, ownerAgent: owner, isHuman: effectiveMode === "manual" }`. Preserve the `missingEvidence` and `COLUMN_FALLBACK` branches. (A single batched query over all board jobs' `job_task` grouped in memory avoids N+1.)

- [ ] **Step 3: Run tests**

Run: `pnpm --filter @savvy/core exec vitest run src/pipeline-board.test.ts`
Expected: PASS. Typecheck web.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/lib/pipeline-queries.ts packages/core/src/pipeline-board.ts packages/core/src/pipeline-board.test.ts
git commit -m "feat(tasks): waiting-on points at the first unblocked incomplete job_task"
```

---

## Task 10: Conversion resolution gate

**Files:**
- Modify: `packages/db/src/lifecycle/appointments.ts` (`convertLeadToJob` signature + gate), `packages/db/src/lifecycle/lead-tasks.ts` (`resolveOpenLeadTasks`), `packages/db/src/index.ts` (export `ConversionBlockedError`)
- Test: `packages/db/tests/conversion-gate.test.ts`

**Interfaces:**
- Produces:
  - `class ConversionBlockedError extends Error` with `openManualTaskIds: number[]`.
  - `resolveOpenLeadTasks(tx, {tenantId, leadId, trigger, resolutions?})`: auto-sets open auto/assisted lead tasks to `not_applicable` (`note="auto: converted via <trigger>"`); for open manual tasks, applies caller `resolutions[taskId]` (`{status:"done"|"not_applicable", reason?}`) else throws `ConversionBlockedError`.
  - `convertLeadToJob(args & { trigger?: string; resolutions?: Record<number, {status:"done"|"not_applicable"; reason?:string}> })` calls `resolveOpenLeadTasks` before creating the job.

- [ ] **Step 1: Write the failing test (red-path + happy path)**

```ts
// packages/db/tests/conversion-gate.test.ts
import { describe, it, expect } from "vitest";
import { adminDb, withTenant, tenant, customer, property, lead, leadTask, convertLeadToJob, ConversionBlockedError, eq, and } from "../src";

async function seedLeadWith(taskId: number) {
  const [t] = await adminDb.insert(tenant).values({ name: "cv", publicKey: `k-${Date.now()}-${Math.random()}`, clerkOrgId: `o-${Date.now()}-${Math.random()}` }).returning();
  const tid = t!.id;
  const lid = await withTenant(tid, async (tx) => {
    const [c] = await tx.insert(customer).values({ tenantId: tid, name: "C" }).returning({ id: customer.id });
    const [p] = await tx.insert(property).values({ tenantId: tid, customerId: c!.id, address: "1 St" }).returning({ id: property.id });
    const [l] = await tx.insert(lead).values({ tenantId: tid, customerId: c!.id, propertyId: p!.id, source: "test" }).returning({ id: lead.id });
    await tx.insert(leadTask).values({ tenantId: tid, leadId: l!.id, taskId, status: "pending" });
    return l!.id;
  });
  return { tid, lid };
}

describe("convertLeadToJob resolution gate", () => {
  it("rejects conversion with an open MANUAL lead task and no resolution", async () => {
    const { tid, lid } = await seedLeadWith(44); // 44 = manual
    await expect(withTenant(tid, (tx) => convertLeadToJob({ ...baseArgs(tid, lid), trigger: "test" } as never)))
      .rejects.toBeInstanceOf(ConversionBlockedError);
  });
  it("auto-resolves an open AUTO/ASSISTED lead task and converts", async () => {
    const { tid, lid } = await seedLeadWith(19); // 19 = assisted/auto
    await withTenant(tid, (tx) => convertLeadToJob({ ...baseArgs(tid, lid), trigger: "test" } as never));
    const [lt] = await adminDb.select({ status: leadTask.status, note: leadTask.note }).from(leadTask).where(and(eq(leadTask.leadId, lid), eq(leadTask.taskId, 19)));
    expect(lt?.status).toBe("not_applicable");
    expect(lt?.note).toContain("auto: converted");
  });
});
// baseArgs: fill with the exact convertLeadToJob arg shape from appointments.ts (tenantId, leadId, etc.)
```

> Fill `baseArgs` from the current `convertLeadToJob` signature in `appointments.ts` (it takes tenantId, the lead/appointment context). Match it exactly.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @savvy/db exec vitest run tests/conversion-gate.test.ts`
Expected: FAIL (`ConversionBlockedError` unknown / no gate).

- [ ] **Step 3: Implement the gate**

```ts
// packages/db/src/lifecycle/lead-tasks.ts  (add)
import { taskRegistry, tenantTaskConfig, leadTask } from "../schema/index";
import { effectiveMode, isManual } from "@savvy/core";

export class ConversionBlockedError extends Error {
  constructor(public readonly openManualTaskIds: number[]) {
    super(`conversion blocked: ${openManualTaskIds.length} open manual lead task(s)`);
    this.name = "ConversionBlockedError";
  }
}

export async function resolveOpenLeadTasks(
  tx: Tx,
  args: { tenantId: string; leadId: string; trigger: string; resolutions?: Record<number, { status: "done" | "not_applicable"; reason?: string }> },
): Promise<void> {
  const open = await tx.select({ taskId: leadTask.taskId, defaultMode: taskRegistry.defaultMode, overrideMode: tenantTaskConfig.mode })
    .from(leadTask)
    .innerJoin(taskRegistry, eq(taskRegistry.id, leadTask.taskId))
    .leftJoin(tenantTaskConfig, and(eq(tenantTaskConfig.tenantId, args.tenantId), eq(tenantTaskConfig.taskId, leadTask.taskId)))
    .where(and(eq(leadTask.tenantId, args.tenantId), eq(leadTask.leadId, args.leadId), inArray(leadTask.status, ["pending", "in_progress"])));
  const blocked: number[] = [];
  for (const o of open) {
    const manual = isManual(effectiveMode(o.defaultMode, o.overrideMode ?? null));
    const res = args.resolutions?.[o.taskId];
    if (!manual) {
      await tx.update(leadTask).set({ status: "not_applicable", note: `auto: converted via ${args.trigger}` })
        .where(and(eq(leadTask.leadId, args.leadId), eq(leadTask.taskId, o.taskId)));
    } else if (res) {
      await tx.update(leadTask).set({ status: res.status, note: res.reason ?? null, completedAt: res.status === "done" ? new Date() : null })
        .where(and(eq(leadTask.leadId, args.leadId), eq(leadTask.taskId, o.taskId)));
    } else {
      blocked.push(o.taskId);
    }
  }
  if (blocked.length) throw new ConversionBlockedError(blocked);
}
```

In `appointments.ts` `convertLeadToJob`, accept `trigger?: string` and `resolutions?` in args, and call `await resolveOpenLeadTasks(tx, { tenantId: args.tenantId, leadId: <lead id>, trigger: args.trigger ?? "manual", resolutions: args.resolutions })` **before** inserting the new job (early, so a block prevents job creation). Export `ConversionBlockedError` and `resolveOpenLeadTasks` from `packages/db/src/index.ts`.

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @savvy/db exec vitest run tests/conversion-gate.test.ts`
Expected: PASS. Run the existing `estimate.spec`/`canvass` DB tests that call `convertLeadToJob` to confirm no regression (they pass no manual open lead tasks, so they proceed).

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/lifecycle/appointments.ts packages/db/src/lifecycle/lead-tasks.ts packages/db/src/index.ts packages/db/tests/conversion-gate.test.ts
git commit -m "feat(tasks): conversion resolution gate — auto-resolve non-manual, block on manual"
```

---

## Task 11: Inngest callers catch `ConversionBlockedError`

**Files:**
- Modify: `packages/agents/src/functions/estimate-sign.ts`, `packages/agents/src/functions/canvass-contract.ts`
- Test: extend the relevant agents test or add `packages/agents/src/functions/conversion-block.test.ts`

**Interfaces:**
- Consumes: `ConversionBlockedError`.
- Produces: on catch, the fn records a needs-you exception (reuse the existing exception/needs-approval path) and returns `{ skipped: "conversion_blocked", openManualTaskIds }` instead of throwing.

- [ ] **Step 1: Write the failing test**

Assert that when `convertLeadToJob` throws `ConversionBlockedError`, the estimate-sign step returns `{ skipped: "conversion_blocked" }` (mock/seed a lead with an open manual task, drive the sign path). Model it on `invoice-stage.test.ts`'s skip assertions.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @savvy/agents exec vitest run src/functions/conversion-block.test.ts`
Expected: FAIL (currently throws / crashes the step).

- [ ] **Step 3: Wrap the conversion call**

In each fn, wrap the `convertLeadToJob(...)` call:

```ts
import { ConversionBlockedError } from "@savvy/db";
try {
  await convertLeadToJob({ ...args, trigger: "estimate-sign" });
} catch (e) {
  if (e instanceof ConversionBlockedError) {
    // leave the lead unconverted; surface a needs-you exception for the open manual tasks
    return { skipped: "conversion_blocked", openManualTaskIds: e.openManualTaskIds };
  }
  throw e;
}
```

(Use `trigger: "canvass"` in the canvass fn. Confirm the exact call site + args in each file.)

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @savvy/agents exec vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agents/src/functions/estimate-sign.ts packages/agents/src/functions/canvass-contract.ts packages/agents/src/functions/conversion-block.test.ts
git commit -m "feat(tasks): automated conversion skips (needs-you) on ConversionBlockedError"
```

---

## Task 12: Idempotent prod cleanup script

**Files:**
- Create: `packages/db/src/scripts/cleanup-out-of-scope-tasks.ts`
- Test: `packages/db/tests/cleanup-out-of-scope.test.ts`

**Interfaces:**
- Produces: `cleanupOutOfScopeTasks({dryRun}): Promise<{ jobTaskDeleted: number; leadTaskDeleted: number; checklistDeleted: number }>` — deletes `job_task` where registry scope≠`per_job`, `lead_task` where scope≠`per_lead`, and `job_checklist_item` rows whose `payload->>'num'` ∈ {2,4,12,14}. Idempotent (re-run → 0). CLI `--dry-run`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/db/tests/cleanup-out-of-scope.test.ts
import { describe, it, expect } from "vitest";
import { adminDb, withTenant, tenant, customer, property, job, jobTask, eq, and } from "../src";
import { cleanupOutOfScopeTasks } from "../src/scripts/cleanup-out-of-scope-tasks";

describe("cleanupOutOfScopeTasks", () => {
  it("removes a per_tenant_recurring task wrongly on a job, keeps per_job", async () => {
    const [t] = await adminDb.insert(tenant).values({ name: "cl", publicKey: `k-${Date.now()}-${Math.random()}`, clerkOrgId: `o-${Date.now()}-${Math.random()}` }).returning();
    const tid = t!.id;
    const jid = await withTenant(tid, async (tx) => {
      const [c] = await tx.insert(customer).values({ tenantId: tid, name: "C" }).returning({ id: customer.id });
      const [p] = await tx.insert(property).values({ tenantId: tid, customerId: c!.id, address: "1 St" }).returning({ id: property.id });
      const [j] = await tx.insert(job).values({ tenantId: tid, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "lead" }).returning({ id: job.id });
      await tx.insert(jobTask).values({ tenantId: tid, jobId: j!.id, taskId: 14, status: "pending" }); // per_tenant_recurring (bad)
      await tx.insert(jobTask).values({ tenantId: tid, jobId: j!.id, taskId: 60, status: "pending" }); // per_job (keep)
      return j!.id;
    });
    const res = await cleanupOutOfScopeTasks({ dryRun: false });
    expect(res.jobTaskDeleted).toBeGreaterThanOrEqual(1);
    const remaining = await adminDb.select({ taskId: jobTask.taskId }).from(jobTask).where(eq(jobTask.jobId, jid));
    expect(remaining.map((r) => r.taskId).sort()).toEqual([60]);
    // idempotent
    const res2 = await cleanupOutOfScopeTasks({ dryRun: false });
    const after = await adminDb.select({ taskId: jobTask.taskId }).from(jobTask).where(eq(jobTask.jobId, jid));
    expect(after.map((r) => r.taskId)).toEqual([60]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @savvy/db exec vitest run tests/cleanup-out-of-scope.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement the script**

```ts
// packages/db/src/scripts/cleanup-out-of-scope-tasks.ts
import { sql } from "drizzle-orm";
import { adminDb, adminPool } from "../admin-client";

export async function cleanupOutOfScopeTasks(opts: { dryRun: boolean }): Promise<{ jobTaskDeleted: number; leadTaskDeleted: number; checklistDeleted: number }> {
  const count = async (q: ReturnType<typeof sql>) => Number((await adminDb.execute(q)).rows.length);
  if (opts.dryRun) {
    const jt = await adminDb.execute(sql`select jt.id from job_task jt join task_registry tr on tr.id=jt.task_id where tr.scope <> 'per_job'`);
    const lt = await adminDb.execute(sql`select lt.id from lead_task lt join task_registry tr on tr.id=lt.task_id where tr.scope <> 'per_lead'`);
    const ci = await adminDb.execute(sql`select id from job_checklist_item where (payload->>'num')::int in (2,4,12,14)`);
    return { jobTaskDeleted: jt.rows.length, leadTaskDeleted: lt.rows.length, checklistDeleted: ci.rows.length };
  }
  const jt = await adminDb.execute(sql`delete from job_task jt using task_registry tr where tr.id=jt.task_id and tr.scope <> 'per_job' returning jt.id`);
  const lt = await adminDb.execute(sql`delete from lead_task lt using task_registry tr where tr.id=lt.task_id and tr.scope <> 'per_lead' returning lt.id`);
  const ci = await adminDb.execute(sql`delete from job_checklist_item where (payload->>'num')::int in (2,4,12,14) returning id`);
  return { jobTaskDeleted: jt.rows.length, leadTaskDeleted: lt.rows.length, checklistDeleted: ci.rows.length };
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const res = await cleanupOutOfScopeTasks({ dryRun });
  console.log(JSON.stringify({ dryRun, ...res }));
  await adminPool.end();
}
if (process.argv[1] && process.argv[1].includes("cleanup-out-of-scope-tasks")) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @savvy/db exec vitest run tests/cleanup-out-of-scope.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/scripts/cleanup-out-of-scope-tasks.ts packages/db/tests/cleanup-out-of-scope.test.ts
git commit -m "feat(tasks): idempotent cleanup-out-of-scope-tasks script"
```

---

## Task 13: e2e — Tasks tab shows only job-lifecycle tasks

**Files:**
- Create: `apps/web/tests/e2e/job-task-ledger.spec.ts`
- Modify: `apps/web/tests/e2e/job-ledger-console.spec.ts` (retarget selectors to the tab if `JobLedgerCard` was removed in Task 7)

**Interfaces:**
- Consumes: seeded `job_task` (per_job) + a seeded out-of-scope row proving it does NOT render.

- [ ] **Step 1: Write the e2e test**

Seed a retail job with: two `per_job` `job_task` rows (one manual, one full_auto with evidence) and — to prove exclusion — insert a `job_checklist_item` marketing row (num 14) directly; assert the Tasks tab (`data-testid="task-row"`) renders the two registry tasks, shows a checkbox only on the manual one, a glyph+evidence on the auto one, and does **NOT** render "SEO content & blog publishing". Assert phase section headers (`data-testid="ledger-phase"`).

```ts
// skeleton
import { test, expect } from "@playwright/test";
// ...seed via adminDb (mirror job-ledger-console.spec.ts helpers)...
test("Tasks tab shows only job-lifecycle tasks; marketing excluded", async ({ page }) => {
  // seed job + job_task(manual, full_auto) + a marketing job_checklist_item row
  await page.goto(`/jobs/${jobId}`);
  await expect(page.getByTestId("job-detail")).toBeVisible();
  await page.getByRole("button", { name: "Tasks" }).click();
  await expect(page.getByTestId("task-row")).toHaveCount(2);
  await expect(page.getByText("SEO content & blog publishing")).toHaveCount(0);
  await expect(page.getByTestId("ledger-phase").first()).toBeVisible();
});
```

- [ ] **Step 2: Run e2e locally** (per savvy-crm.md: `tsx tests/e2e/create-tenant.ts` → `TEST_TENANT_ID=<id> playwright test job-task-ledger`)

Expected: PASS.

- [ ] **Step 3: Full typecheck + lint + relevant unit suites**

Run: `pnpm typecheck && pnpm lint && pnpm --filter @savvy/core exec vitest run && pnpm --filter @savvy/db exec vitest run tests/master-task-list.test.ts tests/verification-checks.test.ts`
Expected: PASS (watch the bound-set/master-task-list tests — Task 4 added an UNBOUND check so `CHECK_BINDINGS` is unchanged; if a test enumerates `evidenceChecks` keys, update its expected set to include `job.scope_integrity`).

- [ ] **Step 4: Commit**

```bash
git add apps/web/tests/e2e/job-task-ledger.spec.ts apps/web/tests/e2e/job-ledger-console.spec.ts
git commit -m "test(tasks): e2e — Tasks tab renders only job-lifecycle tasks"
```

---

## Post-implementation (not tasks — do after merge)

1. Push branch, open PR, `gh pr checks --watch` until build + e2e green.
2. **Live prod verify** (from the worktree, both-URL preflight like `rederive-prod.sh`):
   - `cleanupOutOfScopeTasks({dryRun:true})` → review counts with Brett → run without dry-run → re-run → 0.
   - Re-seed registry scope on prod (the Task 1 migration) so new instantiation is correct.
   - Open Josh's job (`019f3e4d…`) → Tasks tab shows only job-lifecycle tasks, marketing gone, statuses reflect reality. State results in the PR.

## Self-Review

- **Spec coverage:** A(1)→Tasks 1–2; B ledger→Tasks 5–7; C waiting-on→Task 9; D conversion→Tasks 10–11; E scope_integrity→Task 4; F cleanup→Task 12; G migration→Task 3; H tests→every task + Task 13. ✓
- **Placeholders:** none — real code/paths throughout. Two "confirm exact signature" notes (verification runner in Task 4; `convertLeadToJob` arg shape in Task 10) are pointers to verify against source, not placeholders for logic.
- **Type consistency:** `effectiveMode/isManual/ledgerGlyph/firstUnblockedIncomplete` defined in Task 5, consumed in Tasks 6/8/9/10; `ConversionBlockedError` defined Task 10, consumed Task 11; `note` column defined Task 3, used Tasks 6/10; `completeJobTaskManually` defined Task 8, wired Task 7/8.
