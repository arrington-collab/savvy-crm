# Phase 2 — Jobs & Pipeline Core: Design Spec

**Date:** 2026-06-09
**Status:** Approved (design); pending implementation plan
**Depends on:** Phase 0 foundation + vertical slice (merged, `main`)

## Goal

Turn Savvy from "the spine works" into a usable pipeline product: a drag-between-stages board, the real **212-task job lifecycle** seeded onto each job and activated as it moves through stages, a per-job detail view, and days-in-stage / velocity analytics — all tenant-scoped via RLS.

## Source of truth: the 212-task lifecycle

`docs/superpowers/specs/task-lifecycle-212.csv` (committed) — "SAVVY — Master Roofing Task Lifecycle." 212 tasks across 15 phases. Columns: `#, Task, Phase, Job Type, Automation Level, What Gets Automated, Trigger, Owner, Savvy Agent, Difficulty (1-10)`.

Distributions: Job Type — All 166 / Insurance 35 / Retail 6 / Commercial 4 / Repair 1. Automation — Full Auto 105 / Partial Auto 102 / Manual 5. Agents — Comms 31 / Orchestrator 25 / Finance 24 / Scheduling 16 / Claims 12 (plus non-agent owners).

### Parsed into templates
During implementation the CSV is parsed (build-time script) into `packages/db/src/seed-data/task-lifecycle.json` — an array of template objects:

```ts
type TaskTemplate = {
  key: string;            // stable id, e.g. "lead-gen-01" (slug of phase + #)
  num: number;            // original # (1-212)
  title: string;          // Task
  phase: string;          // one of the 15 phases (stored on job_task.phase)
  stage: JobStage;        // DERIVED mapping (which of the 9 stages activates it)
  jobTypes: JobType[];    // expanded: "All" -> all 4; else the single type
  automationLevel: "full" | "partial" | "manual";  // Full Auto/Partial Auto/Manual
  ownerAgent: Agent | null;  // Savvy Agent col mapped to enum, or null for non-agent owners
  ownerRole: string;      // Owner col (System, Sales Rep, Foreman, …) for assignment hints
  trigger: string;        // Trigger col (informational in Phase 2)
  difficulty: number;     // 1-10
  whatGetsAutomated: string;
  orgLevel: boolean;      // true for Operations & Compliance + Reporting & Analytics (NOT per-job)
};
```

The parser is committed and deterministic; the generated JSON is committed too (so the seed has no build-time CSV dependency).

## Phase → stage mapping (locked)

The 15 task-phases map to the 9 `job_stage` values. Org-level phases are excluded from per-job seeding.

| Task phase | → `job_stage` | Per-job? |
|---|---|---|
| Lead Generation, Lead Management | `lead` | yes |
| Inspection | `inspected` | yes |
| Estimating | `estimate` | yes |
| Insurance Claim Management, Pre-Production | `approved` | yes |
| Production, Scheduling & Crew Management | `production` | yes |
| Close-Out | `closeout` | yes |
| Billing & Collections | `billing` | yes |
| Reviews & Reputation, Referrals & Retention, Warranty Management | `complete` | yes |
| Operations & Compliance, Reporting & Analytics | — | **no (org-level)** |

`lost` stage activates no new tasks. The mapping table lives in the parser as a `PHASE_TO_STAGE` constant and is unit-tested for exhaustiveness (every one of the 15 phases is mapped or explicitly org-level).

## The job_task engine (decided: seed-all-upfront, auto-activate, manual-complete)

1. **On job creation** (extend the existing `lead.booked` → job conversion, and any future job-create path): seed every non-org-level template whose `jobTypes` includes the job's type, as `job_task` rows with `status = "pending"`, `due_at = null`, `assignee_user_id = null`. The full lifecycle is visible as upcoming work.
2. **On stage entry**: an Inngest workflow **`job/stage-changed`** activates that stage's tasks — for each `job_task` whose template `stage` equals the new stage and is still `pending`: set `due_at` (a simple per-stage SLA offset, e.g. +3 days), keep `status = "pending"` (now "active" = due_at set), and record one `agent_run` (agent = `orchestrator`) summarizing activation. Auto-level tasks render with a "will be automated" badge but **never auto-complete** — completion is always a human action in Phase 2.
3. **Completion** is manual: a server action toggles `job_task.status` between `pending`/`in_progress`/`done`/`skipped`/`blocked`, sets `completed_at`, writes `audit_log`.

"Active" is a derived UI concept: a task is *active* when `due_at IS NOT NULL` (its stage has been reached) and not `done/skipped`; *upcoming* when `due_at IS NULL`.

Idempotency: `job/stage-changed` is keyed on `(jobId, toStage)`; re-firing does not duplicate activations (it only touches still-`pending`, un-activated tasks for that stage).

## Data model additions

### New table `job_stage_event` (velocity / days-in-stage)
```
id, tenant_id, job_id -> job, from_stage (job_stage | null), to_stage (job_stage),
entered_at timestamptz, by_user_id?, by_agent?(agent), note?
```
RLS `tenant_isolation` policy `TO savvy_app` (same pattern as all tenant tables). Index `(tenant_id, job_id, entered_at)`. Written on every stage change. `from_stage = null` for the initial event at job creation.

- **Days-in-stage (current)** = `now() - job.stage_entered_at`.
- **Velocity (historical)** = per-stage avg of `(next event.entered_at - this event.entered_at)` across a tenant's jobs.

### `job_task` — no schema change
Existing columns suffice (`key, title, phase, owner_agent, automation_level, status, due_at, completed_at, assignee_user_id, payload`). Template extras (difficulty, trigger, ownerRole, whatGetsAutomated, num, stage) go in `payload` jsonb.

## Pipeline board — `/jobs`

- Server component loads tenant-scoped jobs grouped by `stage` (9 columns: lead → inspected → estimate → approved → production → closeout → billing → complete; `lost` shown as a collapsed/secondary column).
- Each card: customer name, property address, value estimate, days-in-stage, assignee.
- **Drag between columns** (client island; a lightweight DnD — `@dnd-kit/core`): optimistic move, then a **server action** persists the change in one `withTenant` transaction: update `job.stage` + `job.stage_entered_at = now()`, insert `job_stage_event`, write `audit_log`; then emit `job/stage-changed`. On server error, the optimistic move reverts (toast).
- Empty stages render as drop targets.

## Job detail — `/jobs/[id]`

Server component; tenant-scoped; `dynamic = "force-dynamic"`.
- **Header card:** customer, property, type, current stage, value, days-in-stage, assignee.
- **Tabs:**
  - **Tasks** — `job_task` grouped by phase, ordered by `num`; each row: checkbox (manual complete), title, automation badge (`Full Auto` "will be automated" / `Manual`), owner agent/role, due date if active. Toggling completion calls the server action.
  - **Timeline** — merged, time-ordered feed of `job_stage_event` (stage moves), `communication` (calls/sms/email), and `audit_log` (task completions). Read-only.
  - **Comms** — `communication` rows for the job.
  - **Docs** — `document` rows for the job; empty-state + a disabled "upload coming in Phase 6" stub (documents are populated in a later phase).

## Analytics

A `/jobs` header strip (and reuse on the dashboard): jobs per active stage (live counts), avg days-in-stage per stage (from `job_stage_event`), and a "stuck jobs" flag (current stage age > a per-stage threshold). Tenant-scoped queries in `apps/web/src/lib/pipeline-queries.ts` (extends the existing `dashboard-queries.ts` patterns).

## Components & boundaries

- `packages/db`: new `job_stage_event` schema + migration + RLS; a `seedJobTasks(tx, job)` helper (seed-all-upfront); a `recordStageChange(...)` helper (update stage + event + audit) usable by both the server action and the workflow. Query helpers stay thin.
- `packages/agents`: `job/stage-changed` event + `jobStageChanged` workflow (activation logic, idempotent). The `lead.booked` workflow calls `seedJobTasks` at job creation and emits the initial `job/stage-changed`.
- `packages/db/seed-data`: parser script + generated `task-lifecycle.json` + the `PHASE_TO_STAGE` map.
- `apps/web`: `/jobs` board (server + DnD client island + move server action), `/jobs/[id]` detail (tabs), `pipeline-queries.ts`, task-toggle server action.

All conventions from Phase 0 hold: imports via `@savvy/db`/`@savvy/core` roots (single instance), no `.js` extensions, `withTenant` for every app DB access, RLS on the new table, server actions are `"use server"` + `runtime = "nodejs"`.

## Testing

- **RLS:** extend the isolation test to `job_stage_event` (and confirm `job_task` already covered) — select/update/delete/insert.
- **Unit:** the CSV→template parser (counts: 212 parsed, org-level flagged, every phase mapped); `PHASE_TO_STAGE` exhaustiveness; the stage-change activation logic (right tasks activated, idempotent re-fire); days-in-stage / velocity math.
- **Seed integrity:** a test asserting a seeded retail job gets exactly the retail+All non-org tasks, an insurance job gets insurance+All, etc.
- **e2e (Playwright):** create a job → it shows on the board at `lead` with upcoming tasks → drag it to `inspected` → inspection-phase tasks activate (due dates appear) → job detail Tasks tab reflects it → days-in-stage analytics update. Mock externals; reuse the Phase 0 e2e harness (ai-stub, inngest dev, TEST_MODE).

## Out of scope (deferred)

- Real automation execution of Auto tasks (later phases wire actual agents).
- Document upload (Phase 6).
- Org-level task tracking (Operations & Compliance, Reporting phases) — not per-job.
- Cross-stage drag validation / guardrails (any-to-any moves allowed in Phase 2).
- Per-tenant SLA configuration (uses fixed per-stage offsets in Phase 2).

## Open assumptions

- The `PHASE_TO_STAGE` mapping is the author's interpretation; reviewed/approved in design. If a roofing SME later disagrees on a phase's stage, it's a data change in one constant + re-seed, not a schema change.
- Per-stage due-date offsets and "stuck" thresholds are hardcoded sensible defaults in Phase 2 (config comes later).
