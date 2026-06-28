# C Part 2 — Honor `automationLevel` at runtime (estimate-generate vertical slice) — Design

**Date:** 2026-06-27
**Slice:** Jobs build, slice C Part 2 (first vertical slice). Establishes the runtime automation-gate pattern + a "deferred to human" surface, wired into ONE agent capability (estimate generation).

## Problem

Every `job_task` carries an `automationLevel` (`full|partial|manual`, seeded from a static 212-row
template). Slice I's `summarizeJobAutomation` reads it for display, but **no agent honors it at
runtime** — there is no link from any Inngest function's action to a `job_task`, so an agent will
auto-act even on a task a shop wants a human to own. C Part 2 closes that gap.

## Goal

When an agent is about to auto-perform work that corresponds to a `job_task`, it first consults that
task's `automationLevel`. If the task is **not `full`** (i.e. `partial` or `manual`), the agent
**defers to a human** instead of acting. Deferred tasks surface proactively in the `/exceptions`
worklist. This slice proves the pattern end-to-end on **estimate generation** and ships a reusable
primitive other functions can adopt later.

## Decisions (locked with Brett)

- **Target:** estimate generation (`generateEstimateOnMeasurement`, on `measurement/ready`).
- **Owning task:** the seeded template task **`estimating-049`** ("Measurement report review &
  import" → "EagleView/Roofr data parsed into estimate template"; all job types). Its template
  default is `automationLevel: "full"`, so **the gate is dormant by default → zero behavior change
  for existing jobs/tests.** It fires only when a job's `estimating-049` is `partial`/`manual`.
- **Defer behavior:** **skip the auto-action + log `agent_run('skipped')` + surface in `/exceptions`**
  via a new `task_needs_approval` vector (not just once overdue).
- **`partial` vs `manual`:** **only `full` auto-acts; both `partial` and `manual` defer.**

> **[Noted to Brett]** Out of the box this gate is dormant because the template marks
> `estimating-049` as `full`. It changes nothing until a job's task is non-full. *How* a task
> becomes non-full (a per-tenant automation config / UI toggle) is a deliberate follow-up, NOT this
> slice — this slice builds the runtime mechanism that honors a non-full level however it's set, and
> tests it by setting a task non-full directly.

## Approach

A reusable gate + a durable "deferred" marker + one exception vector. Mirrors the existing
"skip + log why" precedents (`drip.ts` opt-out suppression, `dunning.ts` quiet-hours).

### 1. Core — `shouldAutoAct` (pure)

`packages/core/src/task-automation.ts`:
```ts
export function shouldAutoAct(level: string | null | undefined): boolean
// true iff normalized(level) === "full". partial/manual/unknown/null → false.
```
Exported from the core index. Unit-tested.

### 2. DB — durable marker + the gate primitive

- **Migration:** add nullable `job_task.deferred_at timestamptz`. (job_task already has
  `tenantIsolation()` RLS — a column add needs no new policy.) This is the durable signal the
  exception query reads; `agent_run` is transient telemetry and never "resolves", so it can't drive
  a self-clearing exception.
- **`packages/db/src/lifecycle/task-automation.ts`:**
  - `resolveTaskAutomation(tx, jobId, taskKey): Promise<string>` — the `automationLevel` of the
    job's task with that `key`; **defaults to `"full"` when no matching task** (so an unmapped key
    never accidentally blocks an agent).
  - `gateAgentAutomation({ tenantId, jobId, taskKey, agent }): Promise<{ proceed: boolean; level: string }>`:
    - reads the level (own `withTenant` tx). If `shouldAutoAct(level)` → `{ proceed: true }`.
    - else **defer:** set `deferred_at = now()` on the owning task (status not in `done`/`skipped`)
      + `recordAgentRun({ status: "skipped", taskKey, jobId, agent, error: "automation:<level> — deferred to human" })`
      → `{ proceed: false, level }`.
  - Exported from `@savvy/db`. Integration-tested (manual → proceed false + deferred_at set + a
    skipped agent_run; full → proceed true, no deferred_at, no skip log; missing task → full/proceed).

### 3. Agents — wire `estimate-generate`

`packages/agents/src/functions/estimate-generate.ts`: a `const ESTIMATE_TASK_KEY = "estimating-049"`
and a new FIRST step:
```ts
const gate = await step.run("gate", () =>
  gateAgentAutomation({ tenantId, jobId, taskKey: ESTIMATE_TASK_KEY, agent: "claims" }));
if (!gate.proceed) return { skipped: "automation_deferred", level: gate.level };
```
The existing `generate` / `upsell` / `save-upsells` steps are unchanged and only run when
`proceed`. (`agent: "claims"` matches the template task's `ownerAgent`.) The gate's behavior is
covered by the db tests; the existing `generateUpsells` test stays green (the AI helper is untouched).

### 4. Core — `task_needs_approval` exception vector

`packages/core/src/exception-queue.ts`: a fifth-pattern addition (sixth vector overall):
- `ExceptionKind` += `"task_needs_approval"`; `KINDS` += it.
- `TaskNeedsApprovalInput = { taskId; jobId; title; customerName: string | null; deferredAt: Date }`.
- `ExceptionQueueInput` += **required** `taskNeedsApprovals: TaskNeedsApprovalInput[]`.
- loop → severity **medium**, detail `Needs approval: <title>`, href `/jobs/<jobId>`,
  occurredAt `deferredAt`.

### 5. Web — gather deferred tasks + page label

`apps/web/src/lib/exception-queries.ts`: a 6th inline query inside the existing `withTenant` tx —
`job_task` rows where `deferred_at is not null AND status not in ('done','skipped')`, left-join
`job`→`customer` — mapped to `taskNeedsApprovals`. `/exceptions` page `KIND_LABEL` +=
`task_needs_approval: "Needs approval"`.

## Testing

- **Core unit:** `shouldAutoAct` (full→true; partial/manual/null/unknown→false); `task_needs_approval`
  vector (emits a medium item; counts) in `exception-queue.test.ts`.
- **DB integration** (`task-automation.test.ts`): the gate's three branches against a real DB +
  asserts `deferred_at` is set and a `skipped` `agent_run` row is written on defer.
- **Agents:** existing `generateUpsells` test stays green; gate wiring verified by typecheck + review
  (the Inngest wrapper is not unit-tested by convention — its helpers are).
- **e2e** (`automation-defer.spec.ts`): seed a job + a `job_task` with `deferred_at` set, assert the
  `/exceptions` page shows a "Needs approval" row for the stamped customer (scoped to stamped names,
  never `queue.total`).
- **Docs:** document the automation gate + the new exception vector in `docs/jobs-pipeline.md`.

## What's missing / out of scope

- **No per-tenant config / UI to set a task non-full** — separate follow-up. This slice honors a
  non-full level however it's set.
- **Only estimate-generate is wired** — the other ~11 auto-acting functions are unchanged; they
  adopt `gateAgentAutomation` in later slices.
- **No `partial`-specific "act-but-flag" path** — partial defers exactly like manual (Brett's choice).
- **No auto-completion of tasks by agents** — the gate only defers; humans still complete tasks via
  `toggleTask`. (Clearing `deferred_at` on completion is unnecessary — the exception query already
  excludes `done`/`skipped`.)
