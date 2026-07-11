# S1 WORKING-NOW Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show REAL in-flight agent runs as typing dots on job/lead cards — powered by opening an `agent_run` at the *start* of slow, entity-attributed agent work and resolving it to done+evidence on completion. Nothing animates that isn't a real, currently-open run.

**Architecture:** A `withAgentRun(meta, work)` helper (built on Slice 0's `beginAgentRun`/`completeAgentRun`) instruments the slow hero paths (parse-lead-document, estimate-generate, enrichment) so a `running` row exists while the work runs. A `listRunningRuns` query + `/api/inflight` poll route expose those rows; a global `InflightProvider` (client, 15s poll) maps them by entity, and a `CardInflight` leaf paints dots onto any card carrying `data-job-id`/`data-lead-id`. The Slice-0 reaper + a 90s UI cap guarantee no stuck spinners.

**Tech Stack:** Drizzle/Postgres (RLS via `withTenant`), Inngest agent functions, Next.js App Router (client context + poll), `@savvy/core` (pure shaping + verbs), Vitest, Playwright.

## Global Constraints

- **Honesty:** dots appear ONLY when a real `agent_run` row is `status='running'` for that entity AND `startedAt` is within `SHOWCASE.SPINNER_MAX_SECONDS` (=90). Past that → no dots, show last-completed state. (spec §4)
- **Tenant isolation:** every query via `withTenant`/RLS. The `/api/inflight` route is tenant-scoped through `getTenantId()`. (CLAUDE.md #1)
- **Reduced motion:** dots use `.anim-*` classes inside `@media (prefers-reduced-motion: no-preference)` (globals.css) — reduced-motion users see static dots, same meaning. (spec §4)
- **`skipped` ≠ failure**, and never flash a spinner for a run that was never really working: for skip-with-reason paths, `withAgentRun` wraps only the work AFTER the guard/skip decision.
- **No stuck spinners:** rely on Slice 0's `markStaleRunsTimedOut` reaper (10 min) + the 90s UI cap.
- **Config in one place:** reuse `SHOWCASE` (`packages/core/src/showcase-config.ts`) — `POLL_SECONDS` 15, `SPINNER_MAX_SECONDS` 90. No new literals.
- **Poll cadence** = `SHOWCASE.POLL_SECONDS`. Tests + typecheck + lint clean per commit.
- **apps/web is Playwright-only (no vitest)** — put any testable pure logic in a package (`shapeInflight` lives in `@savvy/core`). (`vitest.workspace.ts` = `["packages/*"]`)

---

## File Structure

- `packages/db/src/lifecycle/agent-run.ts` — **Modify.** Add `withAgentRun` + `listRunningRuns` (+ `RunningRunRow` type).
- `packages/db/src/index.ts` — **Modify.** Export the two new symbols.
- `packages/core/src/inflight.ts` — **Create.** Pure `shapeInflight(rows, now, maxSeconds)` → `{ jobs, leads }`.
- `packages/core/src/index.ts` — **Modify.** Export it.
- `packages/agents/src/functions/parse-lead-document.ts` — **Modify.** Wrap the parse in `withAgentRun`.
- `packages/agents/src/functions/estimate-generate.ts` — **Modify.** Wrap the post-gate generate/upsell in `withAgentRun`.
- `packages/agents/src/enrichment.ts` — **Modify.** Wrap geocode + property enrichment.
- `apps/web/src/lib/inflight-queries.ts` — **Create.** `loadInflight()` (tenant-scoped, shaped).
- `apps/web/src/app/api/inflight/route.ts` — **Create.** GET JSON poll route.
- `apps/web/src/components/inflight/{TypingDots.tsx,InflightProvider.tsx,CardInflight.tsx}` — **Create.** Presentational dots + client context/poll + per-entity leaf.
- `apps/web/src/app/globals.css` — **Modify.** Add a `running` status color + (if needed) a dots keyframe inside the reduced-motion block.
- `apps/web/src/app/(app)/layout.tsx` — **Modify.** Mount `<InflightProvider>` once (global poll).
- `apps/web/src/app/(app)/jobs/board.tsx`, `leads/page.tsx`, `pipeline/PipelineBoard.tsx`, `jobs/[id]/page.tsx`, `leads/[id]/page.tsx` — **Modify.** Add `<CardInflight>` in the avatar/header slot (+ `data-id` on pipeline cards).
- `apps/web/tests/e2e/inflight-dots.spec.ts` — **Create.** Playwright.

---

## Task 1: `withAgentRun` helper

**Files:**
- Modify: `packages/db/src/lifecycle/agent-run.ts`
- Modify: `packages/db/src/index.ts`
- Test: `packages/db/src/lifecycle/agent-run.test.ts`

**Interfaces:**
- Consumes: existing `beginAgentRun`, `completeAgentRun`, `AgentRunStatus`, `Agent`.
- Produces: `withAgentRun<T>(meta, work, opts?): Promise<T>` where
  `meta: { tenantId; agent: Agent; taskKey: string; jobId?: string|null; leadId?: string|null; modelUsed?: string|null }`,
  `work: () => Promise<T>`,
  `opts?: { resolve?: (result: T) => { status: Exclude<AgentRunStatus,"running">; error?: string|null; modelUsed?: string|null } }`.
  Opens a `running` run, runs `work`; on success completes with `opts.resolve(result)` (default `{status:"ok"}`); on throw completes `{status:"error", error: message}` and rethrows. Returns `work`'s result.

- [ ] **Step 1: Write the failing tests**

```ts
// add to packages/db/src/lifecycle/agent-run.test.ts
import { withAgentRun } from "./agent-run";

it("withAgentRun opens a running row during work and completes ok", async () => {
  let sawRunning = false;
  const result = await withAgentRun(
    { tenantId, agent: "orchestrator", taskKey: "test.wrap", leadId: null },
    async () => {
      const [row] = await withTenant(tenantId, (tx) =>
        tx.select().from(agentRun).where(eq(agentRun.taskKey, "test.wrap")));
      sawRunning = row?.status === "running" && row?.finishedAt === null;
      return 42;
    },
  );
  expect(result).toBe(42);
  expect(sawRunning).toBe(true);
  const [done] = await withTenant(tenantId, (tx) =>
    tx.select().from(agentRun).where(eq(agentRun.taskKey, "test.wrap")));
  expect(done.status).toBe("ok");
  expect(done.finishedAt).not.toBeNull();
});

it("withAgentRun maps a result to skipped via resolve", async () => {
  await withAgentRun(
    { tenantId, agent: "orchestrator", taskKey: "test.skip" },
    async () => ({ outcome: "skipped" as const }),
    { resolve: (r) => (r.outcome === "skipped" ? { status: "skipped", error: "nothing to do" } : { status: "ok" }) },
  );
  const [row] = await withTenant(tenantId, (tx) =>
    tx.select().from(agentRun).where(eq(agentRun.taskKey, "test.skip")));
  expect(row.status).toBe("skipped");
  expect(row.error).toBe("nothing to do");
});

it("withAgentRun completes error and rethrows on throw", async () => {
  await expect(withAgentRun(
    { tenantId, agent: "orchestrator", taskKey: "test.throw" },
    async () => { throw new Error("boom"); },
  )).rejects.toThrow("boom");
  const [row] = await withTenant(tenantId, (tx) =>
    tx.select().from(agentRun).where(eq(agentRun.taskKey, "test.throw")));
  expect(row.status).toBe("error");
  expect(row.error).toContain("boom");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @savvy/db test agent-run`
Expected: FAIL — `withAgentRun` not exported.

- [ ] **Step 3: Implement**

Append to `packages/db/src/lifecycle/agent-run.ts`:

```ts
/**
 * Runs `work` with a live agent_run: opens a `running` row (visible in-flight),
 * then completes it ok (or a caller-mapped status) on success, or error+rethrow
 * on throw. Wrap ONLY the slow work you want to show as in-flight — for
 * skip-with-reason paths, call this AFTER the guard so you never flash a
 * spinner for a run that wasn't really working.
 */
export async function withAgentRun<T>(
  meta: {
    tenantId: string; agent: Agent; taskKey: string;
    jobId?: string | null; leadId?: string | null; modelUsed?: string | null;
  },
  work: () => Promise<T>,
  opts: {
    resolve?: (result: T) => { status: Exclude<AgentRunStatus, "running">; error?: string | null; modelUsed?: string | null };
  } = {},
): Promise<T> {
  const runId = await beginAgentRun({
    tenantId: meta.tenantId, agent: meta.agent, taskKey: meta.taskKey,
    jobId: meta.jobId ?? null, leadId: meta.leadId ?? null, modelUsed: meta.modelUsed ?? null,
  });
  try {
    const result = await work();
    const r = opts.resolve?.(result) ?? { status: "ok" as const };
    await completeAgentRun({ tenantId: meta.tenantId, runId, status: r.status, error: r.error ?? null, modelUsed: r.modelUsed ?? null });
    return result;
  } catch (e) {
    await completeAgentRun({ tenantId: meta.tenantId, runId, status: "error", error: (e as Error).message });
    throw e;
  }
}
```

Export it from `packages/db/src/index.ts` beside `beginAgentRun`/`completeAgentRun`.

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm --filter @savvy/db test agent-run && pnpm typecheck`
Expected: PASS + clean.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/lifecycle/agent-run.ts packages/db/src/lifecycle/agent-run.test.ts packages/db/src/index.ts
git commit -m "feat(db): withAgentRun helper (open running run around slow work)"
```

---

## Task 2: `listRunningRuns` query

**Files:**
- Modify: `packages/db/src/lifecycle/agent-run.ts`
- Modify: `packages/db/src/index.ts`
- Test: `packages/db/src/lifecycle/agent-run.test.ts`

**Interfaces:**
- Produces: `RunningRunRow = { id: string; agent: string; taskKey: string|null; jobId: string|null; leadId: string|null; startedAt: Date }` and
  `listRunningRuns(tenantId: string): Promise<RunningRunRow[]>` — all `status='running'` rows for the tenant that carry a jobId OR leadId, newest first, RLS-scoped.

- [ ] **Step 1: Write the failing test**

```ts
// add to packages/db/src/lifecycle/agent-run.test.ts
import { listRunningRuns } from "./agent-run";

it("listRunningRuns returns open runs attributed to a job or lead", async () => {
  const leadRun = await beginAgentRun({ tenantId, agent: "orchestrator", taskKey: "test.run.lead", leadId });
  await beginAgentRun({ tenantId, agent: "orchestrator", taskKey: "test.run.none" }); // no entity → excluded
  await recordAgentRun({ tenantId, agent: "orchestrator", taskKey: "test.run.done", leadId, status: "ok" }); // terminal → excluded
  const rows = await listRunningRuns(tenantId);
  const keys = rows.map((r) => r.taskKey);
  expect(keys).toContain("test.run.lead");
  expect(keys).not.toContain("test.run.none");
  expect(keys).not.toContain("test.run.done");
  expect(rows.find((r) => r.id === leadRun)?.leadId).toBe(leadId);
});
```
(Use the file's existing per-test tenant/lead setup for `tenantId`/`leadId`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @savvy/db test agent-run`
Expected: FAIL — `listRunningRuns` not exported.

- [ ] **Step 3: Implement**

Append to `agent-run.ts` (uses `and`, `eq`, `or`, `isNotNull`, `desc` from drizzle — add any missing to the import):

```ts
export interface RunningRunRow {
  id: string; agent: string; taskKey: string | null;
  jobId: string | null; leadId: string | null; startedAt: Date;
}

/** Open (`running`) runs attributed to a job or lead — drives the in-flight dots. */
export async function listRunningRuns(tenantId: string): Promise<RunningRunRow[]> {
  return withTenant(tenantId, (tx) =>
    tx.select({
      id: agentRun.id, agent: agentRun.agent, taskKey: agentRun.taskKey,
      jobId: agentRun.jobId, leadId: agentRun.leadId, startedAt: agentRun.startedAt,
    })
      .from(agentRun)
      .where(and(
        eq(agentRun.status, "running"),
        or(isNotNull(agentRun.jobId), isNotNull(agentRun.leadId)),
      ))
      .orderBy(desc(agentRun.startedAt)),
  );
}
```

Export `listRunningRuns` + `RunningRunRow` from `packages/db/src/index.ts`.

- [ ] **Step 4: Run test + typecheck**

Run: `pnpm --filter @savvy/db test agent-run && pnpm typecheck`
Expected: PASS + clean.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/lifecycle/agent-run.ts packages/db/src/lifecycle/agent-run.test.ts packages/db/src/index.ts
git commit -m "feat(db): listRunningRuns — open runs attributed to a job/lead"
```

---

## Task 3: `shapeInflight` + `/api/inflight`

**Files:**
- Create: `packages/core/src/inflight.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/inflight.test.ts`
- Create: `apps/web/src/lib/inflight-queries.ts`
- Create: `apps/web/src/app/api/inflight/route.ts`

**Interfaces:**
- Consumes: `RunningRunRow` (shape only), `verbFor` (`@savvy/core`), `SHOWCASE.SPINNER_MAX_SECONDS`.
- Produces:
  - `shapeInflight(rows: {agent; taskKey; jobId; leadId; startedAt}[], now: Date, maxSeconds: number): { jobs: Record<string, InflightEntry>; leads: Record<string, InflightEntry> }` where `InflightEntry = { agent: string; verb: string; startedAt: string }`. Filters out rows older than `maxSeconds`; keeps the NEWEST run per entity.
  - `loadInflight(): Promise<InflightMap>` (apps/web, tenant-scoped).
  - `GET /api/inflight` → JSON `{ jobs, leads }`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/inflight.test.ts
import { describe, it, expect } from "vitest";
import { shapeInflight } from "./inflight";

const now = new Date("2026-07-11T12:00:00Z");
describe("shapeInflight", () => {
  it("keys fresh running runs by job and lead with a verb", () => {
    const out = shapeInflight([
      { agent: "orchestrator", taskKey: "estimate.generate", jobId: "j1", leadId: null, startedAt: new Date(now.getTime() - 5000) },
      { agent: "orchestrator", taskKey: "lead.doc_parse", jobId: null, leadId: "l1", startedAt: new Date(now.getTime() - 2000) },
    ], now, 90);
    expect(out.jobs["j1"].verb.length).toBeGreaterThan(0);
    expect(out.leads["l1"].verb.length).toBeGreaterThan(0);
  });
  it("drops runs older than maxSeconds (no stuck spinner)", () => {
    const out = shapeInflight([
      { agent: "orchestrator", taskKey: "x", jobId: "j1", leadId: null, startedAt: new Date(now.getTime() - 120_000) },
    ], now, 90);
    expect(out.jobs["j1"]).toBeUndefined();
  });
  it("keeps the newest run per entity", () => {
    const out = shapeInflight([
      { agent: "a", taskKey: "old", jobId: "j1", leadId: null, startedAt: new Date(now.getTime() - 8000) },
      { agent: "a", taskKey: "new", jobId: "j1", leadId: null, startedAt: new Date(now.getTime() - 1000) },
    ], now, 90);
    // "new" verb wins
    expect(out.jobs["j1"].startedAt).toBe(new Date(now.getTime() - 1000).toISOString());
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @savvy/core test inflight`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `shapeInflight`**

```ts
// packages/core/src/inflight.ts
import { verbFor } from "./agent-verbs";

export interface InflightEntry { agent: string; verb: string; startedAt: string }
export interface InflightMap { jobs: Record<string, InflightEntry>; leads: Record<string, InflightEntry> }

export function shapeInflight(
  rows: { agent: string; taskKey: string | null; jobId: string | null; leadId: string | null; startedAt: Date }[],
  now: Date,
  maxSeconds: number,
): InflightMap {
  const jobs: Record<string, InflightEntry> = {};
  const leads: Record<string, InflightEntry> = {};
  for (const r of rows) {
    if ((now.getTime() - r.startedAt.getTime()) / 1000 > maxSeconds) continue; // stale → no dot
    const entry: InflightEntry = { agent: r.agent, verb: verbFor(r.taskKey).verb, startedAt: r.startedAt.toISOString() };
    const bucket = r.jobId ? jobs : leads;
    const key = r.jobId ?? r.leadId!;
    const prev = bucket[key];
    if (!prev || entry.startedAt > prev.startedAt) bucket[key] = entry; // newest wins
  }
  return { jobs, leads };
}
```

Export from `packages/core/src/index.ts`.

- [ ] **Step 4: Implement the loader + route**

```ts
// apps/web/src/lib/inflight-queries.ts
import "server-only";
import { listRunningRuns } from "@savvy/db";
import { shapeInflight, SHOWCASE, type InflightMap } from "@savvy/core";
import { getTenantId } from "./tenant";

export async function loadInflight(): Promise<InflightMap> {
  const rows = await listRunningRuns(await getTenantId());
  return shapeInflight(rows, new Date(), SHOWCASE.SPINNER_MAX_SECONDS);
}
```

```ts
// apps/web/src/app/api/inflight/route.ts
import { NextResponse } from "next/server";
import { loadInflight } from "@/lib/inflight-queries";
export const dynamic = "force-dynamic";
export async function GET() {
  return NextResponse.json(await loadInflight());
}
```

- [ ] **Step 5: Run core test + typecheck**

Run: `pnpm --filter @savvy/core test inflight && pnpm typecheck`
Expected: PASS + clean.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/inflight.ts packages/core/src/inflight.test.ts packages/core/src/index.ts apps/web/src/lib/inflight-queries.ts apps/web/src/app/api/inflight/route.ts
git commit -m "feat: shapeInflight + /api/inflight poll endpoint"
```

---

## Task 4: Instrument parse-lead-document (hero path)

**Files:**
- Modify: `packages/agents/src/functions/parse-lead-document.ts`
- Test: `packages/agents/src/functions/parse-lead-document.test.ts`

**Interfaces:**
- Consumes: `withAgentRun`. The handler `parseLeadDocumentHandler` (~L47-112) returns an outcome `"parsed" | "unparsed_low_confidence" | "parse_failed" | "skipped"` and is fail-soft (never throws); `leadId`/`propertyId` become known right after `loadDoc` (~L53).

- [ ] **Step 1: Write the failing test**

```ts
// add to parse-lead-document.test.ts (mirror the file's existing deps-injection harness)
it("opens a running agent_run attributed to the lead during parse, resolves ok", async () => {
  let statusDuringWork: string | undefined;
  const deps = makeDeps({ // reuse the file's deps builder
    ai: { completeObject: async () => { 
      const [row] = await withTenant(tenantId, (tx) => tx.select().from(agentRun).where(eq(agentRun.taskKey, "lead.doc_parse")));
      statusDuringWork = row?.status; // should be "running" mid-parse
      return measurementResult; } },
  });
  await parseLeadDocumentHandler({ tenantId, documentId }, deps);
  expect(statusDuringWork).toBe("running");
  const [done] = await withTenant(tenantId, (tx) => tx.select().from(agentRun).where(eq(agentRun.taskKey, "lead.doc_parse")));
  expect(["ok","skipped","error"]).toContain(done.status);
  expect(done.leadId).toBe(leadId);
});
```
(If the test file has no DB/agentRun access, add the minimal tenant+lead+document seed mirroring `agent-run.test.ts`. Keep the taskKey `lead.doc_parse` consistent with the verb map.)

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @savvy/agents test parse-lead-document`
Expected: FAIL — no agent_run written yet (function is uninstrumented).

- [ ] **Step 3: Implement**

In `parse-lead-document.ts`, after `loadDoc` resolves `leadId`/`propertyId`, wrap the parse body in `withAgentRun`. Import `withAgentRun` from `@savvy/db`. Map the outcome:

```ts
// inside parseLeadDocumentHandler, after leadId/propertyId known:
return withAgentRun(
  { tenantId, agent: "orchestrator", taskKey: "lead.doc_parse", leadId },
  async () => {
    // ... existing parse work (fetchBytes + ai.completeObject branches) ...
    return outcome; // "parsed" | "unparsed_low_confidence" | "parse_failed" | "skipped"
  },
  { resolve: (o) => o === "parse_failed"
      ? { status: "error", error: "parse failed" }
      : o === "skipped"
        ? { status: "skipped", error: "unrecognized kind" }
        : { status: "ok" } }, // parsed | unparsed_low_confidence → ok
);
```
Preserve all existing behavior/return values; the handler stays fail-soft (the wrapper's error path only triggers if the body itself throws — keep the internal try/catch that produces `parse_failed`).

- [ ] **Step 4: Run test + typecheck**

Run: `pnpm --filter @savvy/agents test parse-lead-document && pnpm typecheck`
Expected: PASS + clean.

- [ ] **Step 5: Commit**

```bash
git add packages/agents/src/functions/parse-lead-document.ts packages/agents/src/functions/parse-lead-document.test.ts
git commit -m "feat(agents): in-flight run around lead-document parse"
```

---

## Task 5: Instrument estimate-generate (hero path)

**Files:**
- Modify: `packages/agents/src/functions/estimate-generate.ts`
- Test: `packages/agents/src/functions/estimate-generate.test.ts`

**Interfaces:**
- Consumes: `withAgentRun`. `jobId`/`leadId` are destructured from `event.data` at the top of each branch; slow work = `attachUpsells`/`generateUpsells` (AI) + `createEstimateFromMeasurement`. Several branches early-`return { skipped }` BEFORE the slow work.

- [ ] **Step 1: Write the failing test**

```ts
// add to estimate-generate.test.ts (mirror existing harness)
it("opens a running run attributed to the job while drafting the estimate, resolves ok", async () => {
  let statusDuringWork: string | undefined;
  // inject a slow createEstimate/upsell dep that peeks the row mid-work (status must be "running")
  await runGenerateForReadyMeasurement({ tenantId, jobId, leadId, measurementId }, depsThatPeek((s) => statusDuringWork = s));
  expect(statusDuringWork).toBe("running");
  const [row] = await withTenant(tenantId, (tx) => tx.select().from(agentRun).where(eq(agentRun.taskKey, "estimate.generate")));
  expect(row.status).toBe("ok");
  expect(row.jobId).toBe(jobId);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @savvy/agents test estimate-generate`
Expected: FAIL — no `estimate.generate` run written.

- [ ] **Step 3: Implement**

In `estimate-generate.ts`, AFTER the gate/skip decisions (i.e. only on the path that actually drafts), wrap the draft+upsell+create work in `withAgentRun({ tenantId, agent: "orchestrator", taskKey: "estimate.generate", jobId, leadId }, async () => { ...existing generate work...; return { skipped: false } }, { resolve: (r) => r.skipped ? { status: "skipped" } : { status: "ok" } })`. Do NOT wrap the early skip returns or the `step.sleep`/gate steps. Keep the taskKey `estimate.generate` (matches verb map).

- [ ] **Step 4: Run test + typecheck**

Run: `pnpm --filter @savvy/agents test estimate-generate && pnpm typecheck`
Expected: PASS + clean.

- [ ] **Step 5: Commit**

```bash
git add packages/agents/src/functions/estimate-generate.ts packages/agents/src/functions/estimate-generate.test.ts
git commit -m "feat(agents): in-flight run around estimate drafting"
```

---

## Task 6: Instrument enrichment (geocode + property)

**Files:**
- Modify: `packages/agents/src/enrichment.ts`
- Test: `packages/agents/src/enrichment.test.ts`

**Interfaces:**
- Consumes: `withAgentRun`. Two paths currently write `recordAgentRun` at the END: the `attribute`/geocode path (~L31, taskKey resolved) and `enrich.property` (~L76). `leadId` is resolved before each.

- [ ] **Step 1: Write the failing test**

```ts
// add to enrichment.test.ts
it("opens a running run attributed to the lead during property enrichment", async () => {
  let statusDuringWork: string | undefined;
  await enrichPropertyForLead({ tenantId, leadId }, depsThatPeek((s) => statusDuringWork = s)); // reuse file's entrypoint/deps
  expect(statusDuringWork).toBe("running");
  const [row] = await withTenant(tenantId, (tx) => tx.select().from(agentRun).where(eq(agentRun.taskKey, "enrich.property")));
  expect(row.status).toBe("ok");
  expect(row.leadId).toBe(leadId);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @savvy/agents test enrichment`
Expected: FAIL (currently records a terminal run at the end, never `running` mid-work).

- [ ] **Step 3: Implement**

Replace the two `recordAgentRun({..., status:"ok"})` terminal calls with `withAgentRun({ tenantId, leadId, agent: "orchestrator", taskKey }, async () => { ...the enrichment network work... })` wrapping the actual geocode/`enrichProperty` call so a `running` row exists during the external fetch. Keep taskKeys `enrich.geocode`/`enrich.property` (add both to the verb map if missing — see verbFor).

- [ ] **Step 4: Run test + typecheck**

Run: `pnpm --filter @savvy/agents test enrichment && pnpm typecheck`
Expected: PASS + clean.

- [ ] **Step 5: Commit**

```bash
git add packages/agents/src/enrichment.ts packages/agents/src/enrichment.test.ts
git commit -m "feat(agents): in-flight run around property enrichment"
```

---

## Task 7: Dots UI infra (component + provider + poll)

**Files:**
- Create: `apps/web/src/components/inflight/TypingDots.tsx`
- Create: `apps/web/src/components/inflight/InflightProvider.tsx`
- Create: `apps/web/src/components/inflight/CardInflight.tsx`
- Modify: `apps/web/src/app/globals.css`

**Interfaces:**
- Consumes: `GET /api/inflight`, `SHOWCASE.POLL_SECONDS`, `InflightMap`.
- Produces:
  - `TypingDots({ verb, agent })` — presentational: agent avatar + 3 pulsing dots + plain-words verb, reduced-motion-safe.
  - `InflightProvider({ children })` — client; polls `/api/inflight` every `POLL_SECONDS`, holds `InflightMap` in context.
  - `CardInflight({ kind: "job"|"lead", id })` — client leaf; reads context, renders `<TypingDots>` if the entity has an in-flight entry, else `null`.

- [ ] **Step 1: Add the running color + dots keyframe**

In `globals.css`: add `--status-running` (e.g. a distinct in-progress tone, reuse `--accent-bright` or a blue). Inside the existing `@media (prefers-reduced-motion: no-preference)` block, add a `ck-dots` keyframe + `.anim-dots` (staggered opacity) — OR reuse `.anim-pulse` on three spans with inline `animation-delay`. Reduced-motion users get static dots.

- [ ] **Step 2: Build TypingDots**

```tsx
// apps/web/src/components/inflight/TypingDots.tsx
"use client";
export function TypingDots({ verb, agent }: { verb: string; agent: string }) {
  return (
    <span data-testid="inflight-dots" className="inline-flex items-center gap-1.5 text-[11px]" style={{ color: "var(--status-running, var(--accent-bright))" }} title={`${agent} · ${verb}`}>
      <span className="inline-flex gap-0.5" aria-hidden>
        {[0, 1, 2].map((i) => (
          <span key={i} className="h-1 w-1 rounded-full anim-pulse" style={{ background: "currentColor", animationDelay: `${i * 200}ms` }} />
        ))}
      </span>
      <span className="truncate">{verb}</span>
    </span>
  );
}
```

- [ ] **Step 3: Build InflightProvider + CardInflight**

```tsx
// apps/web/src/components/inflight/InflightProvider.tsx
"use client";
import { createContext, useContext, useEffect, useState } from "react";
import { SHOWCASE, type InflightMap } from "@savvy/core";
const Ctx = createContext<InflightMap>({ jobs: {}, leads: {} });
export function useInflight(kind: "job" | "lead", id: string) {
  const map = useContext(Ctx);
  return (kind === "job" ? map.jobs : map.leads)[id] ?? null;
}
export function InflightProvider({ children }: { children: React.ReactNode }) {
  const [map, setMap] = useState<InflightMap>({ jobs: {}, leads: {} });
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try { const res = await fetch("/api/inflight", { cache: "no-store" }); if (alive && res.ok) setMap(await res.json()); } catch { /* keep last */ }
    };
    tick();
    const h = setInterval(tick, SHOWCASE.POLL_SECONDS * 1000);
    return () => { alive = false; clearInterval(h); };
  }, []);
  return <Ctx.Provider value={map}>{children}</Ctx.Provider>;
}
```

```tsx
// apps/web/src/components/inflight/CardInflight.tsx
"use client";
import { useInflight } from "./InflightProvider";
import { TypingDots } from "./TypingDots";
export function CardInflight({ kind, id }: { kind: "job" | "lead"; id: string }) {
  const run = useInflight(kind, id);
  return run ? <TypingDots verb={run.verb} agent={run.agent} /> : null;
}
```

- [ ] **Step 4: Typecheck + lint**

Run: `pnpm typecheck && pnpm --filter web lint`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/inflight/ apps/web/src/app/globals.css
git commit -m "feat(web): in-flight dots component + provider + poll"
```

---

## Task 8: Mount provider + place dots on the surfaces

**Files:**
- Modify: `apps/web/src/app/(app)/layout.tsx` (mount `<InflightProvider>`)
- Modify: `apps/web/src/app/(app)/jobs/board.tsx` (JobCard footer)
- Modify: `apps/web/src/app/(app)/leads/page.tsx` (row avatar cell)
- Modify: `apps/web/src/app/(app)/pipeline/PipelineBoard.tsx` (card; add `data-id`)
- Modify: `apps/web/src/app/(app)/jobs/[id]/page.tsx` (header badge row)
- Modify: `apps/web/src/app/(app)/leads/[id]/page.tsx` (header `right` slot)

**Interfaces:** Consumes `InflightProvider`, `CardInflight` from Task 7.

- [ ] **Step 1: Mount the provider**

In `(app)/layout.tsx`, wrap the app content (the children region, near where `SageCore`/topbar live) in `<InflightProvider>...</InflightProvider>` so one poll serves every page.

- [ ] **Step 2: Job board card**

In `jobs/board.tsx` `JobCard`, in the footer AgentAvatar row (~L98-101), add `<CardInflight kind="job" id={card.id} />`. The card already has `data-job-id={card.id}`.

- [ ] **Step 3: Lead list rows**

In `leads/page.tsx`, in each row's AgentAvatar cell (~L99), add `<CardInflight kind="lead" id={l.id} />`. Rows already carry `data-lead-id={l.id}`.

- [ ] **Step 4: Pipeline cards**

In `PipelineBoard.tsx`, add `data-id={c.id}` + `data-kind={c.kind}` to the card, and in the waiting-on line (~L94-98) render `<CardInflight kind={c.kind} id={c.id} />` (it returns null when no in-flight, so the waiting line shows normally otherwise).

- [ ] **Step 5: Detail headers**

Job detail (`jobs/[id]/page.tsx`) header badge row (~L419): add `<CardInflight kind="job" id={id} />`. Lead detail (`leads/[id]/page.tsx`) `PageHeader` `right` slot (~L77-81): add `<CardInflight kind="lead" id={leadId} />` beside the StatusBadge.

- [ ] **Step 6: Typecheck + lint + build**

Run: `pnpm typecheck && pnpm --filter web lint && pnpm --filter web build`
Expected: clean (build catches any client/server boundary issue).

- [ ] **Step 7: Commit**

```bash
git add "apps/web/src/app/(app)/"
git commit -m "feat(web): show in-flight dots on job/lead cards + detail headers"
```

---

## Task 9: Playwright e2e

**Files:**
- Create: `apps/web/tests/e2e/inflight-dots.spec.ts`

**Interfaces:** Consumes `/api/inflight` + the mounted dots. Model on `apps/web/tests/e2e/command-center.spec.ts` (seeds `agent_run` via `adminDb`, reads `/tmp/savvy-e2e-tenant.json`).

- [ ] **Step 1: Write the spec**

```ts
// apps/web/tests/e2e/inflight-dots.spec.ts
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { adminDb, agentRun, job, customer, property } from "@savvy/db";
const { id: tenantId } = JSON.parse(readFileSync("/tmp/savvy-e2e-tenant.json", "utf8")) as { id: string };

test("a running agent_run shows typing dots on the job card, gone when stale", async ({ page }) => {
  // seed a customer+property+job, then an OPEN running run on it
  const [c] = await adminDb.insert(customer).values({ tenantId, name: "Inflight Test HO" }).returning();
  const [p] = await adminDb.insert(property).values({ tenantId, customerId: c.id, address: "1 Inflight Way, Mesa AZ" }).returning();
  const [j] = await adminDb.insert(job).values({ tenantId, customerId: c.id, propertyId: p.id, stage: "estimate" }).returning();
  await adminDb.insert(agentRun).values({ tenantId, agent: "orchestrator", taskKey: "estimate.generate", status: "running", finishedAt: null, jobId: j.id });

  await page.goto("/jobs");
  const card = page.locator(`[data-job-id="${j.id}"]`);
  await expect(card.getByTestId("inflight-dots")).toBeVisible(); // dots appear (poll within 15s)

  // stale it (older than SPINNER_MAX_SECONDS) → dots gone on next poll
  await adminDb.update(agentRun).set({ startedAt: new Date(Date.now() - 120_000) }).where(/* eq(agentRun.jobId, j.id) */);
  await expect(card.getByTestId("inflight-dots")).toBeHidden({ timeout: 20_000 });
});
```
(Fill the update predicate with the seeded run id; adjust seed columns to the real schema — mirror how other e2e specs insert customer/property/job.)

- [ ] **Step 2: Run it**

Run: `pnpm --filter web e2e inflight-dots`
Expected: PASS. If the webServer can't boot in the sandbox, deliver a correct spec + DONE_WITH_CONCERNS (validated on Bloom in Task 10).

- [ ] **Step 3: Commit**

```bash
git add apps/web/tests/e2e/inflight-dots.spec.ts
git commit -m "test(e2e): in-flight dots appear on a running run, clear when stale"
```

---

## Task 10: Full verify + PR

- [ ] **Step 1: Full suite**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: green (the ~8 `task_registry` FK-race file flakes are pre-existing infra, not this branch — re-run if they hit).

- [ ] **Step 2: Live-on-Bloom** (per spec) — deploy/preview, seed a real slow run (trigger a lead-doc parse or estimate draft), watch dots appear on the card and resolve; confirm a >90s run shows no dots.

- [ ] **Step 3: PR**

```bash
git push -u origin worktree-working-now-s1
gh pr create --base main --title "feat: S1 WORKING-NOW — in-flight agent dots on cards" --body "<summary + hero paths instrumented + fast-follow list + live-Bloom verification>"
```

---

## Self-Review

**Spec coverage (spec §5 S1):** in-flight runs surface on cards → Tasks 4-8 ✓; resolve to done+evidence → the run completing + poll clears dots ✓; graceful fallback / no stuck spinners → 90s cap in `shapeInflight` (Task 3) + Slice-0 reaper ✓; Playwright with a seeded slow run → Task 9 ✓. Scope = hero paths + full UI (per owner decision); the remaining slow paths (change-order auto-send, voice-fallback, lead-intake qualify, speed-to-lead alerts) are an explicit fast-follow, noted in the PR.

**Placeholder scan:** e2e seed columns + update predicate are flagged to match the real schema (Task 9) — an instruction, not a gap. No TODO/TBD.

**Type consistency:** `withAgentRun`/`listRunningRuns`/`RunningRunRow` (Tasks 1-2) → `shapeInflight` consumes the row shape → `InflightMap`/`InflightEntry` (Task 3) → `useInflight`/`CardInflight`/`TypingDots` (Tasks 7-8) all align. taskKeys used (`lead.doc_parse`, `estimate.generate`, `enrich.property`/`enrich.geocode`) match the verb map (add geocode if missing).
