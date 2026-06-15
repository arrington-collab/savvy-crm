# Phase 2 — Jobs & Pipeline Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Seed the real 212-task lifecycle onto each job, drive it through a drag-between-stages pipeline board with auto-activating tasks, a per-job detail view, and days-in-stage/velocity analytics — all tenant-scoped.

**Architecture:** A committed CSV→JSON parser produces task templates; `seedJobTasks` seeds them per job-type at job creation; a `job/stage-changed` Inngest workflow + a shared `recordStageChange` helper handle stage moves (update stage, write a new `job_stage_event` row, activate that stage's tasks). The board (`/jobs`) drags jobs between stages via a server action; `/jobs/[id]` shows tabs; analytics read `job_stage_event`.

**Tech Stack:** Next.js 16 (App Router, server components + server actions) · Drizzle/Postgres + RLS · Inngest · `@dnd-kit/core` · Vitest · Playwright.

## Conventions (Phase 0 — enforce in every task)
- Imports: DB tables + drizzle operators from `@savvy/db` ROOT; `z`/enums from `@savvy/core`. Never `drizzle-orm`/`zod` directly, never deep `/src` paths.
- **No `.js` extensions** on relative imports.
- Every app DB access goes through `withTenant(tenantId, fn)`. New tables get the `tenant_isolation` RLS policy `TO savvy_app`.
- Server actions: `"use server"`; route handlers/actions touching pg use Node runtime.
- Migrations: edit Drizzle schema → `pnpm --filter @savvy/db db:generate` → inspect SQL → `db:migrate`. The non-superuser `savvy_app` role must keep working (RLS enforced).
- Commit messages end with the `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` trailer.

## File structure
```
packages/db/src/
  schema/jobs.ts            MODIFY: add jobStageEvent table
  seed-data/
    task-lifecycle-212.csv  source (copied from docs/specs)
    parse-lifecycle.ts      CSV -> templates (committed script)
    task-lifecycle.json     generated, committed
    templates.ts            loads json, exports typed TaskTemplate[] + PHASE_TO_STAGE
  lifecycle/
    seed-job-tasks.ts       seedJobTasks(tx, job)
    record-stage-change.ts  recordStageChange(tx, {...})
  tests/
    lifecycle.test.ts       parser + mapping + seed + stage-change unit tests
    isolation.test.ts       MODIFY: cover job_stage_event
packages/agents/src/
  client.ts                 MODIFY: add job/stage-changed event
  functions/job-stage.ts    jobStageChanged workflow
  functions/lead-intake.ts  MODIFY: seedJobTasks at job creation + initial stage event
  index.ts                  MODIFY: register jobStageChanged
apps/web/src/
  lib/pipeline-queries.ts   board data + days-in-stage + velocity
  lib/job-actions.ts        "use server": moveJobToStage, toggleTask
  app/(app)/jobs/page.tsx           board (server)
  app/(app)/jobs/board.tsx          DnD client island
  app/(app)/jobs/[id]/page.tsx      detail (server)
  app/(app)/jobs/[id]/tabs.tsx      tabs client island
  components/ui/{tabs,checkbox}.tsx shadcn primitives (added)
apps/web/tests/e2e/pipeline.spec.ts  e2e
```

---

### Task 1: `job_stage_event` table + migration + RLS

**Files:** Modify `packages/db/src/schema/jobs.ts`; generated migration in `packages/db/drizzle/`.

- [ ] **Step 1: Add the table to the schema**

Append to `packages/db/src/schema/jobs.ts` (imports already include pgTable, uuid, text, timestamp, index; add `jobStageEnum` is already imported; add `agentEnum` import from `./enums`):
```ts
export const jobStageEvent = pgTable("job_stage_event", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  jobId: uuid("job_id").notNull().references(() => job.id),
  fromStage: jobStageEnum("from_stage"),
  toStage: jobStageEnum("to_stage").notNull(),
  enteredAt: timestamp("entered_at", { withTimezone: true }).defaultNow().notNull(),
  byUserId: uuid("by_user_id").references(() => user.id),
  byAgent: agentEnum("by_agent"),
  note: text("note"),
}, (t) => [
  index("job_stage_event_tenant_job_idx").on(t.tenantId, t.jobId, t.enteredAt),
  tenantIsolation(),
]);
```
Ensure `agentEnum` is imported from `./enums` and `user` from `./tenancy` at the top of jobs.ts (jobs.ts already imports `tenant, user` and the enums it uses — add `agentEnum` to the enums import list).

- [ ] **Step 2: Export it** — `packages/db/src/schema/index.ts` already does `export * from "./jobs"`, so no change. Verify `jobStageEvent` is reachable from `@savvy/db` (the root re-exports `* from "./schema/index"`).

- [ ] **Step 3: Generate migration**

Run: `pnpm --filter @savvy/db db:generate`
Expected: a new `packages/db/drizzle/0001_*.sql`. Open it; confirm `CREATE TABLE "job_stage_event"`, `ALTER TABLE "job_stage_event" ENABLE ROW LEVEL SECURITY`, and `CREATE POLICY "tenant_isolation" ON "job_stage_event" ... TO "savvy_app"`.

- [ ] **Step 4: Apply migration**

Run: `DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/savvy pnpm --filter @savvy/db db:migrate`
Expected: `migrations + grants applied`. Verify: `docker exec savvy_db psql -U postgres -d savvy -tA -c "select count(*) from pg_policies where tablename='job_stage_event';"` → 1.

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm --filter @savvy/db typecheck`
```bash
git add packages/db/src/schema/jobs.ts packages/db/drizzle
git commit -m "feat(db): job_stage_event table + RLS for pipeline velocity"
```

---

### Task 2: CSV → task templates parser + phase mapping (TDD)

**Files:** Create `packages/db/src/seed-data/{task-lifecycle-212.csv,parse-lifecycle.ts,templates.ts}`; generated `task-lifecycle.json`. Test in `packages/db/tests/lifecycle.test.ts`.

- [ ] **Step 1: Copy the source CSV into the package**

```bash
cp docs/superpowers/specs/task-lifecycle-212.csv packages/db/src/seed-data/task-lifecycle-212.csv
```

- [ ] **Step 2: Write the template types + PHASE_TO_STAGE map** — `packages/db/src/seed-data/templates.ts`

```ts
import type { JobType, JobStage, Agent } from "@savvy/core";
import data from "./task-lifecycle.json" with { type: "json" };

export type TaskTemplate = {
  key: string;
  num: number;
  title: string;
  phase: string;
  stage: JobStage | null; // null => org-level, not seeded per job
  orgLevel: boolean;
  jobTypes: JobType[];
  automationLevel: "full" | "partial" | "manual";
  ownerAgent: Agent | null;
  ownerRole: string;
  trigger: string;
  difficulty: number;
  whatGetsAutomated: string;
};

// The 15 task phases -> 9 job stages. ORG = company-level, not seeded per job.
export const PHASE_TO_STAGE: Record<string, JobStage | "ORG"> = {
  "Lead Generation": "lead",
  "Lead Management": "lead",
  "Inspection": "inspected",
  "Estimating": "estimate",
  "Insurance Claim Management": "approved",
  "Pre-Production": "approved",
  "Production": "production",
  "Scheduling & Crew Management": "production",
  "Close-Out": "closeout",
  "Billing & Collections": "billing",
  "Reviews & Reputation": "complete",
  "Referrals & Retention": "complete",
  "Warranty Management": "complete",
  "Operations & Compliance": "ORG",
  "Reporting & Analytics": "ORG",
};

export const TASK_TEMPLATES = data as TaskTemplate[];
```

- [ ] **Step 3: Write the parser** — `packages/db/src/seed-data/parse-lifecycle.ts`

```ts
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PHASE_TO_STAGE } from "./templates";
import { JOB_TYPE } from "@savvy/core";

const here = dirname(fileURLToPath(import.meta.url));

// Tiny RFC-4180-ish CSV parser (handles quoted fields with commas/quotes).
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c === "\r") { /* skip */ }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const AGENT: Record<string, string | null> = {
  "Comms Agent": "comms", "Orchestrator": "orchestrator", "Scheduling Agent": "scheduling",
  "Finance Agent": "finance", "Claims Agent": "claims", "N/A": null, "": null,
};
const AUTO: Record<string, "full" | "partial" | "manual"> = {
  "Full Auto": "full", "Partial Auto": "partial", "Manual": "manual",
};
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

function main() {
  const rows = parseCsv(readFileSync(join(here, "task-lifecycle-212.csv"), "utf8"));
  const out = [];
  for (const r of rows) {
    if (!/^\d+$/.test((r[0] ?? "").trim())) continue; // task rows only
    const num = Number(r[0]);
    const phase = (r[2] ?? "").trim();
    const stageOrOrg = PHASE_TO_STAGE[phase];
    if (stageOrOrg === undefined) throw new Error(`Unmapped phase: "${phase}" (task ${num})`);
    const orgLevel = stageOrOrg === "ORG";
    const jt = (r[3] ?? "").trim();
    const jobTypes = jt === "All" ? [...JOB_TYPE] : [jt.toLowerCase()];
    out.push({
      key: `${slug(phase)}-${String(num).padStart(3, "0")}`,
      num,
      title: (r[1] ?? "").trim(),
      phase,
      stage: orgLevel ? null : stageOrOrg,
      orgLevel,
      jobTypes,
      automationLevel: AUTO[(r[4] ?? "").trim()] ?? "manual",
      ownerAgent: AGENT[(r[8] ?? "").trim()] ?? null,
      ownerRole: (r[7] ?? "").trim(),
      trigger: (r[6] ?? "").trim(),
      difficulty: Number((r[9] ?? "0").trim()) || 0,
      whatGetsAutomated: (r[5] ?? "").trim(),
    });
  }
  writeFileSync(join(here, "task-lifecycle.json"), JSON.stringify(out, null, 2) + "\n");
  console.log(`parsed ${out.length} task templates`);
}
main();
```
Add a script to `packages/db/package.json`: `"lifecycle:parse": "tsx src/seed-data/parse-lifecycle.ts"`.

- [ ] **Step 4: Generate the JSON**

Run: `pnpm --filter @savvy/db lifecycle:parse`
Expected: `parsed 212 task templates`; creates `task-lifecycle.json`.

- [ ] **Step 5: Write failing tests** — `packages/db/tests/lifecycle.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { TASK_TEMPLATES, PHASE_TO_STAGE } from "../src/seed-data/templates";
import { JOB_STAGE } from "@savvy/core";

describe("task lifecycle templates", () => {
  it("has all 212 tasks", () => {
    expect(TASK_TEMPLATES.length).toBe(212);
  });
  it("every phase maps to a stage or ORG", () => {
    const phases = new Set(TASK_TEMPLATES.map((t) => t.phase));
    for (const p of phases) expect(PHASE_TO_STAGE[p]).toBeDefined();
  });
  it("non-org tasks have a valid job_stage; org tasks have stage null", () => {
    for (const t of TASK_TEMPLATES) {
      if (t.orgLevel) expect(t.stage).toBeNull();
      else expect(JOB_STAGE).toContain(t.stage);
    }
  });
  it("keys are unique and stable", () => {
    const keys = TASK_TEMPLATES.map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
  it("All-type tasks expand to 4 job types", () => {
    const allTask = TASK_TEMPLATES.find((t) => t.jobTypes.length === 4);
    expect(allTask).toBeTruthy();
  });
});
```

- [ ] **Step 6: Run tests** — `pnpm --filter @savvy/db test` → lifecycle tests pass (templates.ts loads the committed json).

- [ ] **Step 7: Typecheck + commit**

```bash
git add packages/db/src/seed-data packages/db/tests/lifecycle.test.ts packages/db/package.json
git commit -m "feat(db): parse 212-task lifecycle CSV into committed templates + phase->stage map"
```

---

### Task 3: `seedJobTasks` helper (seed-all-upfront by job type) (TDD)

**Files:** Create `packages/db/src/lifecycle/seed-job-tasks.ts`. Test in `packages/db/tests/lifecycle.test.ts` (extend).

- [ ] **Step 1: Write the helper**

```ts
import { sql } from "drizzle-orm";
import { jobTask } from "../schema/index";
import { TASK_TEMPLATES } from "../seed-data/templates";
import type { JobType } from "@savvy/core";

type Tx = { insert: (t: typeof jobTask) => { values: (v: unknown[]) => Promise<unknown> } };

// Seeds every non-org template matching the job's type as a pending job_task.
// Idempotent at the call site (only call once per job, at creation).
export async function seedJobTasks(
  tx: Tx,
  job: { id: string; tenantId: string; type: JobType },
): Promise<number> {
  const templates = TASK_TEMPLATES.filter((t) => !t.orgLevel && t.jobTypes.includes(job.type));
  if (templates.length === 0) return 0;
  await tx.insert(jobTask).values(
    templates.map((t) => ({
      tenantId: job.tenantId,
      jobId: job.id,
      key: t.key,
      title: t.title,
      phase: t.phase,
      ownerAgent: t.ownerAgent ?? null,
      automationLevel: t.automationLevel,
      status: "pending" as const,
      dueAt: null,
      payload: {
        num: t.num, stage: t.stage, difficulty: t.difficulty,
        trigger: t.trigger, ownerRole: t.ownerRole, whatGetsAutomated: t.whatGetsAutomated,
      },
    })),
  );
  return templates.length;
}
```

- [ ] **Step 2: Write failing integration test** (extend `lifecycle.test.ts`) — uses `adminDb`/`withTenant` against the running DB

```ts
import { adminDb, withTenant, tenant, customer, property, job, jobTask, eq } from "@savvy/db";
import { seedJobTasks } from "../src/lifecycle/seed-job-tasks";

describe("seedJobTasks", () => {
  it("seeds retail+All non-org tasks for a retail job, none org-level", async () => {
    const [t] = await adminDb.insert(tenant).values({ name: "SEED-T", publicKey: `seed-${Date.now()}`, clerkOrgId: `org-seed-${Date.now()}` }).returning();
    const [c] = await adminDb.insert(customer).values({ tenantId: t!.id, name: "C" }).returning();
    const [p] = await adminDb.insert(property).values({ tenantId: t!.id, customerId: c!.id, address: "1 St" }).returning();
    const [j] = await adminDb.insert(job).values({ tenantId: t!.id, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "lead" }).returning();
    const n = await withTenant(t!.id, (tx) => seedJobTasks(tx as never, { id: j!.id, tenantId: t!.id, type: "retail" }));
    expect(n).toBeGreaterThan(0);
    const rows = await withTenant(t!.id, (tx) => tx.select().from(jobTask).where(eq(jobTask.jobId, j!.id)));
    expect(rows.length).toBe(n);
    // none should be an org-level phase
    expect(rows.every((r) => r.phase !== "Operations & Compliance" && r.phase !== "Reporting & Analytics")).toBe(true);
    // cleanup
    await adminDb.delete(jobTask).where(eq(jobTask.tenantId, t!.id));
    await adminDb.delete(job).where(eq(job.tenantId, t!.id));
    await adminDb.delete(property).where(eq(property.tenantId, t!.id));
    await adminDb.delete(customer).where(eq(customer.tenantId, t!.id));
    await adminDb.delete(tenant).where(eq(tenant.id, t!.id));
  });
});
```

- [ ] **Step 3: Export** — add to `packages/db/src/index.ts`: `export { seedJobTasks } from "./lifecycle/seed-job-tasks";`

- [ ] **Step 4: Run tests** — `DATABASE_URL=... DATABASE_ADMIN_URL=... pnpm --filter @savvy/db test` → all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/lifecycle/seed-job-tasks.ts packages/db/src/index.ts packages/db/tests/lifecycle.test.ts
git commit -m "feat(db): seedJobTasks — seed lifecycle tasks per job type at creation"
```

---

### Task 4: `recordStageChange` helper + stage-task activation (TDD)

**Files:** Create `packages/db/src/lifecycle/record-stage-change.ts`. Extend `lifecycle.test.ts`.

- [ ] **Step 1: Write the helper** — updates stage, writes the event + audit, activates the stage's tasks

```ts
import { and, eq, isNull, sql } from "drizzle-orm";
import { job, jobTask, jobStageEvent, auditLog } from "../schema/index";
import type { JobStage, Agent } from "@savvy/core";

type Tx = Parameters<Parameters<typeof import("../client").db.transaction>[0]>[0];

// Per-stage SLA offset (days) for activated tasks. Phase 2 default.
const DUE_DAYS = 3;

/**
 * Moves a job to `toStage`: updates job.stage + stage_entered_at, writes a
 * job_stage_event, activates that stage's still-pending tasks (sets due_at),
 * and writes an audit_log row. Idempotent on (jobId, toStage): if the job is
 * already at toStage it still re-activates any un-activated tasks but does not
 * duplicate the event for the same entered stage within the same call.
 */
export async function recordStageChange(
  tx: Tx,
  opts: { tenantId: string; jobId: string; toStage: JobStage; byUserId?: string | null; byAgent?: Agent | null; now?: Date },
): Promise<{ activated: number; fromStage: JobStage | null }> {
  const now = opts.now ?? new Date();
  const [current] = await tx.select({ stage: job.stage }).from(job).where(eq(job.id, opts.jobId));
  const fromStage = (current?.stage ?? null) as JobStage | null;

  await tx.update(job).set({ stage: opts.toStage, stageEnteredAt: now }).where(eq(job.id, opts.jobId));

  await tx.insert(jobStageEvent).values({
    tenantId: opts.tenantId, jobId: opts.jobId, fromStage, toStage: opts.toStage,
    enteredAt: now, byUserId: opts.byUserId ?? null, byAgent: opts.byAgent ?? null,
  });

  // Activate this stage's tasks: payload.stage == toStage, still pending, not yet activated.
  const dueAt = new Date(now.getTime() + DUE_DAYS * 86_400_000);
  const res = await tx.update(jobTask).set({ dueAt }).where(
    and(
      eq(jobTask.jobId, opts.jobId),
      eq(jobTask.status, "pending"),
      isNull(jobTask.dueAt),
      sql`${jobTask.payload}->>'stage' = ${opts.toStage}`,
    ),
  ).returning({ id: jobTask.id });

  await tx.insert(auditLog).values({
    tenantId: opts.tenantId, agent: opts.byAgent ?? null, userId: opts.byUserId ?? null,
    entityType: "job", entityId: opts.jobId, action: "stage_changed",
    diff: { fromStage, toStage: opts.toStage, activatedTasks: res.length },
  });

  return { activated: res.length, fromStage };
}
```

- [ ] **Step 2: Write failing integration test** (extend `lifecycle.test.ts`)

```ts
import { recordStageChange } from "../src/lifecycle/record-stage-change";
import { jobStageEvent } from "@savvy/db";

describe("recordStageChange", () => {
  it("moves stage, writes event, activates only that stage's pending tasks; idempotent re-fire activates none new", async () => {
    const [t] = await adminDb.insert(tenant).values({ name: "SC-T", publicKey: `sc-${Date.now()}`, clerkOrgId: `org-sc-${Date.now()}` }).returning();
    const [c] = await adminDb.insert(customer).values({ tenantId: t!.id, name: "C" }).returning();
    const [p] = await adminDb.insert(property).values({ tenantId: t!.id, customerId: c!.id, address: "1 St" }).returning();
    const [j] = await adminDb.insert(job).values({ tenantId: t!.id, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "lead" }).returning();
    await withTenant(t!.id, (tx) => seedJobTasks(tx as never, { id: j!.id, tenantId: t!.id, type: "retail" }));

    const r1 = await withTenant(t!.id, (tx) => recordStageChange(tx, { tenantId: t!.id, jobId: j!.id, toStage: "inspected", byAgent: "orchestrator" }));
    expect(r1.activated).toBeGreaterThan(0);
    expect(r1.fromStage).toBe("lead");

    const r2 = await withTenant(t!.id, (tx) => recordStageChange(tx, { tenantId: t!.id, jobId: j!.id, toStage: "inspected", byAgent: "orchestrator" }));
    expect(r2.activated).toBe(0); // already activated

    const events = await withTenant(t!.id, (tx) => tx.select().from(jobStageEvent).where(eq(jobStageEvent.jobId, j!.id)));
    expect(events.length).toBe(2);

    await adminDb.delete(jobTask).where(eq(jobTask.tenantId, t!.id));
    await adminDb.delete(jobStageEvent).where(eq(jobStageEvent.tenantId, t!.id));
    await adminDb.delete(job).where(eq(job.tenantId, t!.id));
    await adminDb.delete(property).where(eq(property.tenantId, t!.id));
    await adminDb.delete(customer).where(eq(customer.tenantId, t!.id));
    await adminDb.delete(tenant).where(eq(tenant.id, t!.id));
  });
});
```

- [ ] **Step 3: Export** — add to `packages/db/src/index.ts`: `export { recordStageChange } from "./lifecycle/record-stage-change";`

- [ ] **Step 4: Run tests** → pass. **Step 5: Commit**

```bash
git add packages/db/src/lifecycle/record-stage-change.ts packages/db/src/index.ts packages/db/tests/lifecycle.test.ts
git commit -m "feat(db): recordStageChange — stage move + event + idempotent task activation"
```

---

### Task 5: Extend RLS isolation test to `job_stage_event`

**Files:** Modify `packages/db/tests/isolation.test.ts`.

- [ ] **Step 1: Add a case** asserting tenant A cannot see tenant B's `job_stage_event` rows. Mirror the existing `customer` cases: in `beforeAll`, insert a job + a `job_stage_event` for tenant B (via adminDb), then in a test assert `withTenant(tenantAId, tx => tx.select().from(jobStageEvent))` returns 0 rows referencing B. Import `jobStageEvent, job, customer, property` from `@savvy/db`. Clean up in `afterAll`.

```ts
it("SELECT on job_stage_event is tenant-scoped", async () => {
  const rows = await withTenant(tenantAId, (tx) => tx.select().from(jobStageEvent));
  expect(rows.some((r) => r.tenantId === tenantBId)).toBe(false);
});
```
(Seed a B-tenant job_stage_event in beforeAll; the assertion is that A never sees it.)

- [ ] **Step 2: Run** `pnpm --filter @savvy/db test` → all isolation + lifecycle tests pass. **Step 3: Commit**

```bash
git add packages/db/tests/isolation.test.ts
git commit -m "test(db): RLS isolation covers job_stage_event"
```

---

### Task 6: `job/stage-changed` workflow + wire job creation (TDD where pure)

**Files:** Modify `packages/agents/src/client.ts`, `functions/lead-intake.ts`, `index.ts`; create `functions/job-stage.ts`.

- [ ] **Step 1: Declare the event** — in `packages/agents/src/client.ts` add to the `Events` map:
```ts
  "job/stage-changed": { data: { jobId: string; tenantId: string; toStage: string; byAgent?: string } };
```

- [ ] **Step 2: Workflow** — `packages/agents/src/functions/job-stage.ts`
```ts
import { withTenant, recordStageChange } from "@savvy/db";
import type { JobStage } from "@savvy/core";
import { inngest } from "../client";

// Durable: applies a stage change (activates tasks). The board server action
// already persisted stage+event synchronously for snappy UX; this workflow is
// the canonical path for programmatic/agent-driven stage changes and records an
// agent_run-style audit via recordStageChange. Idempotent (recordStageChange).
export const jobStageChanged = inngest.createFunction(
  { id: "job-stage-changed" },
  { event: "job/stage-changed" },
  async ({ event, step }) => {
    const { jobId, tenantId, toStage } = event.data;
    return step.run("apply", async () =>
      withTenant(tenantId, (tx) =>
        recordStageChange(tx, { tenantId, jobId, toStage: toStage as JobStage, byAgent: "orchestrator" }),
      ),
    );
  },
);
```
NOTE: to avoid double-activation, the board server action (Task 10) calls `recordStageChange` directly in its transaction AND does NOT emit `job/stage-changed` for user drags. The workflow exists for programmatic/agent moves. (Decision recorded so the two paths don't both run for one drag.)

- [ ] **Step 3: Seed tasks at job creation** — in `packages/agents/src/functions/lead-intake.ts`, the `leadBooked` `book-and-convert` step: after creating `newJob`, call `await seedJobTasks(tx as never, { id: newJob!.id, tenantId, type: "retail" });` then `await recordStageChange(tx, { tenantId, jobId: newJob!.id, toStage: "inspected", byAgent: "orchestrator" });` (replaces the manual stage set — recordStageChange sets stage `inspected`, writes the event, activates inspected tasks). Import `seedJobTasks, recordStageChange` from `@savvy/db`. Remove the now-redundant manual `lead` status/job stage lines that recordStageChange covers (keep the lead → `booked` update and the appointment insert).

- [ ] **Step 4: Register** — `packages/agents/src/index.ts`: import + add `jobStageChanged` to `functions`.

- [ ] **Step 5: Typecheck agents + run agents tests** → pass (existing lead-intake unit tests unaffected). **Step 6: Commit**

```bash
git add packages/agents/src
git commit -m "feat(agents): job/stage-changed workflow + seed tasks at job creation"
```

---

### Task 7: `pipeline-queries.ts` — board data + days-in-stage + velocity (TDD light)

**Files:** Create `apps/web/src/lib/pipeline-queries.ts`.

- [ ] **Step 1: Implement** (tenant-scoped reads; reuse `getTenantId`)
```ts
import { withTenant, job, customer, property, jobStageEvent, eq, and, sql, desc } from "@savvy/db";
import { JOB_STAGE } from "@savvy/core";
import { getTenantId } from "./tenant";

export type BoardCard = {
  id: string; stage: string; customerName: string; address: string;
  valueEstimate: number | null; stageEnteredAt: string;
};

export async function getBoard(): Promise<Record<string, BoardCard[]>> {
  const tenantId = await getTenantId();
  const rows = await withTenant(tenantId, (tx) =>
    tx.select({
      id: job.id, stage: job.stage, valueEstimate: job.valueEstimate,
      stageEnteredAt: job.stageEnteredAt, customerName: customer.name, address: property.address,
    }).from(job)
      .leftJoin(customer, eq(customer.id, job.customerId))
      .leftJoin(property, eq(property.id, job.propertyId))
      .orderBy(desc(job.stageEnteredAt)),
  );
  const byStage = Object.fromEntries(JOB_STAGE.map((s) => [s, [] as BoardCard[]]));
  for (const r of rows) {
    byStage[r.stage]?.push({
      id: r.id, stage: r.stage, customerName: r.customerName ?? "—", address: r.address ?? "—",
      valueEstimate: r.valueEstimate, stageEnteredAt: (r.stageEnteredAt as Date).toISOString(),
    });
  }
  return byStage;
}

// Avg days spent in each stage across this tenant's stage events (velocity).
export async function getStageVelocity(): Promise<Record<string, number>> {
  const tenantId = await getTenantId();
  const rows = await withTenant(tenantId, (tx) =>
    tx.execute(sql`
      with ordered as (
        select job_id, to_stage, entered_at,
               lead(entered_at) over (partition by job_id order by entered_at) as next_at
        from job_stage_event
      )
      select to_stage as stage,
             avg(extract(epoch from (next_at - entered_at))/86400.0) as avg_days
      from ordered where next_at is not null group by to_stage
    `),
  );
  const out: Record<string, number> = {};
  for (const r of (rows as unknown as { rows: { stage: string; avg_days: string }[] }).rows ?? (rows as unknown as { stage: string; avg_days: string }[])) {
    out[r.stage] = Math.round(Number(r.avg_days) * 10) / 10;
  }
  return out;
}
```
(NOTE: `tx.execute` raw-SQL result shape depends on the driver — node-postgres returns `{ rows }`. The implementer must verify the shape against drizzle node-postgres and adjust the destructure; add a unit/integration check.)

- [ ] **Step 2: Typecheck web** → 0. **Step 3: Commit**

```bash
git add apps/web/src/lib/pipeline-queries.ts
git commit -m "feat(web): pipeline board queries + stage velocity"
```

---

### Task 8: shadcn primitives (tabs, checkbox) + `@dnd-kit/core`

**Files:** add `apps/web/src/components/ui/{tabs,checkbox}.tsx`; deps.

- [ ] **Step 1:** `cd apps/web && pnpm dlx shadcn@latest add tabs checkbox`. If `base-nova` again pulls `@base-ui`/odd deps, replace with minimal dependency-light versions (match the Phase-0 pattern: native `<button>`/`<input type=checkbox>` + `cn`, Tabs via a tiny client component with `useState`). Verify typecheck.
- [ ] **Step 2:** `pnpm add @dnd-kit/core @dnd-kit/sortable` in apps/web.
- [ ] **Step 3:** Typecheck → 0. **Commit** `feat(web): tabs + checkbox primitives, dnd-kit`.

---

### Task 9: `/jobs` board — server component

**Files:** `apps/web/src/app/(app)/jobs/page.tsx` (replace stub).

- [ ] **Step 1:** Server component: `export const dynamic = "force-dynamic"`; `const board = await getBoard(); const velocity = await getStageVelocity();` render the analytics strip (jobs per stage counts, avg days/stage, stuck flag where `now - stageEnteredAt > 7d`) and pass `board` to the `<Board>` client island. Active columns: lead→inspected→estimate→approved→production→closeout→billing→complete; `lost` as a muted column. Use `data-testid="board"`, `data-testid="col-<stage>"`, `data-testid="job-card"`.
- [ ] **Step 2:** Typecheck → 0. **Commit** `feat(web): jobs board server page + analytics strip`.

---

### Task 10: Board DnD client island + `moveJobToStage` server action

**Files:** `apps/web/src/app/(app)/jobs/board.tsx`; `apps/web/src/lib/job-actions.ts`.

- [ ] **Step 1: Server action** — `apps/web/src/lib/job-actions.ts`
```ts
"use server";
import { withTenant, recordStageChange } from "@savvy/db";
import { revalidatePath } from "next/cache";
import { getTenantId } from "./tenant";
import type { JobStage } from "@savvy/core";

export async function moveJobToStage(jobId: string, toStage: JobStage): Promise<{ ok: true }> {
  const tenantId = await getTenantId();
  await withTenant(tenantId, (tx) => recordStageChange(tx, { tenantId, jobId, toStage }));
  revalidatePath("/jobs");
  return { ok: true };
}
```
(Synchronous path for drags — calls `recordStageChange` directly, does NOT emit `job/stage-changed`, per Task 6 note.)

- [ ] **Step 2: Client island** `board.tsx` (`"use client"`): `@dnd-kit` columns + draggable cards; on drop call `moveJobToStage(jobId, toStage)` optimistically (local state move first, revert + toast on rejection). Keep it focused; cards show customer, address, value, days-in-stage.
- [ ] **Step 3:** Typecheck → 0. **Commit** `feat(web): drag-between-stages board + moveJobToStage action`.

---

### Task 11: `/jobs/[id]` detail — header + Tasks tab + `toggleTask` action

**Files:** `apps/web/src/app/(app)/jobs/[id]/page.tsx`, `[id]/tabs.tsx`; extend `job-actions.ts`.

- [ ] **Step 1: `toggleTask` server action** (in `job-actions.ts`)
```ts
export async function toggleTask(taskId: string, done: boolean): Promise<{ ok: true }> {
  const tenantId = await getTenantId();
  await withTenant(tenantId, async (tx) => {
    await tx.update(jobTask).set({
      status: done ? "done" : "pending", completedAt: done ? new Date() : null,
    }).where(eq(jobTask.id, taskId));
  });
  revalidatePath("/jobs", "layout");
  return { ok: true };
}
```
(Add imports `jobTask, eq`.)

- [ ] **Step 2: Detail page** (server, `dynamic="force-dynamic"`, `await params`): load the job (+customer/property), its `job_task` rows grouped by phase ordered by `payload->>'num'`, recent `communication`, `job_stage_event` + `audit_log` for the timeline. Pass to the `<JobTabs>` island. Header card: customer, address, type, stage, value, days-in-stage. `data-testid="job-detail"`, `data-testid="task-row"`.
- [ ] **Step 3: Tasks tab** in `tabs.tsx` (`"use client"`): grouped checklist; checkbox calls `toggleTask`; automation badge ("Full Auto → will be automated" / "Manual"); show due date if `dueAt` set ("active") else "upcoming". Other tabs stubbed in this task (filled in Task 12).
- [ ] **Step 4:** Typecheck → 0. **Commit** `feat(web): job detail + tasks tab + toggleTask action`.

---

### Task 12: Timeline, Comms, Docs tabs

**Files:** extend `apps/web/src/app/(app)/jobs/[id]/tabs.tsx` + the detail page loader.

- [ ] **Step 1:** Timeline tab: merge `job_stage_event` (stage moves), `communication`, `audit_log` (task_changed) into one time-sorted list (server builds the merged array; client renders). Comms tab: `communication` rows. Docs tab: `document` rows (empty-state + disabled "Upload — coming in Phase 6").
- [ ] **Step 2:** Typecheck → 0. **Commit** `feat(web): job detail timeline + comms + docs tabs`.

---

### Task 13: Playwright e2e — create → board → drag → activate → analytics

**Files:** `apps/web/tests/e2e/pipeline.spec.ts`.

- [ ] **Step 1:** Reuse the Phase-0 harness (ai-stub, inngest dev, TEST_MODE, fresh tenant from `create-tenant.ts`). The spec: seed a job for the e2e tenant directly via `adminDb` at stage `lead` + `seedJobTasks` (or drive the lead→job flow), load `/jobs`, assert the card is in `col-lead`; drag it to `inspected` (or call `moveJobToStage` via the page and reload); assert `job_stage_event` row exists and inspected-phase tasks now have `dueAt` (query via adminDb); open `/jobs/[id]`, assert Tasks tab shows an active inspected task; assert the board analytics show the move.
- [ ] **Step 2: Run** locally (start ai-stub + inngest dev, create tenant, `playwright test pipeline.spec.ts`). Kill all services after. Expected: pass.
- [ ] **Step 3: Commit** `test(web): e2e — pipeline drag activates lifecycle tasks`.

---

### Task 14: CI + full gate

- [ ] **Step 1:** The existing `e2e` CI job runs `playwright test` (all specs incl. the new one) — verify it picks up `pipeline.spec.ts`. Confirm `pnpm test` (vitest) runs the new lifecycle tests (they need `DATABASE_URL`/`ADMIN` — already in CI env for both jobs; the `build` job's `Test` step runs migrate first, good).
- [ ] **Step 2:** Run the full local gate: `pnpm typecheck && pnpm lint && DATABASE_URL=... DATABASE_ADMIN_URL=... pnpm test`. Fix any fallout.
- [ ] **Step 3: Commit** any CI tweaks; push the branch; open a PR; confirm both CI jobs green.

```bash
git push -u origin feat/phase2-jobs-pipeline
gh pr create --base main --title "Phase 2 — jobs & pipeline core" --body "<summary + test plan>"
```

---

## Self-review

**Spec coverage:** 212-task parser+templates (T2) · phase→stage map (T2) · seed-all-upfront (T3) · stage-change engine + activation (T4,T6) · job_stage_event table+RLS (T1,T5) · board + drag (T9,T10) · job detail tabs (T11,T12) · days-in-stage + velocity analytics (T7,T9) · e2e (T13) · CI (T14). All spec sections covered.

**Known follow-ups flagged in tasks:** raw-SQL result shape in `getStageVelocity` (T7) must be verified against node-postgres; the dual stage-change paths (server action direct vs workflow) are deliberately separated (T6 note) so a user drag doesn't double-activate.

**Type consistency:** `recordStageChange`/`seedJobTasks` signatures, `TaskTemplate` shape, and `job_stage_event` columns are referenced consistently across tasks. `payload->>'stage'` activation key matches the `payload.stage` written in `seedJobTasks`.
