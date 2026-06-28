# Jobs I — Job Automation module (cockpit) (design)

**Date:** 2026-06-27
**Slice:** Jobs build-order item **I** (cockpit modules + automationLevel).
Branches off clean `main` (D2a #60 + D2c #61 merged).

## Goal

Add an **Automation** module to the job cockpit that tells the operator, at a
glance, **how autonomous this job is** and **how much still needs them** —
derived from the job's existing `job_task` rows (`ownerAgent`,
`automationLevel`, `status`), broken down by the five agent domains.

## Why now

The product thesis is "AI agents run operations; humans handle exceptions." The
cockpit already *displays* a per-task automation badge and an owner-agent
avatar, but nothing **summarizes** a job's overall autonomy or surfaces the
human-attention load. This module makes the agent-ops story legible on every
job.

## Important scoping fact (drives the read-only decision)

`automationLevel` (`full | partial | manual`) is today **display-only** — it is
seeded per task from the lifecycle templates and rendered, but **no agent gates
its runtime behavior on it**. Therefore an *editable* automation control would
be misleading (toggling "Full Auto" would change nothing). This slice is
**read-only insight**. Making `automationLevel` editable **and honored at
runtime** is the future **C (orchestration + doc gates)** slice — called out as
the explicit follow-up, not built here.

## What it shows

A cockpit **Automation** card with:
- **Autonomy %** — a single weighted figure (`full = 1`, `partial = 0.5`,
  `manual = 0`, ÷ total tasks), with a caption ("N of M tasks set to automate").
- **Needs you** — count of tasks not yet `done` whose level is not `full`
  (manual/partial work still awaiting a human). The exception signal.
- **Per-agent breakdown** — for each of the five agents
  (`orchestrator, comms, scheduling, finance, claims`) that owns ≥1 task: its
  persona avatar + service label + a compact `full / partial / manual` count.

## Surfaces

- **Core (`@savvy/core`):** `summarizeJobAutomation(tasks)` — a pure function
  computing the summary above. Unit-tested. This is where the logic lives
  because `apps/web` is not in the vitest workspace.
- **Web (`apps/web`):** an `AutomationModule` presentational component on the
  job cockpit, fed by the summary computed server-side from the job-task rows
  the page already loads. Reuses the existing `AgentAvatar` / `resolveAgent`
  persona system. Verified by Playwright e2e.

## Design decisions (locked; labels per Brett's response-quality rule)

- **[ASSUMED] Autonomy weighting:** `full = 1.0`, `partial = 0.5`, `manual = 0`,
  `autonomyPct = round(Σweight / total × 100)`; `0` when the job has no tasks.
  (Partial counts half because an agent assists but a human still acts.)
- **[ASSUMED] "Needs you":** `status !== "done" && automationLevel !== "full"`.
  A `full` pending task is the agent's to do; a `done` task needs nobody.
- **[INFERRED] Per-agent order:** iterate the canonical `AGENT` enum order so the
  breakdown is stable; include only agents that own ≥1 task on this job.
- **[INFERRED] No schema change:** the module reads existing `job_task` columns;
  no new table, column, or migration.

## Out of scope (later)

- Editing a task's automation level (needs runtime honoring — **C**).
- Agents actually gating execution on `automationLevel` (**C**).
- Cross-job automation analytics (a Command-Center-level view).

## Non-negotiables touched

- Tenant isolation: reads the job's `job_task` rows through the existing
  tenant-scoped cockpit query; no new query path.
- No hard-coded model strings (no AI here).
