# Evidence-Driven Per-Job Task Ledger — Design Spec

**Date:** 2026-07-09
**Branch:** `worktree-per-job-task-ledger`
**Status:** Approved design, pending implementation plan

## Problem

The job-detail **Tasks tab** shows tasks that don't belong to the job. Observed on prod
job `019f3e4d…`: the ledger lists **tenant-level recurring marketing tasks** (SEO content
publishing #14, Google Business Profile management #12, website form-submission capture #2,
Google/Facebook ad-lead capture #4). A job ledger must contain **only tasks applicable to
that job**.

### Root cause

The repo has **two parallel per-job task systems**:

| | Tasks tab (buggy) | Job Ledger card |
|---|---|---|
| Data | `job_checklist_item` ← `task-lifecycle.json` (`seedJobTasks`) | `job_task` ← `task_registry` (`instantiateJobTasks`) |
| Scope filter | only an `orgLevel` bool + job type — **scope-blind** | `scope='per_job'` + `applies_to` — **correct** |
| Status | checkbox (done only) + "upcoming" default | evidence glyphs, verified/exception, blocked-by |
| Evidence / owner / depends_on | none | all present |

`seedJobTasks` (`packages/db/src/lifecycle/seed-job-tasks.ts`) filters only `!t.orgLevel &&
t.jobTypes.includes(job.type)`. The four marketing tasks are tagged `orgLevel:false,
stage:"lead"` in `task-lifecycle.json`, so they seed onto every job and `recordStageChange`
activates them at the `lead` stage. The registry system (`instantiateJobTasks`, filters
`scope='per_job'`) already excludes them — but its `job_task` ledger is a read-only,
non-sectioned surface, not what the Tasks tab renders.

Separately, the registry **mis-scopes** these same marketing tasks: the seed's `PHASE_SCOPE`
heuristic (`packages/db/seeds/master-task-list.ts`) maps Phase 1 → `per_lead`, so they'd land
as `lead_task` on every lead (and thus in a converted job's lead-history) — also wrong. They
are tenant-recurring and belong on the Coverage Map only.

## Decision: unify on the registry (`job_task`)

The Tasks tab becomes the **evidence-driven registry ledger**. Everything the desired
behavior needs — scope, `applies_to`, `depends_on`, `evidence`, `verified`, `owner`, mode —
is already modeled on `task_registry` + `job_task`. The `job_checklist_item` JSON system is
the legacy surface with the bug and no model.

**Scope boundary for this PR:** `job_checklist_item` is **kept** as the substrate for the
exceptions queue (overdue tasks, needs-approval deferrals) and SLA activation
(`recordStageChange` `due_at`). It is cleaned of the out-of-scope marketing rows but not
retired. **Full retirement of `job_checklist_item`** (porting SLA/overdue/deferral onto
`job_task`) is explicitly **out of scope** — a separate, higher-risk follow-up.

**Per-job mode override is dropped.** Effective mode = `tenant_task_config.mode ??
task_registry.default_mode` (a tenant policy). Today's per-job `AutomationLevelControl`
cycling is removed; mode is displayed read-only. (Per-job override would need a new column;
not wanted.)

## Requirements → design

### A. Scope correction (req 1)

Two coordinated fixes so tenant-recurring tasks never instantiate on a job or lead:

1. **Registry** (`packages/db/seeds/master-task-list.ts`): add a **per-task scope override**
   map re-scoping the audited tenant-recurring tasks (SEO #14, GBP #12, form-capture #2,
   ad-lead #4, plus a Phase 1/10/11/14/15 audit) to `per_tenant_recurring`. Applied via a new
   idempotent seed migration re-running `seedTaskRegistry` (registry is global, upsert on
   `id`). These tasks then instantiate nowhere and surface only on the Coverage Map.
2. **JSON substrate** (`packages/db/src/seed-data/task-lifecycle.json`): mark the same tasks
   `orgLevel: true` so `seedJobTasks` stops seeding them into `job_checklist_item` for new
   jobs.

`instantiateJobTasks` already filters `scope='per_job'` + `jobTaskApplies(applies_to,
jobType)` — no change. `instantiateLeadTasks` filters `scope='per_lead'` — after re-scope,
the marketing tasks drop out.

### B. Ledger surface (reqs 2, 3)

The Tasks tab (`apps/web/src/app/(app)/jobs/[id]/tabs.tsx` + `page.tsx` fetch) stops reading
`job_checklist_item` and renders `job_task` ⨝ `task_registry` (via a `getJobLedger`-style
reader), grouped into **phase sections in execution order** (phase asc, then task id):

- **Effective mode** = `tenant_task_config.mode ?? registry.default_mode`.
- **manual** → **checkbox**. Tick → `status=done, owner=<userId>, completed_at=now` +
  `audit_log` row (user + time). Untick reverts to `pending` (clears owner/completed_at),
  also logged.
- **auto / assisted** → **no checkbox**; render **status glyph** + owning agent
  (avatar + name) + evidence link (`evidence.type:ref`, linked if `evidence.url`).
- **Status is evidence-driven** from `job_task.status`, never an "upcoming" default:
  `pending` → **blocked** (derived: `status='pending' && blocked_by.length>0`; shows
  "blocked by <names>") → `done` (+evidence) → `verified` (granted by the health sweep).
  `exception`/`failed` → ✗; `not_applicable`/`skipped` → dash.
- **Sections**: a phase whose tasks are all terminal (done/verified/not_applicable)
  **collapses** to a summary row *"Phase N · X/Y ✓"* (expandable). The tab opens at the
  **current phase** — derived from `job.stage`→phase, else the first phase with an
  incomplete task.
- `blocked_by` renders dependency **task names** (resolve id→name), not raw `#id`.

### C. Waiting-on (req 3)

Pipeline "waiting on" (`apps/web/src/lib/pipeline-queries.ts` + `PipelineBoard.tsx`,
`deriveWaitingOn` in `packages/core/src/pipeline-board.ts`) switches from earliest-due
`job_checklist_item` to the **first *unblocked* incomplete `job_task`** (status ∉
done/verified/not_applicable/skipped **and** `blocked_by = []`), in execution order. Same
data as the ledger's next actionable row. Owner = task owner (human if effective mode =
manual). Existing missing-stage-evidence and per-column fallbacks are preserved.

### D. Conversion lifecycle + gate (req 5)

`convertLeadToJob` (`packages/db/src/lifecycle/appointments.ts`):

- **Lead history via union, not copy.** The job ledger unions `lead_task` (by `job.lead_id`)
  as **read-only history** — no row duplication. A fully-terminal lead phase collapses to
  *"Lead phase · 12/12 ✓"* (expandable). `lead_task` rows persist → queryable by Sage.
- **Resolution gate** — `convertLeadToJob(..., resolutions?)`. For each still-open `lead_task`
  (status `pending`/`in_progress`):
  - effective mode **auto/assisted** → auto-set `status='not_applicable'`,
    `note="auto: converted via <trigger>"`.
  - effective mode **manual**, unresolved → **throw `ConversionBlockedError`**. Automated
    callers (`estimate-sign`, `canvass-contract` Inngest fns) **catch** it and raise a
    **needs-you exception** (mirrors the evidence-gate skip pattern), leaving the lead
    unconverted until a human resolves the open manual tasks.
  - The manual **"Convert" button** must pass explicit `resolutions` (each open task → `done`
    or `not_applicable`+reason) or conversion is rejected.

### E. `scope_integrity` evidence check (req 4)

New `evidenceChecks["job.scope_integrity"]` (`packages/core/src/verification/checks.ts`), an
**unbound invariant** (like `job.stage_evidence`):

```sql
select jt.id from job_task jt
  join task_registry tr on tr.id = jt.task_id
 where jt.tenant_id = $1 and tr.scope <> 'per_job'
```

Any row = violation (a per-tenant/per-lead-scoped task instantiated on a job). Left unbound
(not in `CHECK_BINDINGS`), consistent with `job.stage_evidence`.

### F. Prod cleanup script (req 1)

`packages/db/src/scripts/cleanup-out-of-scope-tasks.ts` — idempotent, exports
`cleanupOutOfScopeTasks({dryRun})`. Deletes:
- `job_task` rows where `task_registry.scope <> 'per_job'`,
- `lead_task` rows where `task_registry.scope <> 'per_lead'`,
- `job_checklist_item` rows matching the re-scoped tenant-recurring task keys.

Run against prod **from the worktree** using the both-URL preflight pattern (assert
`current_database='postgres'` on **both** `DATABASE_URL` and `DATABASE_ADMIN_URL` — see the
`rederive-job-stages` split-connection lesson). Re-run → 0 rows. Verify by query.

### G. Schema / migration

One small migration:
- `ALTER TABLE lead_task ADD COLUMN note text;` and `ALTER TABLE job_task ADD COLUMN note
  text;` (the `not_applicable` reason / resolution note).
- The registry scope re-seed (data) from §A.1.

### H. Testing (TDD; red-paths from the brief)

- **Unit**: per-task scope override in the seed; effective-mode → checkbox gating;
  `job_task.status` → glyph mapping; waiting-on picks first *unblocked* incomplete task;
  conversion auto-resolves non-manual and blocks on manual.
- **Red-path**: (1) `job.scope_integrity` with a seeded bad `job_task` row (per-tenant task
  on a job) → check returns it. (2) `convertLeadToJob` with an open **manual** lead task and
  no resolution → **rejected** (`ConversionBlockedError`); collapsed lead history remains
  queryable afterward.
- **e2e**: Josh's job (`019f3e4d…`) — Tasks tab shows only job-lifecycle tasks, marketing
  gone, statuses reflect reality; live verification stated in the PR.

## Out of scope

- Full retirement of `job_checklist_item` (SLA/overdue/deferral migration onto `job_task`).
- Per-job mode override.
- Coverage-Map UI changes for the newly `per_tenant_recurring` tasks (they already aggregate
  into `tenant_ops_rollup`; no new surface needed).

## Key files

- Seed / scope: `packages/db/seeds/master-task-list.ts`, `master-task-list.raw.json`,
  `packages/db/src/seed-data/task-lifecycle.json`, `packages/db/src/lifecycle/seed-job-tasks.ts`
- Instantiation / conversion: `packages/db/src/lifecycle/{job-tasks,lead-tasks,appointments}.ts`,
  `record-stage-change.ts`
- Ledger reader / rows: `packages/db/src/lifecycle/task-health.ts` (`getJobLedger`,
  `JobLedgerRow`), `packages/core/src/job-ledger.ts`
- UI: `apps/web/src/app/(app)/jobs/[id]/{tabs,page,JobLedgerCard}.tsx`
- Waiting-on: `apps/web/src/lib/pipeline-queries.ts`,
  `apps/web/src/app/(app)/pipeline/PipelineBoard.tsx`, `packages/core/src/pipeline-board.ts`
- Verification: `packages/core/src/verification/checks.ts`
- Inngest conversion triggers: `packages/agents/src/functions/{estimate-sign,canvass-contract}.ts`
