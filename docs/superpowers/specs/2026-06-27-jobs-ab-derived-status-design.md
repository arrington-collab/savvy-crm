# Jobs A+B — Job creation carryover + derived status (design)

**Date:** 2026-06-27
**Domain:** Jobs (piece 1 of the Jobs master build order: "A + B — job creation + derived status").
**Scope:** This is the **spine** slice. It improves the existing Jobs implementation; it does not replace it.

---

## 1. Context (what already exists)

The Jobs spine is ~80% built. Verified in the codebase:

- **`job` table** (`packages/db/src/schema/jobs.ts`): `stage` (enum), `stageEnteredAt`, `type` (retail/insurance/repair/commercial), `assignedUserId`, FKs to `lead`/`customer`/`property`, `valueEstimate`/`valueFinal`/`costCents`, `openedAt`/`closedAt`. No schema change needed.
- **`job_stage_event`** records every transition (`fromStage`,`toStage`,`enteredAt`,`byAgent`).
- **`convertLeadToJob()`** (`packages/db/src/lifecycle/appointments.ts`) — automatic on appointment booking, idempotent, seeds the 212-task lifecycle, records the first stage event. **Currently hardcodes `type: "retail"`.**
- **`recordStageChange()`** (`packages/db/src/lifecycle/record-stage-change.ts`) — deterministic, idempotent: sets `stage`+`stageEnteredAt`, writes `job_stage_event`, auto-activates that stage's tasks, writes `audit_log`. Enforces required-photo gate on the move to `complete`.
- **Board UI** (`apps/web/src/app/(app)/jobs/board.tsx`, `apps/web/src/lib/pipeline-queries.ts`) — kanban, drag-to-move, raw days-in-stage. No config-driven health badges.
- **Events** (`packages/agents/src/client.ts`): `estimate/accepted` already advances → `approved`; `invoice/sent` and `invoice/paid` exist but **only** feed `dunning`/`qbo-sync` — no stage side-effects today.
- **Config pattern**: `tenant.settings` jsonb + zod parsers (`parseProductionConfig`, `parseFinanceConfig`, …) in `packages/core`.

### Lifecycle model (decided)
Keep the early job row. The job is created at inspection booking and spans the whole lifecycle: `lead → inspected → estimate → approved → production → closeout → billing → complete/lost`. **"Sold" is the existing `estimate/accepted → approved` transition**, not a new job-creation trigger. We do **not** re-point creation to contract-sign.

---

## 2. Goals (this slice)

1. **Derived health** — compute `stuck` and `late` on read from stage + timestamps + config. No manual status, no stored column.
2. **Config-driven board badges + needs-attention filter** — replace ad-hoc day logic with real At-risk/Late badges and a "Needs attention (N)" count/filter.
3. **Event→stage completeness** — wire the already-existing `invoice/sent → billing` and `invoice/paid → complete` via the deterministic `recordStageChange`.
4. **Carryover fix** — derive `job.type` (lane) from the lead instead of hardcoding `retail`.

### Non-goals (deferred to later pieces)
- The full "Needs you" exception queue (piece J).
- material-delivery / crew-GPS-checkin / completion-photo → stage events (pieces C/D).
- Weighted Command Center / win-probability (piece H.2).
- Any new DB column or migration.

---

## 3. Components

### 3.1 Jobs config + parser — `packages/core`
New `parseJobsConfig(raw)` over `tenant.settings.jobs`, mirroring `parseProductionConfig` (zod, defaults-friendly):

```ts
config.jobs = {
  // days-in-stage before a job is "stuck"; terminal stages omitted (never flag)
  stageThresholds: { inspected: 3, estimate: 7, approved: 5, production: 14, closeout: 5, billing: 10 },
  // approved-date → expected completion, per job type
  buildSlaDays:    { retail: 21, insurance: 45, repair: 10, commercial: 60 },
}
```

Defaults are baked into the parser so an empty `settings.jobs` still yields sane behavior. Values are tunable per tenant. (Defaults above are first-pass estimates, explicitly tunable.)

### 3.2 `deriveJobHealth` — `packages/core` (pure, unit-tested)

```ts
export type JobHealthSignals = {
  stage: JobStage;
  stageEnteredAt: Date;
  type: JobType;
  approvedAt: Date | null;       // earliest job_stage_event with toStage='approved'
  hasPastDueInvoice: boolean;    // an open invoice past its dueAt
};

export type JobHealth = { stuck: boolean; late: boolean; reasons: string[] };

export function deriveJobHealth(s: JobHealthSignals, config: JobsConfig, now: Date): JobHealth;
```

Rules:
- `stuck = daysBetween(stageEnteredAt, now) > stageThresholds[stage]` (false for terminal `complete`/`lost` and for stages without a configured threshold).
- `late  = (approvedAt != null && now > approvedAt + buildSlaDays[type]) || hasPastDueInvoice`.
- `reasons[]` carries human strings (e.g. `"stuck 9d in estimate (>7)"`, `"invoice 12d past due"`) for badge hover + future Needs-you.

Pure function — **the caller assembles `signals`**, keeping it trivially testable and free of DB coupling.

### 3.3 `job.type` carryover — `packages/core` + `packages/db`
- New `leadLaneToJobType(lane: string | null): JobType` in core — `"insurance" → "insurance"`, otherwise `"retail"` (extensible to repair/commercial as lane vocabulary grows; exact `lead.lane` values confirmed at implementation).
- `convertLeadToJob()` uses it for **both** the `job` insert **and** `seedJobTasks(...)`, so an insurance lead opens an `insurance` job *and* seeds insurance task templates. The idempotent "already booked → return existing job" path is unchanged.

### 3.4 invoice → stage — `packages/agents` (orchestrator domain)
New Inngest function `invoiceStageSync` (orchestrator owns status/handoffs):
- on `invoice/sent` → `recordStageChange(billing)`
- on `invoice/paid` → `recordStageChange(complete)`
- **Forward-only guard**: derive a stage ordinal; skip if the target is not strictly ahead of the current stage (so `invoice/sent` can't drag a completed job back to `billing`, and a re-fired event is a no-op beyond `recordStageChange`'s own idempotency).
- **Gate-aware**: `recordStageChange(complete)` already enforces the close-out photo gate; if photos are missing the move is refused and the job stays in `billing` — where `stuck` will surface it. (Closeout precedes billing, so the gate is normally already satisfied.)
- Resolves `jobId` from the invoice (`invoice.jobId`, else via the invoice's estimate→job link; confirmed at implementation). Logs via `recordAgentRun` + `audit_log` like sibling functions. Registered in `packages/agents/src/index.ts`.

### 3.5 Board surfacing — `apps/web`
- `pipeline-queries.ts` batch-computes the three signals per job (one `job_stage_event` lookup for `approvedAt`, one invoice-past-due check) and maps `deriveJobHealth`.
- Cards render **[At risk]** / **[Late]** badges (reason on hover), replacing ad-hoc day coloring; raw days-in-stage stays.
- Board header gains **"Needs attention (N)"** where `N = count(stuck || late)`, plus a filter toggle to show only those cards. The full exception queue is piece J.

---

## 4. Data flow, errors, idempotency

```
estimate/accepted ─┐
invoice/sent ──────┼─► (Inngest) ─► recordStageChange(stage)  [deterministic, idempotent, gated, forward-only]
invoice/paid ──────┘                     │
                                         └─► job.stage + job_stage_event + audit_log

Board read ─► gather signals (stageEnteredAt, approvedAt, hasPastDueInvoice, type)
           ─► deriveJobHealth(...) ─► badges + needs-attention count   [read-time only, never stored]
```

- Health is **computed on read** → it cannot drift and needs no backfill.
- Stage transitions remain the single deterministic write path (`recordStageChange`); Inngest functions are retry-safe; backward transitions are blocked by the forward-only guard.

## 5. Testing

- **Unit (core):** `deriveJobHealth` — stuck only / late only / both / neither; terminal stages never flag; `approvedAt = null` ⇒ never late by SLA; past-due ⇒ late regardless of stage. `parseJobsConfig` — defaults applied + per-tenant overrides. `leadLaneToJobType` — insurance vs retail.
- **Integration (db):** `convertLeadToJob` on an insurance-lane lead ⇒ `job.type='insurance'` and insurance task templates seeded; retail lane ⇒ retail; idempotent re-call returns the same job.
- **Agent/e2e:** `invoice/sent` ⇒ stage `billing`; `invoice/paid` ⇒ stage `complete` (forward-only; gate-aware — a job missing close-out photos stays in `billing`).
- **Board:** a job past its stage threshold shows **At risk**; a job past `approvedAt + buildSlaDays` or with a past-due invoice shows **Late**; the needs-attention count matches.

## 6. Non-negotiables checklist
- Tenant isolation: all reads/writes tenant-scoped (`withTenant` / explicit `tenantId`); board queries already scoped.
- No AI in the derivation (pure deterministic math); `recordAgentRun` only for the Inngest stage-sync action.
- Inngest functions durable + idempotent.
- No secrets; no new env.
- Config in `tenant.settings.jobs`; thresholds/SLAs tunable.
- Ships with tests; typecheck + lint clean.

## 7. Repo doc
Add a short `docs/jobs-pipeline.md` (or extend the existing phase-2 jobs doc) covering the stage model, the event→stage map, the health derivation, and how to tune `settings.jobs`.
