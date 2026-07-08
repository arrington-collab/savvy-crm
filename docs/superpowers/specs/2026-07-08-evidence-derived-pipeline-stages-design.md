# Evidence-Derived Pipeline Stages — Design

**Date:** 2026-07-08
**Worktree/branch:** `worktree-evidence-derived-stages` (off `origin/main` @ 8f731b1; includes #168; journal at 0068)

## Goal

A job's pipeline **stage must be a consequence of evidence, not a declared input.** Forward
stage transitions are rejected at the write path unless the job has the evidence for the
target stage; a re-derive fixes existing over-declared jobs (e.g. Josh Williamson's job that
reached `inspected` with no inspection); an exception vector catches future bypasses.

## Context (verified)

- **`JOB_STAGE`** (`packages/core/src/enums.ts:2`): `["lead","inspected","estimate","approved","production","closeout","billing","complete","lost"]`. No `invoiced` stage — `billing` = invoice sent, `complete` = invoice paid. Ordinal = forward order.
- **`recordStageChange`** (`packages/db/src/lifecycle/record-stage-change.ts:37-95`) is the **only** `job.stage` writer (the single `tx.update(job).set({ stage })` at :64). Six callers funnel through it; today it has a `complete` photo gate + a per-stage `requiredDocs` doc gate, but **no forward-only guard and no evidence gate**.
- **`advanceJobStageForward`** (`advance-stage.ts:20-46`) wraps it with forward-only + gate-skip; the #108 triggers (`syncCrewCheckInStage`/`syncMaterialDeliveredStage`/`syncCompletionPhotosStage` in `production-triggers.ts`) use it — **keep these as the evidence writers**.
- **The Josh bug:** `convertLeadToJob` (`appointments.ts:290`) calls `recordStageChange(… toStage:"inspected")` **unconditionally** on every convert (funnel and `manualJob`). That's how a job reaches `inspected` with no inspection record.
- **Evidence tables** (exact): inspection = `appointment` `type='inspection'` `status='done'` (status enum is `scheduled|done|canceled|no_show` — **not** `completed`), scoped by `leadId` (pre-job) or `jobId`; photo = `document` `kind='photo'`; estimate = `estimate` row (`leadId`/`jobId`); approved = `estimate.status='accepted'` OR `document.kind='contract'`; production = `appointment type='crew' status='scheduled'` (`hasScheduledCrewInstall`) OR `material_order.status='ordered'`; completion photos = `missingProductionPhotos` empty; billing = `invoice` row; paid = `invoice.status='paid'`.
- **`job_stage_event.note`** (text) already exists (`jobs.ts:71`) — backward-transition reasons need **no migration**. `recordStageChange` doesn't write it yet.
- **Evidence-check system**: `evidenceChecks` (`checks.ts`), `invariant()` builder; unbound checks (like `exceptions.roof_type`) need no `CHECK_BINDINGS`/bound-set-test change. **Exception queue**: `exception-queue.ts` `buildExceptionQueue` (pure, `ExceptionKind` union) is the operator amber surface.
- **Board "waiting on"**: `deriveWaitingOn` + `COLUMN_FALLBACK` (`packages/core/src/pipeline-board.ts`), fed by `getPipelineBoard()` (`apps/web/src/lib/pipeline-queries.ts`).
- **Re-derive script pattern**: `packages/db/src/scripts/backfill-won-leads.ts` (`--dry-run`, `adminPool`, idempotent UPDATE).
- **No migration required.**

## Decisions (locked with owner)

| Fork | Decision |
| --- | --- |
| Evidence composition | **Contiguous chain.** A job may be at S only with evidence for every gated stage from `inspected` up to S. Funnel→`approved`, canvass (contract, no inspection)→`lead`, Josh→`lead`. |
| Inspection evidence | **Done `inspection` appt OR ≥1 `photo` document** (lead or job). |
| Board forward-drag w/o evidence | **Rejected** with the missing-evidence message. Backward drags allowed **with a reason** (→ `note`). |
| Exception vector semantics | **Own-stage** (flag a job whose *current* stage's own evidence is absent) — the gate is the contiguous enforcer; the vector is the lighter bypass net. |
| Re-derive direction | **Both** — regress over-declared *and* promote fully-evidenced under-declared jobs; **dry-run diff reviewed before any prod apply.** |

## Architecture

### 0. Pure core — `packages/core/src/stage-evidence.ts` (new)

```
interface StageEvidence { inspection; estimate; approval; production; closeoutPhotos; invoice; invoicePaid } // all boolean
STAGE_EVIDENCE_LABEL: Record<gatedStage,string>  // inspected:"inspection", estimate:"estimate", approved:"approval", production:"crew or materials", billing:"invoice"
deriveContiguousStage(ev): JobStage   // highest stage whose chain from 'inspected' up is unbroken; else 'lead'
missingEvidenceFor(stage, ev): string | null   // label of the first missing gate at/below `stage` (for reject msg + waiting-on)
stageEvidenceSatisfied(stage, ev): boolean      // own-stage predicate for one stage (for the exception vector)
```

Ladder (index order): `lead`(always) → `inspected`(inspection) → `estimate`(estimate) →
`approved`(approval) → `production`(production) → `closeout`(closeoutPhotos) →
`billing`(invoice) → `complete`(invoicePaid). `lost` is off-ladder (terminal).
`deriveContiguousStage` walks up, stopping at the first stage whose predicate is false.

### 1. Evidence gathering — `packages/db/src/lifecycle/stage-evidence-db.ts` (new)

`gatherStageEvidence(tx, { tenantId, jobId }): Promise<StageEvidence>` — resolves the job's
`leadId`, then runs the existence queries (job- and lead-scoped) and returns the booleans.
Reuses `missingProductionPhotos`/`hasScheduledCrewInstall`.

### 2. Gate at the write path — `recordStageChange` (edit)

Add a `reason?: string` param. After resolving `fromStage`:
- **Forward** (`idx(toStage) > idx(fromStage)`): `ev = gatherStageEvidence(...)`; if
  `idx(toStage) > idx(deriveContiguousStage(ev))` → `throw new StageEvidenceError(missingEvidenceFor(toStage, ev))`.
- **Backward** (`idx(toStage) < idx(fromStage)` and `toStage !== 'lost'`): if no `reason` →
  `throw new BackwardNeedsReasonError()`.
- Write `note: reason ?? null` into the `job_stage_event` insert.
- Keep the existing `complete` photo gate + `requiredDocs` doc gate.

`advanceJobStageForward` catches `StageEvidenceError` → `{skipped:"evidence_gate"}` (alongside `photo_gate`/`doc_gate`). New error classes exported from the db barrel.

### 3. Josh fix + manual-job guard — `convertLeadToJob` (edit, appointments.ts)

- **Remove** the unconditional `recordStageChange(…toStage:"inspected")` at :290. After
  creating the job at `lead` + seeding tasks, compute `derived = deriveContiguousStage(gatherStageEvidence(...))`
  and, if `derived !== 'lead'`, `recordStageChange(…toStage: derived, reason:"evidence-derived on convert")`
  (passes the gate — the evidence is present). Funnel→`approved`, canvass→`lead`, Josh→`lead`.
- Add `reason?: string` to `convertLeadToJob` args. When `manualJob` and the lead has **no**
  `document.kind='contract'` **and** no `reason` → `throw new ManualJobEvidenceError()`. Canvass
  passes natively (it carries a contract); thread its existing intent as the reason if needed.

### 4. Re-derive script — `packages/db/src/scripts/rederive-job-stages.ts` (new)

Mirrors `backfill-won-leads.ts`: `--dry-run`, `adminPool`. For each job (all tenants): set the
tenant GUC, `gatherStageEvidence`, `derived = deriveContiguousStage(ev)`; where `derived !==
job.stage`, UPDATE + insert a corrective `job_stage_event` (`note:"re-derive: evidence-supported stage"`).
Reports counts + a per-job diff (from→to), split into regressions vs promotions. Idempotent
(a second run is a no-op). Run prod dry-run → review → apply.

### 5. Exception vector — `job.stage_evidence`

- `evidenceChecks["job.stage_evidence"]` (checks.ts), **unbound**: SQL selecting jobs whose
  **current stage's own evidence is absent** — a per-stage `CASE`/`EXISTS` (stage `inspected`
  AND no inspection evidence; `estimate` AND no estimate; `approved` AND no accepted-estimate/contract;
  `production` AND no crew/materials; `billing` AND no invoice). `toRef → {type:"job"}`.
- Add a `stage_evidence` `ExceptionKind` + input type + branch in `buildExceptionQueue`
  (`exception-queue.ts`), severity `medium` (amber), fed by a db query listing offending jobs,
  so they surface in the operator queue.

### 6. Board write path + waiting-on — `apps/web`

- `moveJobToStage` (`apps/web/src/lib/job-actions.ts`): route through `recordStageChange` so the
  gate applies; a forward drag without evidence returns the `StageEvidenceError` missing-label to
  the UI; a backward drag requires a reason.
- `getPipelineBoard()` batches per-job `StageEvidence`; `deriveWaitingOn` prefers
  `missingEvidenceFor(nextStage, ev)` ("needs: inspection") so the card's waiting-on line names
  the specific missing artifact for the next stage.

## Files

- **New:** `packages/core/src/stage-evidence.ts`; `packages/db/src/lifecycle/stage-evidence-db.ts`; `packages/db/src/scripts/rederive-job-stages.ts`.
- **Edit:** `packages/db/src/lifecycle/record-stage-change.ts` (+ error classes); `packages/db/src/lifecycle/advance-stage.ts` (catch); `packages/db/src/lifecycle/appointments.ts` (`convertLeadToJob`); `packages/db/src/index.ts` (barrel); `packages/core/src/index.ts`; `packages/core/src/verification/checks.ts`; `packages/core/src/exception-queue.ts`; `apps/web/src/lib/job-actions.ts`; `apps/web/src/lib/pipeline-queries.ts`; `packages/core/src/pipeline-board.ts`.

## Testing (TDD, red-first)

**Core** — `deriveContiguousStage` (funnel/canvass/Josh cases), `missingEvidenceFor`, `stageEvidenceSatisfied`.
**db gate (red-path per gate)** — advancing to `inspected`/`estimate`/`approved`/`production`/`billing` without that evidence throws `StageEvidenceError`; with the full chain it passes; backward without a reason throws; backward with a reason writes `note`; `advanceJobStageForward` returns `{skipped:"evidence_gate"}`.
**convert** — no longer jumps to `inspected`; funnel job lands at `approved`; canvass lands at `lead`; `manualJob` without contract-or-reason throws.
**re-derive** — a Josh-like job (stage `inspected`, no evidence) drops to `lead`; a fully-evidenced under-declared job promotes; idempotent second run = 0 changes.
**exception vector** — `job.stage_evidence` green on an evidence-backed job, red on an over-declared one.
**e2e** — a forward board-drag without evidence is rejected; the waiting-on line names the missing artifact.

## Live verification (in the PR)

On prod: run the re-derive **dry-run**, review the diff (owner-approved), apply; confirm Josh's
card sits in the correct column; confirm an evidence-less forward advance is rejected. State it
in the PR.

## Out of scope

- No migration; no new stage. `lost` keeps its current terminal behavior (no new reason gate on the existing → lost chargeback path). Promotion of under-declared jobs is part of re-derive but only after the reviewed dry-run.
