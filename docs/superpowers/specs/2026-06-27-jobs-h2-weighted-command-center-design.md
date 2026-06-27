# Jobs H.2 — Weighted Command Center (design)

**Date:** 2026-06-27
**Domain:** Jobs (build-order piece H.2: "Command Center — weighted pipeline").
**Scope:** A weighted-pipeline dashboard. Improves the existing app; does not replace the current `/command-center` agent-telemetry section.

---

## 1. Context (what exists)

- **`/command-center`** (`apps/web/src/app/(app)/command-center/page.tsx`) is an **agent-telemetry** dashboard (agent runs, AI spend, error rate, coverage cards). It has **no pipeline metrics**. We add a Pipeline section above/below the existing one; the telemetry section stays.
- **`getBoard()`** (`apps/web/src/lib/pipeline-queries.ts`, post-H.1) returns `BoardCard[]` grouped by stage, each with `valueEstimate`, `type`, `stageEnteredAt`, and `health` (`{ stuck, late }` from `deriveJobHealth`).
- **`sumCardValues`** (`@savvy/core`, from H.1) sums `valueEstimate` (null→0).
- **`computeVelocity(events)`** (`@savvy/core`) → `{ perStageAvgDays, cycleTimeDays }`.
- **`job_stage_event`** records every transition `{ jobId, fromStage, toStage, enteredAt }` — the only history source (no pipeline snapshots).
- **`job`** has `valueEstimate`, `openedAt`, current `stage`. **No win-probability config exists anywhere.**
- Enums: `JOB_STAGE = [lead, inspected, estimate, approved, production, closeout, billing, complete, lost]`. Open (pipeline) stages = all except `complete` + `lost`.

---

## 2. Goals

A weighted-pipeline view on `/command-center`:
1. **Win-probability config** per open stage (`tenant.settings.pipeline`), with defaults.
2. **Gross vs expected (weighted) pipeline** — per stage and overall (`expected = gross × probability`).
3. **Shrinkage** visual (gross → expected).
4. **At-risk $** — sum of `valueEstimate` for jobs flagged `stuck || late`.
5. **Avg cycle time** — from `computeVelocity`.
6. **Week-over-week trend** — per stage and overall, reconstructed from `job_stage_event`.

### Non-goals
- Learned/auto-tuned win-probabilities (config only; "later learned" is future).
- Historical *value* snapshots (WoW uses current value as a proxy — see §4).
- Changes to the agent-telemetry section.
- New DB tables/columns (all computed on read).

---

## 3. Components

### 3.1 Pipeline config — `packages/core`
`parsePipelineConfig(raw)` over `tenant.settings.pipeline`, mirroring `parseProductionConfig` (zod, defaults):
```ts
config.pipeline = {
  // win probability (0–100) per OPEN stage; terminal stages excluded
  stageWinProbability: { lead: 5, inspected: 15, estimate: 30, approved: 70, production: 90, closeout: 95, billing: 98 },
}
```
`export type PipelineConfig = z.infer<...>`; `parsePipelineConfig(raw: unknown): PipelineConfig`.

### 3.2 `weightedPipeline` — `packages/core` (pure, unit-tested)
```ts
export type StageGross = { stage: JobStage; grossCents: number };
export type WeightedStage = { stage: JobStage; grossCents: number; expectedCents: number; probability: number };
export type WeightedPipeline = { stages: WeightedStage[]; grossCents: number; expectedCents: number };

export function weightedPipeline(perStage: StageGross[], config: PipelineConfig): WeightedPipeline;
```
- For each input stage: `probability = stageWinProbability[stage] ?? 0`; `expectedCents = Math.round(grossCents * probability / 100)`.
- Totals = sums across the provided stages. Input is assumed to be open stages only (caller filters terminal).

### 3.3 `pipelineGrossAsOf` — `packages/core` (pure, unit-tested) — the WoW primitive
```ts
export type AsOfJob = { id: string; valueEstimate: number | null; openedAt: Date };
export type AsOfEvent = { jobId: string; toStage: JobStage; enteredAt: Date };

// Per-OPEN-stage gross value of the pipeline as it stood at `asOf`, reconstructed
// from stage events. Uses each job's CURRENT valueEstimate (historical value is not
// snapshotted) — directional, not penny-exact.
export function pipelineGrossAsOf(jobs: AsOfJob[], events: AsOfEvent[], asOf: Date): Record<string, number>;
```
Reconstruction rule per job:
- If `openedAt > asOf` → job didn't exist → skip.
- `stageAsOf` = `toStage` of the latest event with `enteredAt <= asOf`; if no such event → `"lead"` (creation stage, since `convertLeadToJob` inserts at `lead` before the first recorded transition).
- If `stageAsOf` is terminal (`complete`/`lost`) → not in pipeline → skip.
- Else add `valueEstimate ?? 0` to `result[stageAsOf]`.

Returns a `Record<stage, grossCents>` over open stages (missing stage ⇒ 0).

### 3.4 `getPipelineSummary` — `apps/web/src/lib/pipeline-queries.ts`
Assembles the dashboard data (tenant-scoped; `now` injected for testability via default):
```ts
export type PipelineSummary = {
  stages: { stage: JobStage; grossCents: number; expectedCents: number; probability: number; grossLastWeekCents: number; wowPct: number | null }[];
  totals: { grossCents: number; expectedCents: number; grossLastWeekCents: number; wowPct: number | null; atRiskCents: number; avgCycleDays: number };
};
export async function getPipelineSummary(): Promise<PipelineSummary>;
```
Steps:
1. Load open jobs (`stage NOT IN (complete, lost)`) with `id, stage, valueEstimate, openedAt, stageEnteredAt, type` (tenant-scoped via `withTenant`).
2. Current per-stage gross = group + `sumCardValues`.
3. `weighted = weightedPipeline(currentPerStage, parsePipelineConfig(settings.pipeline))`.
4. **At-risk $:** reuse `deriveJobHealth` per job (same inputs as `getBoard`) → sum `valueEstimate` where `stuck || late`.
5. **Cycle time:** load `job_stage_event` rows → `computeVelocity(events).cycleTimeDays`.
6. **WoW:** load all open-or-recently-terminal jobs' `openedAt` + all stage events → `lastWeek = pipelineGrossAsOf(jobs, events, now − 7d)`; per-stage + overall `wowPct = grossLastWeek>0 ? round((gross − grossLastWeek)/grossLastWeek·100) : null`.
   - (Note: jobs that are terminal now but were open last week must be included in the as-of set, so step 6 loads jobs by `openedAt`, not only currently-open.)
7. `wowPct = null` when last-week gross is 0 (no basis).

`wowPct` math (per-stage and total) lives in a tiny pure helper `wowPct(currentCents, priorCents): number | null` in core (unit-tested) to keep the query thin.

### 3.5 Dashboard UI — `apps/web/src/app/(app)/command-center/`
A new server component `PipelineSummaryPanel` (or inline section) rendered on the command-center page:
- **Headline:** `Gross $X → Expected $Y` with the overall **WoW %** (▲/▼, green/red, dark-mode-safe tokens).
- **Per-stage rows/bars:** stage label, gross bar with the expected portion shaded (the shrinkage visual), `probability%`, per-stage WoW arrow.
- **Secondary metrics:** **At-risk $Z**, **avg cycle N days**.
- Uses existing `MetricCard`/`Card` + cockpit CSS tokens; no hardcoded colors.

---

## 4. WoW honesty (the key approximation)
There are no historical pipeline snapshots, so "last week's pipeline" is reconstructed from `job_stage_event` and valued at **current** `valueEstimate`. So WoW = "value of jobs that were open last week, at today's prices." It is directional and correct in *shape*; it will not match a penny-exact historical ledger. The UI labels the trend as such (e.g. a tooltip/footnote). This is acceptable for a trend indicator and avoids adding a snapshot table now.

## 5. Data flow / determinism
```
settings.pipeline ─► parsePipelineConfig
open jobs (current) ─► per-stage gross ─► weightedPipeline ─► gross/expected
jobs.openedAt + job_stage_event ─► pipelineGrossAsOf(now−7d) ─► WoW
job health (deriveJobHealth) ─► at-risk $
job_stage_event ─► computeVelocity ─► avg cycle
```
All pure/deterministic (no AI); read-time only; tenant-scoped.

## 6. Testing
- **Unit (core):** `parsePipelineConfig` (defaults + overrides); `weightedPipeline` (expected math, missing prob ⇒ 0, totals); `pipelineGrossAsOf` (job not-yet-created excluded; pre-first-event ⇒ lead; terminal-as-of excluded; multi-event picks latest ≤ asOf); `wowPct` (null on zero basis, rounding, negative).
- **Integration/e2e:** seed jobs across stages with stage events → `/command-center` Pipeline section shows gross, expected (< gross), at-risk $, cycle time, and a WoW indicator.

## 7. Non-negotiables
- Tenant isolation on every read (`withTenant`); deterministic (no AI in the math); no new tables/columns; config in `tenant.settings.pipeline`; ships with tests; typecheck + lint clean; dark-mode-safe UI.

## 8. Repo doc
Extend `docs/jobs-pipeline.md` with a "Weighted pipeline (Command Center)" section: win-probability config, expected-value math, the WoW reconstruction + its current-value caveat, and how to tune `settings.pipeline`.
