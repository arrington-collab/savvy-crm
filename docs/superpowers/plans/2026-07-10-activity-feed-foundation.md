# Activity Feed Foundation (Slice 0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `/activity` — one live, tenant-wide, evidence-backed stream of agent + human actions — plus the two-phase `agent_run` lifecycle primitives and reaper that the whole "Show the Machine Working" motion program reads from.

**Architecture:** Extend the existing single write-path (`recordAgentRun`) into `beginAgentRun` + `completeAgentRun` primitives, keeping `recordAgentRun` as a back-to-back wrapper so no existing caller breaks. Add a reaper cron that closes orphaned `running` rows. Reuse the existing `listAgentActivity` join (customer name via job OR lead), extend it with `finishedAt` + filters + keyset pagination, expose it through a JSON poll route, and render it in a read-only `/activity` page that polls every 15s. Author the `activity.attribution` invariant and backfill writers that could attribute a run but don't.

**Tech Stack:** Next.js App Router (server components + a client poll component), Drizzle ORM over Postgres (RLS via `withTenant`), Inngest (reaper cron), Vitest (unit/integration), Playwright (e2e), `@savvy/core` verification framework.

## Global Constraints

- **Tenant isolation on every query** — all reads/writes go through `withTenant`; never `adminDb` for tenant data except cross-tenant sweeps that then scope per tenant. A cross-tenant feed test must stay green. (CLAUDE.md #1)
- **No new nav item** — `/activity` is reachable only from the "While you were out" panel + the Agents page. Nav stays at 5. (run-queue #6.1)
- **Read-only** — `/activity` performs no mutations.
- **Reduced motion** — any animation ships as a `.anim-*` class inside `@media (prefers-reduced-motion: no-preference)` in `apps/web/src/app/globals.css`. (spec §4)
- **`skipped` ≠ failure** — render `skipped` neutral (amber), never red, never fake success. (spec §4)
- **Config in one place** — thresholds live in one `@savvy/core` config module: `RUN_STALE_MINUTES=10`, `POLL_SECONDS=15`. (spec §3)
- **Tests + typecheck + lint clean per commit**; small commits. Commands: `pnpm test`, `pnpm typecheck`, `pnpm lint`. (CLAUDE.md #6)
- **Check the drizzle journal from your worktree before generating any migration.** (house rule)

---

## File Structure

- `packages/core/src/showcase-config.ts` — **Create.** Program config constants (`RUN_STALE_MINUTES`, `POLL_SECONDS`, etc.).
- `packages/core/src/agent-verbs.ts` — **Create.** `taskKey → {verb, category}` plain-words map + `verbFor()` fallback.
- `packages/db/src/lifecycle/agent-run.ts` — **Modify.** Add `beginAgentRun`/`completeAgentRun`; re-implement `recordAgentRun` as wrapper; extend `listAgentActivity` (finishedAt + filters + cursor); add `markStaleRunsTimedOut`.
- `packages/db/src/schema/agents.ts` — **Modify.** Add indexes on `agent_run`.
- `packages/db/migrations/NNNN_*.sql` — **Create (generated).** The index migration.
- `packages/agents/src/functions/run-reaper.ts` — **Create.** Inngest cron closing orphaned `running` rows.
- `packages/agents/src/client.ts` (or the function registry) — **Modify.** Register `runReaper`.
- `packages/core/src/verification/checks.ts` — **Modify.** Add `activity.attribution` invariant.
- `apps/web/src/lib/command-center-queries.ts` — **Modify.** Add `loadActivityPage()` (filters + cursor).
- `apps/web/src/app/api/activity/route.ts` — **Create.** GET JSON poll endpoint.
- `apps/web/src/components/activity/ActivityFeed.tsx` — **Create.** Client component: 15s poll, live dot, filters, reduced-motion-safe.
- `apps/web/src/components/activity/ActivityRow.tsx` — **Create.** One row (extracted from command-center rendering), uses `verbFor()`.
- `apps/web/src/app/(app)/activity/page.tsx` — **Create.** Read-only server page shell hosting `ActivityFeed`.
- `apps/web/src/app/(app)/today/page.tsx` — **Modify.** Add "view live feed →" link in the "While you were out" panel header.
- `apps/web/src/app/(app)/agents/page.tsx` — **Modify.** Add `/activity` ("Live activity") link.
- `apps/web/tests/e2e/activity-feed.spec.ts` — **Create.** Playwright: feed renders, `?job=` filter, error filter.

---

## Task 1: Showcase config module

**Files:**
- Create: `packages/core/src/showcase-config.ts`
- Modify: `packages/core/src/index.ts` (export it)
- Test: `packages/core/src/showcase-config.test.ts`

**Interfaces:**
- Produces: `SHOWCASE = { RUN_STALE_MINUTES: 10, POLL_SECONDS: 15, SPINNER_MAX_SECONDS: 90, COLD_DAYS: 7, REPLAY_SECONDS: 90 } as const`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/showcase-config.test.ts
import { describe, it, expect } from "vitest";
import { SHOWCASE } from "./showcase-config";

describe("SHOWCASE config", () => {
  it("exposes the program thresholds", () => {
    expect(SHOWCASE.RUN_STALE_MINUTES).toBe(10);
    expect(SHOWCASE.POLL_SECONDS).toBe(15);
    expect(SHOWCASE.SPINNER_MAX_SECONDS).toBe(90);
    expect(SHOWCASE.COLD_DAYS).toBe(7);
    expect(SHOWCASE.REPLAY_SECONDS).toBe(90);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @savvy/core test showcase-config`
Expected: FAIL — cannot find module `./showcase-config`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/core/src/showcase-config.ts
/** Single source of truth for "Show the Machine Working" thresholds (spec §3). */
export const SHOWCASE = {
  /** Reaper marks running rows older than this many minutes error/timed_out. */
  RUN_STALE_MINUTES: 10,
  /** Feed / card poll cadence, seconds. */
  POLL_SECONDS: 15,
  /** UI never shows a live spinner for a run older than this many seconds. */
  SPINNER_MAX_SECONDS: 90,
  /** A card goes cold past this many days since last touch. */
  COLD_DAYS: 7,
  /** Target wall-clock length of a day replay, seconds. */
  REPLAY_SECONDS: 90,
} as const;
```

Then add `export * from "./showcase-config";` to `packages/core/src/index.ts` (place it beside the other config exports).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @savvy/core test showcase-config`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/showcase-config.ts packages/core/src/showcase-config.test.ts packages/core/src/index.ts
git commit -m "feat(core): showcase config thresholds (activity foundation)"
```

---

## Task 2: Plain-words verb map

**Files:**
- Create: `packages/core/src/agent-verbs.ts`
- Modify: `packages/core/src/index.ts` (export it)
- Test: `packages/core/src/agent-verbs.test.ts`

**Interfaces:**
- Produces: `verbFor(taskKey: string | null): { verb: string; category: string }` — maps a dotted taskKey to a plain-words verb + category; humanizes unmapped keys as a fallback.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/agent-verbs.test.ts
import { describe, it, expect } from "vitest";
import { verbFor } from "./agent-verbs";

describe("verbFor", () => {
  it("maps known task keys to plain words", () => {
    expect(verbFor("lead.rep.alert").verb).toBe("alerted the rep");
    expect(verbFor("ops.digest").verb).toBe("sent the daily digest");
  });
  it("humanizes unknown dotted keys as a fallback (never the raw key)", () => {
    const r = verbFor("finance.qb.reconcile");
    expect(r.verb).not.toContain(".");
    expect(r.verb.length).toBeGreaterThan(0);
    expect(r.category).toBe("finance");
  });
  it("handles null", () => {
    expect(verbFor(null).verb).toBe("took an action");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @savvy/core test agent-verbs`
Expected: FAIL — cannot find module `./agent-verbs`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/core/src/agent-verbs.ts
/**
 * Plain-words map for agent_run.task_key. The feed, cards, and shift report all
 * render THIS, never the dotted machine key. Unknown keys humanize as a fallback
 * (category = first dotted segment) so a new taskKey is legible on day one.
 */
const VERBS: Record<string, { verb: string; category: string }> = {
  "lead.rep.alert": { verb: "alerted the rep", category: "lead" },
  "lead.speed_to_contact": { verb: "made first contact", category: "lead" },
  "lead.calibration": { verb: "recalibrated lead scoring", category: "lead" },
  "ops.digest": { verb: "sent the daily digest", category: "ops" },
  "estimate.generate": { verb: "drafted an estimate", category: "estimate" },
  "lead.doc_parse": { verb: "parsed a document", category: "lead" },
  "drip.append": { verb: "sent a follow-up", category: "comms" },
  "finance.dunning": { verb: "chased a late invoice", category: "finance" },
  "finance.commissions": { verb: "calculated a commission", category: "finance" },
  "enrichment.property": { verb: "enriched a property", category: "enrichment" },
};

function humanize(taskKey: string): { verb: string; category: string } {
  const [category, ...rest] = taskKey.split(".");
  const words = rest.join(" ").replace(/[_.]/g, " ").trim() || category;
  return { verb: words, category: category || "agent" };
}

export function verbFor(taskKey: string | null): { verb: string; category: string } {
  if (!taskKey) return { verb: "took an action", category: "agent" };
  return VERBS[taskKey] ?? humanize(taskKey);
}
```

Add `export * from "./agent-verbs";` to `packages/core/src/index.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @savvy/core test agent-verbs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/agent-verbs.ts packages/core/src/agent-verbs.test.ts packages/core/src/index.ts
git commit -m "feat(core): plain-words verb map for agent task keys"
```

---

## Task 3: Two-phase run lifecycle primitives

**Files:**
- Modify: `packages/db/src/lifecycle/agent-run.ts:14-43`
- Test: `packages/db/src/lifecycle/agent-run.test.ts` (existing — add cases)

**Interfaces:**
- Consumes: existing `agentRun` schema, `withTenant`, `AgentRunStatus`.
- Produces:
  - `beginAgentRun(input: { tenantId: string; agent: Agent; taskKey: string; jobId?: string | null; leadId?: string | null; inngestRunId?: string | null; modelUsed?: string | null }): Promise<string>` — inserts a `running` row (`finishedAt: null`), returns the new run id.
  - `completeAgentRun(input: { tenantId: string; runId: string; status: Exclude<AgentRunStatus, "running">; tokens?: number | null; costCents?: number | null; modelUsed?: string | null; error?: string | null }): Promise<void>` — updates the row to terminal, stamps `finishedAt: now()`.
  - `recordAgentRun(...)` — unchanged signature; now internally `begin` then `complete` (behaviour identical to callers).

- [ ] **Step 1: Write the failing tests**

```ts
// add to packages/db/src/lifecycle/agent-run.test.ts
import { beginAgentRun, completeAgentRun } from "./agent-run";

it("beginAgentRun inserts a running row with null finishedAt", async () => {
  const runId = await beginAgentRun({ tenantId, agent: "orchestrator", taskKey: "test.begin" });
  const [row] = await withTenant(tenantId, (tx) =>
    tx.select().from(agentRun).where(eq(agentRun.id, runId)));
  expect(row.status).toBe("running");
  expect(row.finishedAt).toBeNull();
});

it("completeAgentRun transitions the row to terminal and stamps finishedAt", async () => {
  const runId = await beginAgentRun({ tenantId, agent: "orchestrator", taskKey: "test.complete" });
  await completeAgentRun({ tenantId, runId, status: "ok", tokens: 10, costCents: 2 });
  const [row] = await withTenant(tenantId, (tx) =>
    tx.select().from(agentRun).where(eq(agentRun.id, runId)));
  expect(row.status).toBe("ok");
  expect(row.finishedAt).not.toBeNull();
  expect(row.tokens).toBe(10);
});

it("recordAgentRun still writes one terminal row (wrapper unchanged for callers)", async () => {
  await recordAgentRun({ tenantId, agent: "orchestrator", taskKey: "test.record", status: "ok" });
  const [row] = await withTenant(tenantId, (tx) =>
    tx.select().from(agentRun).where(eq(agentRun.taskKey, "test.record")));
  expect(row.status).toBe("ok");
  expect(row.finishedAt).not.toBeNull();
});
```

(Match the existing test file's tenant setup + imports — reuse its `tenantId`/`eq`/`agentRun` bindings.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @savvy/db test agent-run`
Expected: FAIL — `beginAgentRun`/`completeAgentRun` not exported.

- [ ] **Step 3: Write minimal implementation**

Replace the `recordAgentRun` block (`agent-run.ts:14-43`) with:

```ts
export async function beginAgentRun(input: {
  tenantId: string; agent: Agent; taskKey: string;
  jobId?: string | null; leadId?: string | null;
  inngestRunId?: string | null; modelUsed?: string | null;
}): Promise<string> {
  return withTenant(input.tenantId, async (tx) => {
    const [row] = await tx.insert(agentRun).values({
      tenantId: input.tenantId,
      agent: input.agent,
      taskKey: input.taskKey,
      status: "running",
      jobId: input.jobId ?? null,
      leadId: input.leadId ?? null,
      inngestRunId: input.inngestRunId ?? null,
      modelUsed: input.modelUsed ?? null,
      finishedAt: null,
    }).returning({ id: agentRun.id });
    return row.id;
  });
}

export async function completeAgentRun(input: {
  tenantId: string; runId: string;
  status: Exclude<AgentRunStatus, "running">;
  tokens?: number | null; costCents?: number | null;
  modelUsed?: string | null; error?: string | null;
}): Promise<void> {
  await withTenant(input.tenantId, (tx) =>
    tx.update(agentRun).set({
      status: input.status,
      tokens: input.tokens ?? null,
      costCents: input.costCents ?? null,
      modelUsed: input.modelUsed ?? undefined, // keep begin's model if not re-supplied
      error: input.error ?? null,
      finishedAt: new Date(),
    }).where(eq(agentRun.id, input.runId)),
  );
}

/** Back-compat wrapper: one-shot terminal write, identical to the old behaviour. */
export async function recordAgentRun(input: {
  tenantId: string; agent: Agent; taskKey: string; status: AgentRunStatus;
  jobId?: string | null; leadId?: string | null; modelUsed?: string | null;
  tokens?: number | null; costCents?: number | null; inngestRunId?: string | null; error?: string | null;
}): Promise<void> {
  const runId = await beginAgentRun({
    tenantId: input.tenantId, agent: input.agent, taskKey: input.taskKey,
    jobId: input.jobId, leadId: input.leadId, inngestRunId: input.inngestRunId, modelUsed: input.modelUsed,
  });
  if (input.status === "running") return; // caller explicitly wants an open run
  await completeAgentRun({
    tenantId: input.tenantId, runId, status: input.status,
    tokens: input.tokens, costCents: input.costCents, modelUsed: input.modelUsed, error: input.error,
  });
}
```

Add `eq` to the drizzle import if not already present (`import { desc, eq, sql } from "drizzle-orm";` already has it).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @savvy/db test agent-run`
Expected: PASS (new cases + existing cases still green).

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/lifecycle/agent-run.ts packages/db/src/lifecycle/agent-run.test.ts
git commit -m "feat(db): two-phase agent_run lifecycle (begin/complete + wrapper)"
```

---

## Task 4: agent_run indexes migration

**Files:**
- Modify: `packages/db/src/schema/agents.ts:25`
- Create: `packages/db/migrations/NNNN_agent_run_feed_indexes.sql` (generated)

**Interfaces:**
- Produces: indexes `agent_run_started_idx (tenant_id, started_at desc)`, `agent_run_job_idx (job_id)`, `agent_run_lead_idx (lead_id)`, `agent_run_status_idx (status)`.

- [ ] **Step 1: Read the drizzle journal FIRST**

Run: `cat packages/db/migrations/meta/_journal.json | tail -20`
Confirm the latest migration number so the generated file lands next in sequence. (House rule — never generate blind.)

- [ ] **Step 2: Add indexes to the schema**

Edit the `agentRun` table's index array (`agents.ts:25`) from:

```ts
}, (t) => [index("agent_run_tenant_idx").on(t.tenantId), tenantIsolation()]);
```

to:

```ts
}, (t) => [
  index("agent_run_tenant_idx").on(t.tenantId),
  index("agent_run_started_idx").on(t.tenantId, t.startedAt.desc()),
  index("agent_run_job_idx").on(t.jobId),
  index("agent_run_lead_idx").on(t.leadId),
  index("agent_run_status_idx").on(t.status),
  tenantIsolation(),
]);
```

- [ ] **Step 3: Generate the migration**

Run: `pnpm db:generate`
Expected: a new `packages/db/migrations/NNNN_*.sql` creating the four indexes. Open it and confirm it only adds indexes (no unexpected drops).

- [ ] **Step 4: Apply + verify locally**

Run: `pnpm db:migrate`
Then verify: `psql "$DATABASE_URL" -c "\di agent_run_*"` shows the four new indexes.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/schema/agents.ts packages/db/migrations/
git commit -m "feat(db): index agent_run for feed + heartbeat queries"
```

---

## Task 5: Run reaper (Inngest cron)

**Files:**
- Modify: `packages/db/src/lifecycle/agent-run.ts` (add `markStaleRunsTimedOut`)
- Create: `packages/agents/src/functions/run-reaper.ts`
- Modify: the function registry that lists Inngest functions (mirror where `coldArchiveDocuments` is registered)
- Test: `packages/db/src/lifecycle/agent-run.test.ts` (reaper query)

**Interfaces:**
- Consumes: `withTenant`, `agentRun`, `SHOWCASE.RUN_STALE_MINUTES`, `beginAgentRun` pattern.
- Produces: `markStaleRunsTimedOut(tenantId: string, cutoff: Date): Promise<number>` — flips `running` rows with `startedAt < cutoff` to `status:'error'`, `error:'timed_out'`, `finishedAt: now()`; returns count. Inngest fn `runReaper`.

- [ ] **Step 1: Write the failing test**

```ts
// add to packages/db/src/lifecycle/agent-run.test.ts
import { markStaleRunsTimedOut } from "./agent-run";

it("markStaleRunsTimedOut closes orphaned running rows past the cutoff", async () => {
  const stale = await beginAgentRun({ tenantId, agent: "orchestrator", taskKey: "test.stale" });
  // force startedAt into the past
  await withTenant(tenantId, (tx) =>
    tx.update(agentRun).set({ startedAt: new Date(Date.now() - 60 * 60_000) }).where(eq(agentRun.id, stale)));
  const fresh = await beginAgentRun({ tenantId, agent: "orchestrator", taskKey: "test.fresh" });

  const n = await markStaleRunsTimedOut(tenantId, new Date(Date.now() - 10 * 60_000));
  expect(n).toBe(1);

  const [staleRow] = await withTenant(tenantId, (tx) => tx.select().from(agentRun).where(eq(agentRun.id, stale)));
  const [freshRow] = await withTenant(tenantId, (tx) => tx.select().from(agentRun).where(eq(agentRun.id, fresh)));
  expect(staleRow.status).toBe("error");
  expect(staleRow.error).toBe("timed_out");
  expect(freshRow.status).toBe("running"); // young run untouched
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @savvy/db test agent-run`
Expected: FAIL — `markStaleRunsTimedOut` not exported.

- [ ] **Step 3: Write the query**

Append to `packages/db/src/lifecycle/agent-run.ts` (add `and`, `lt` to the drizzle import):

```ts
/** Reaper: close running rows older than the cutoff so no card spins forever. */
export async function markStaleRunsTimedOut(tenantId: string, cutoff: Date): Promise<number> {
  return withTenant(tenantId, async (tx) => {
    const res = await tx.update(agentRun)
      .set({ status: "error", error: "timed_out", finishedAt: new Date() })
      .where(and(eq(agentRun.status, "running"), lt(agentRun.startedAt, cutoff)))
      .returning({ id: agentRun.id });
    return res.length;
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @savvy/db test agent-run`
Expected: PASS.

- [ ] **Step 5: Write the Inngest cron (mirror cold-archive.ts)**

```ts
// packages/agents/src/functions/run-reaper.ts
import { adminDb, tenant, markStaleRunsTimedOut } from "@savvy/db";
import { SHOWCASE } from "@savvy/core";
import { inngest } from "../client";

/** Every 5 minutes: flip orphaned `running` agent_run rows to error/timed_out
 *  across all tenants, so a crashed function never leaves a stuck spinner. */
export const runReaper = inngest.createFunction(
  { id: "run-reaper", concurrency: { limit: 1 } },
  { cron: "*/5 * * * *" },
  async ({ step }) => {
    const cutoff = await step.run("cutoff", async () =>
      new Date(Date.now() - SHOWCASE.RUN_STALE_MINUTES * 60_000));
    const tenants = await step.run("tenants", async () =>
      (await adminDb.select({ id: tenant.id }).from(tenant)).map((t) => t.id));
    let closed = 0;
    for (const id of tenants) {
      closed += await step.run(`reap-${id}`, () =>
        markStaleRunsTimedOut(id, new Date(cutoff as unknown as string)));
    }
    return { closed };
  },
);
```

- [ ] **Step 6: Register the function**

Find where `coldArchiveDocuments` is added to the served functions array (`grep -rn "coldArchiveDocuments" packages/agents/src apps/web/src`) and add `runReaper` alongside it, mirroring the import + array entry exactly.

- [ ] **Step 7: Typecheck + commit**

Run: `pnpm typecheck`
Expected: clean.

```bash
git add packages/db/src/lifecycle/agent-run.ts packages/db/src/lifecycle/agent-run.test.ts packages/agents/src/functions/run-reaper.ts packages/agents/src/client.ts
git commit -m "feat(agents): reaper cron closes orphaned running agent runs"
```

---

## Task 6: Extend the feed query (finishedAt + filters + cursor)

**Files:**
- Modify: `packages/db/src/lifecycle/agent-run.ts` (`AgentActivityRow` + `listAgentActivity`)
- Test: `packages/db/src/lifecycle/agent-run.test.ts`

**Interfaces:**
- Produces:
  - `AgentActivityRow` gains `finishedAt: Date | null`.
  - `listAgentActivity(tenantId: string, opts: { limit: number; before?: Date; agent?: string; status?: string; jobId?: string }): Promise<AgentActivityRow[]>` — keyset paginated by `startedAt` (`before`), optional filters. **Note:** this changes the signature from `(tenantId, limit)` to `(tenantId, opts)`; update the two existing callers in `command-center-queries.ts` (`getAgentActivity`) accordingly in this task.

- [ ] **Step 1: Write the failing tests**

```ts
// add to packages/db/src/lifecycle/agent-run.test.ts
it("listAgentActivity filters by status and paginates with before-cursor", async () => {
  await recordAgentRun({ tenantId, agent: "orchestrator", taskKey: "f.ok", status: "ok" });
  await recordAgentRun({ tenantId, agent: "orchestrator", taskKey: "f.err", status: "error" });
  const errs = await listAgentActivity(tenantId, { limit: 50, status: "error" });
  expect(errs.every((r) => r.status === "error")).toBe(true);
  expect(errs.length).toBeGreaterThan(0);

  const page1 = await listAgentActivity(tenantId, { limit: 1 });
  const page2 = await listAgentActivity(tenantId, { limit: 1, before: page1[0].startedAt });
  expect(page2[0]?.id).not.toBe(page1[0].id); // cursor advanced
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @savvy/db test agent-run`
Expected: FAIL — `listAgentActivity` still takes `(tenantId, limit)`.

- [ ] **Step 3: Rewrite `listAgentActivity`**

Add `finishedAt: agentRun.finishedAt` to `AgentActivityRow` and the select; replace the function body with a where-clause builder:

```ts
export async function listAgentActivity(
  tenantId: string,
  opts: { limit: number; before?: Date; agent?: string; status?: string; jobId?: string },
): Promise<AgentActivityRow[]> {
  const jobCustomer = alias(customer, "job_customer");
  const leadCustomer = alias(customer, "lead_customer");
  const conds = [];
  if (opts.before) conds.push(lt(agentRun.startedAt, opts.before));
  if (opts.agent) conds.push(eq(agentRun.agent, opts.agent as Agent));
  if (opts.status) conds.push(eq(agentRun.status, opts.status));
  if (opts.jobId) conds.push(eq(agentRun.jobId, opts.jobId));
  return withTenant(tenantId, (tx) =>
    tx.select({
      id: agentRun.id, agent: agentRun.agent, taskKey: agentRun.taskKey, status: agentRun.status,
      modelUsed: agentRun.modelUsed, startedAt: agentRun.startedAt, finishedAt: agentRun.finishedAt,
      target: sql<string | null>`coalesce(${jobCustomer.name}, ${leadCustomer.name})`, error: agentRun.error,
    })
      .from(agentRun)
      .leftJoin(job, eq(job.id, agentRun.jobId))
      .leftJoin(jobCustomer, eq(jobCustomer.id, job.customerId))
      .leftJoin(lead, eq(lead.id, agentRun.leadId))
      .leftJoin(leadCustomer, eq(leadCustomer.id, lead.customerId))
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(agentRun.startedAt))
      .limit(opts.limit),
  );
}
```

- [ ] **Step 4: Update the two existing callers**

In `apps/web/src/lib/command-center-queries.ts`, change `getAgentActivity` to call `listAgentActivity(tenantId, { limit })`, and keep `loadAgentActivity(limit = 30)` as-is (it delegates).

- [ ] **Step 5: Run tests + typecheck**

Run: `pnpm --filter @savvy/db test agent-run && pnpm typecheck`
Expected: PASS + clean (command-center page still compiles).

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/lifecycle/agent-run.ts packages/db/src/lifecycle/agent-run.test.ts apps/web/src/lib/command-center-queries.ts
git commit -m "feat(db): activity feed filters + keyset pagination + finishedAt"
```

---

## Task 7: Activity poll route

**Files:**
- Modify: `apps/web/src/lib/command-center-queries.ts` (add `loadActivityPage`)
- Create: `apps/web/src/app/api/activity/route.ts`
- Test: `apps/web/tests/` integration for the loader (mirror an existing lib test)

**Interfaces:**
- Consumes: `listAgentActivity`, `getTenantId`, `verbFor`.
- Produces:
  - `loadActivityPage(opts): Promise<{ rows: FeedRow[]; nextCursor: string | null }>` where `FeedRow = AgentActivityRow & { verb: string; category: string }`.
  - `GET /api/activity?before=&agent=&status=&job=&limit=` → JSON `{ rows, nextCursor }`, tenant-scoped, read-only.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/src/lib/activity-page.test.ts (mirror existing lib test harness/tenant setup)
import { describe, it, expect } from "vitest";
import { loadActivityPage } from "./command-center-queries";

describe("loadActivityPage", () => {
  it("returns feed rows with a plain-words verb + a nextCursor when full", async () => {
    const { rows, nextCursor } = await loadActivityPage({ limit: 5 });
    for (const r of rows) expect(typeof r.verb).toBe("string");
    expect(nextCursor === null || typeof nextCursor === "string").toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter web test activity-page`
Expected: FAIL — `loadActivityPage` not exported.

- [ ] **Step 3: Implement the loader**

Add to `apps/web/src/lib/command-center-queries.ts`:

```ts
import { verbFor } from "@savvy/core";

export interface FeedRow extends ActivityRow { verb: string; category: string }

export async function loadActivityPage(opts: {
  limit?: number; before?: Date; agent?: string; status?: string; jobId?: string;
}): Promise<{ rows: FeedRow[]; nextCursor: string | null }> {
  const limit = opts.limit ?? 30;
  const raw = await listAgentActivity(await getTenantId(), { ...opts, limit });
  const rows = raw.map((r) => ({ ...r, ...verbFor(r.taskKey) }));
  const nextCursor = raw.length === limit ? raw[raw.length - 1].startedAt.toISOString() : null;
  return { rows, nextCursor };
}
```

- [ ] **Step 4: Implement the route**

```ts
// apps/web/src/app/api/activity/route.ts
import { NextRequest, NextResponse } from "next/server";
import { loadActivityPage } from "@/lib/command-center-queries";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  const beforeRaw = p.get("before");
  const data = await loadActivityPage({
    limit: p.get("limit") ? Number(p.get("limit")) : 30,
    before: beforeRaw ? new Date(beforeRaw) : undefined,
    agent: p.get("agent") ?? undefined,
    status: p.get("status") ?? undefined,
    jobId: p.get("job") ?? undefined,
  });
  return NextResponse.json(data);
}
```

- [ ] **Step 5: Run test + typecheck**

Run: `pnpm --filter web test activity-page && pnpm typecheck`
Expected: PASS + clean.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/command-center-queries.ts apps/web/src/lib/activity-page.test.ts apps/web/src/app/api/activity/route.ts
git commit -m "feat(web): /api/activity poll route + feed loader with verbs"
```

---

## Task 8: /activity page + live feed component

**Files:**
- Create: `apps/web/src/components/activity/ActivityRow.tsx`
- Create: `apps/web/src/components/activity/ActivityFeed.tsx`
- Create: `apps/web/src/app/(app)/activity/page.tsx`
- Test: `apps/web/tests/e2e/activity-feed.spec.ts`

**Interfaces:**
- Consumes: `GET /api/activity`, `FeedRow`, `SHOWCASE.POLL_SECONDS`, `verbFor` (already applied server-side), the existing `AgentAvatar` + `StatusPill` visual pattern from `command-center/page.tsx:36-46,100-118`.
- Produces: read-only `/activity` page with a 15s-polling `ActivityFeed` client component (filters: agent, status, `?job=`; "live" dot; reduced-motion-safe).

- [ ] **Step 1: Write the failing Playwright test**

```ts
// apps/web/tests/e2e/activity-feed.spec.ts
import { test, expect } from "@playwright/test";
// Reuse the repo's authenticated e2e setup (TEST_TENANT_ID + create-tenant harness).

test("activity feed renders rows and filters by outcome", async ({ page }) => {
  await page.goto("/activity");
  await expect(page.getByRole("heading", { name: /activity/i })).toBeVisible();
  await expect(page.getByTestId("activity-row").first()).toBeVisible();
  await page.getByTestId("filter-status-error").click();
  await expect(page).toHaveURL(/status=error/);
});

test("activity feed deep-links a single job via ?job=", async ({ page }) => {
  await page.goto("/activity?job=SEEDED_JOB_ID"); // replace with the harness's seeded job id
  await expect(page.getByTestId("activity-row").first()).toBeVisible();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter web test:e2e activity-feed`
Expected: FAIL — `/activity` 404s.

- [ ] **Step 3: Build the row component**

```tsx
// apps/web/src/components/activity/ActivityRow.tsx
"use client";
import type { FeedRow } from "@/lib/command-center-queries";

function statusColor(s: string) {
  if (s === "error") return "var(--status-error)";
  if (s === "skipped") return "var(--status-skip)";
  if (s === "ok") return "var(--status-ok)";
  return "var(--text-faint)";
}
function ago(d: string | Date) {
  const mins = Math.round((Date.now() - new Date(d).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  return hrs < 24 ? `${hrs}h ago` : `${Math.round(hrs / 24)}d ago`;
}

export function ActivityRow({ r }: { r: FeedRow }) {
  const c = statusColor(r.status);
  return (
    <li data-testid="activity-row" className="flex items-center gap-3 rounded-lg px-2 py-2 text-sm"
        style={{ borderBottom: "1px solid var(--border-panel)" }}>
      <span className="truncate" style={{ color: "var(--text-body)" }}>{r.verb}</span>
      {r.target ? <span className="truncate text-[13px]" style={{ color: "var(--text-muted)" }}>· {r.target}</span> : null}
      <span className="ml-auto flex items-center gap-2">
        <span className="mono rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider"
              style={{ color: c, background: `color-mix(in srgb, ${c} 14%, transparent)`, border: `1px solid color-mix(in srgb, ${c} 35%, transparent)` }}>
          {r.status}
        </span>
        <span className="mono w-16 text-right text-[11px]" style={{ color: "var(--text-faint)" }}>{ago(r.startedAt)}</span>
      </span>
    </li>
  );
}
```

- [ ] **Step 4: Build the polling feed component**

```tsx
// apps/web/src/components/activity/ActivityFeed.tsx
"use client";
import { useEffect, useState, useCallback } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { SHOWCASE } from "@savvy/core";
import type { FeedRow } from "@/lib/command-center-queries";
import { ActivityRow } from "./ActivityRow";

export function ActivityFeed({ initial }: { initial: FeedRow[] }) {
  const [rows, setRows] = useState<FeedRow[]>(initial);
  const [live, setLive] = useState(true);
  const params = useSearchParams();
  const router = useRouter();

  const refresh = useCallback(async () => {
    const qs = new URLSearchParams();
    for (const k of ["agent", "status", "job"]) { const v = params.get(k); if (v) qs.set(k, v); }
    const res = await fetch(`/api/activity?${qs.toString()}`, { cache: "no-store" });
    if (res.ok) { setRows((await res.json()).rows); setLive(true); } else setLive(false);
  }, [params]);

  useEffect(() => {
    const id = setInterval(refresh, SHOWCASE.POLL_SECONDS * 1000);
    return () => clearInterval(id);
  }, [refresh]);
  useEffect(() => { refresh(); }, [refresh]); // re-fetch on filter change

  const setFilter = (k: string, v: string | null) => {
    const qs = new URLSearchParams(params.toString());
    v ? qs.set(k, v) : qs.delete(k);
    router.replace(`/activity?${qs.toString()}`);
  };

  return (
    <div>
      <div className="mb-3 flex items-center gap-2 text-xs">
        <span className="h-2 w-2 rounded-full anim-pulse" style={{ background: live ? "var(--status-ok)" : "var(--text-faint)" }} />
        <span style={{ color: "var(--text-muted)" }}>{live ? "live" : "reconnecting"}</span>
        <button data-testid="filter-status-error" onClick={() => setFilter("status", "error")} className="ml-4 underline">errors only</button>
        <button onClick={() => setFilter("status", null)} className="underline">all</button>
      </div>
      {rows.length === 0
        ? <p className="text-sm" style={{ color: "var(--text-faint)" }}>No activity yet.</p>
        : <ul className="space-y-1">{rows.map((r) => <ActivityRow key={r.id} r={r} />)}</ul>}
    </div>
  );
}
```

(The `anim-pulse` "live" dot is already gated by `prefers-reduced-motion` in `globals.css` — reduced-motion users see a static dot, same meaning.)

- [ ] **Step 5: Build the page shell**

```tsx
// apps/web/src/app/(app)/activity/page.tsx
import { loadActivityPage } from "@/lib/command-center-queries";
import { ActivityFeed } from "@/components/activity/ActivityFeed";

export const dynamic = "force-dynamic";

export default async function ActivityPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const sp = await searchParams;
  const { rows } = await loadActivityPage({ agent: sp.agent, status: sp.status, jobId: sp.job });
  return (
    <div className="space-y-6">
      <div>
        <div className="eyebrow">Telemetry</div>
        <h1 className="text-2xl font-semibold tracking-tight">Activity</h1>
        <p className="text-sm" style={{ color: "var(--text-muted)" }}>Everything your agents and team are doing — live.</p>
      </div>
      <ActivityFeed initial={rows} />
    </div>
  );
}
```

- [ ] **Step 6: Run e2e + typecheck**

Run: `pnpm typecheck && pnpm --filter web test:e2e activity-feed`
Expected: clean + PASS (feed renders, error filter sets `?status=error`).

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/activity/ apps/web/src/app/\(app\)/activity/ apps/web/tests/e2e/activity-feed.spec.ts
git commit -m "feat(web): read-only /activity live feed (15s poll, filters, reduced-motion-safe)"
```

---

## Task 9: Wire the two entry points

**Files:**
- Modify: `apps/web/src/app/(app)/today/page.tsx:191`
- Modify: `apps/web/src/app/(app)/agents/page.tsx:31-34`
- Test: extend `apps/web/tests/e2e/activity-feed.spec.ts`

**Interfaces:**
- Consumes: the `/activity` route from Task 8.
- Produces: a "view live feed →" link in the "While you were out" panel header + a "Live activity" link on the Agents page. Nav count unchanged.

- [ ] **Step 1: Write the failing test**

```ts
// add to apps/web/tests/e2e/activity-feed.spec.ts
test("Today's 'While you were out' panel links to the live feed", async ({ page }) => {
  await page.goto("/today");
  await page.getByRole("link", { name: /view live feed/i }).click();
  await expect(page).toHaveURL(/\/activity/);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter web test:e2e activity-feed`
Expected: FAIL — no such link.

- [ ] **Step 3: Add the Today link**

In `today/page.tsx:191`, change the eyebrow line to include a link (keep the existing count text):

```tsx
<div className="eyebrow mb-2 flex items-center justify-between">
  <span>While you were out · last 24h · {digest.totalActions} agent action{digest.totalActions === 1 ? "" : "s"}</span>
  <a href="/activity" className="underline" style={{ color: "var(--accent-deep)" }}>view live feed →</a>
</div>
```

- [ ] **Step 4: Add the Agents link**

In `agents/page.tsx:31-34`, beside the existing "Telemetry (Command Center) ↗" link, add:

```tsx
<a href="/activity" className="underline" style={{ color: "var(--accent-deep)" }}>Live activity ↗</a>
```

- [ ] **Step 5: Run e2e + typecheck**

Run: `pnpm typecheck && pnpm --filter web test:e2e activity-feed`
Expected: clean + PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/app/\(app\)/today/page.tsx apps/web/src/app/\(app\)/agents/page.tsx apps/web/tests/e2e/activity-feed.spec.ts
git commit -m "feat(web): link Today + Agents pages to /activity (nav stays 5)"
```

---

## Task 10: activity.attribution invariant + writer backfill

**Files:**
- Modify: `packages/core/src/verification/checks.ts`
- Test: `packages/core/src/verification/checks.test.ts`
- Modify: any agent function writing runs with derivable-but-missing `jobId`/`leadId` (backfill)

**Interfaces:**
- Consumes: the `invariant()` builder (`packages/core/src/verification/builders.ts:37`).
- Produces: `evidenceChecks["activity.attribution"]` — window-scoped invariant flagging `agent_run` rows with null `jobId` AND null `leadId` whose `taskKey` is not in the allowlist of legitimately tenant-level actions (sweeps/digests).

**Note on binding:** per `master-task-list.ts:37-45`, cross-cutting data-quality guards (e.g. `comms.no_double_send`, `job.stage_evidence`) are authored in `evidenceChecks` but intentionally left OUT of `CHECK_BINDINGS` until the sweep grows a task-agnostic global-guard runner. `activity.attribution` follows that precedent: **define + test it directly here, do not add it to `CHECK_BINDINGS`** (that would break `master-task-list.test`'s bound-set assertion and mis-attribute proof to one task). Wiring it into the periodic sweep is a follow-up tracked with the other unbound guards.

- [ ] **Step 1: Write the failing test**

```ts
// add to packages/core/src/verification/checks.test.ts (mirror the file's existing db-mock ctx helper)
import { evidenceChecks } from "./checks";

it("activity.attribution fails on an unattributed, non-allowlisted run", async () => {
  const ctx = mockCtx({
    // mock db returns one violation row for the attribution query
    rows: [{ id: "run-1" }],
  });
  const res = await evidenceChecks["activity.attribution"](ctx);
  expect(res.status).toBe("fail");
  expect(res.refs[0]).toEqual({ type: "agent_run", ref: "run-1" });
});

it("activity.attribution passes when the query returns no violations", async () => {
  const ctx = mockCtx({ rows: [] });
  const res = await evidenceChecks["activity.attribution"](ctx);
  expect(res.status).toBe("pass");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @savvy/core test checks`
Expected: FAIL — `evidenceChecks["activity.attribution"]` is undefined.

- [ ] **Step 3: Add the invariant**

In `checks.ts`, add to the `evidenceChecks` record (import `invariant` is already in scope in that file):

```ts
"activity.attribution": invariant(
  "activity.attribution",
  `select id from agent_run
     where tenant_id = $1 and started_at >= $2 and started_at < $3
       and job_id is null and lead_id is null
       and task_key not in (
         'ops.digest','lead.calibration','enrichment.sweep','usage.meter',
         'health.sweep','cold.archive','run.reaper'
       )`,
  {
    params: (ctx) => [ctx.tenantId, ctx.window.start, ctx.window.end],
    toRef: (r) => ({ type: "agent_run", ref: String(r.id) }),
  },
),
```

(The allowlist names the legitimately tenant-level task keys — sweeps, digests, meters, the reaper — that have no single customer. Extend it, never widen the `is null` predicate, when a new tenant-level action appears.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @savvy/core test checks`
Expected: PASS.

- [ ] **Step 5: Backfill attributable writers**

Run `grep -rn "recordAgentRun\|beginAgentRun" packages/agents/src` and, for each call site that has a `lead`/`job` in scope but passes neither `jobId` nor `leadId`, add the linkage. (Do NOT touch genuinely tenant-level writers — the ones in the allowlist above.) Commit these as the backfill; each is a one-line addition of `leadId`/`jobId` to an existing call.

- [ ] **Step 6: Typecheck + test + commit**

Run: `pnpm typecheck && pnpm --filter @savvy/core test checks`
Expected: clean + PASS.

```bash
git add packages/core/src/verification/checks.ts packages/core/src/verification/checks.test.ts packages/agents/src/functions/
git commit -m "feat(core): activity.attribution invariant + backfill run linkage"
```

---

## Task 11: Full verification pass + PR

- [ ] **Step 1: Run the whole suite**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: all clean/green. If `canvass-conversion.test.ts` or `canvass-contract-to-job.spec.ts` flake (shared-CI-DB `task_registry` FK race — known, not this work), re-run.

- [ ] **Step 2: Verify live on Bloom** (the design's proof requirement)

- Deploy a preview (or run locally against a Bloom-like tenant), open `/activity`, confirm: real rows with customer names + plain-words verbs; the "live" dot; `?status=error` filter; a `?job=<real job>` deep link shows only that job's rows; the "view live feed →" link from Today works.
- Confirm the reaper: seed a `running` row with an old `startedAt`, wait for (or manually trigger) the cron, confirm it flips to `error/timed_out`.

- [ ] **Step 3: Open the PR**

```bash
git push -u origin worktree-activity-feed-foundation
gh pr create --base main --title "feat: Activity Feed foundation (Slice 0 of Show the Machine Working)" \
  --body "Two-phase agent_run lifecycle + reaper, /activity live feed (15s poll, filters, attribution), verb map, indexes. Migration: agent_run indexes (state the number). Live-on-Bloom verification: <paste what you saw>."
```

State in the PR: the migration number, the live-on-Bloom observations, and that `activity.attribution` is authored + tested but intentionally unbound (cross-cutting-guard precedent).

---

## Self-Review

**Spec coverage (spec §5 Slice 0):**
- Two-phase lifecycle → Task 3 ✓ · Reaper → Task 5 ✓ · Verb map → Task 2 ✓ · `/activity` route + poll + filters → Tasks 6–8 ✓ · Entry points (nav stays 5) → Task 9 ✓ · `activity.attribution` + backfill → Task 10 ✓ · Index migration → Task 4 ✓ · Config module → Task 1 ✓ · Live-on-Bloom proof → Task 11 ✓.
- Deferred to S1 by design: converting all agent write paths to two-phase (WORKING-NOW surfaces in-flight on cards). Noted in plan header.

**Placeholder scan:** No TBD/TODO; every code step has complete code. The Playwright `SEEDED_JOB_ID` is explicitly flagged to swap for the harness's seeded id (Task 8 Step 1) — an instruction, not a hidden gap.

**Type consistency:** `AgentActivityRow` gains `finishedAt: Date | null` (Task 6) and is extended to `FeedRow` (Task 7) used by `ActivityRow`/`ActivityFeed`/page (Task 8) ✓. `listAgentActivity` signature change `(tenantId, limit)` → `(tenantId, opts)` has its callers updated in the same task (Task 6 Step 4) ✓. `beginAgentRun`/`completeAgentRun`/`recordAgentRun` signatures consistent across Tasks 3, 5, 7 ✓.
