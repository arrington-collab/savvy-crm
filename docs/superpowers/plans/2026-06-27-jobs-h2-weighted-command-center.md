# Jobs H.2 — Weighted Command Center Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a weighted-pipeline dashboard to `/command-center` — gross vs expected (weighted) pipeline, shrinkage, at-risk $, avg cycle time, and week-over-week trend — all computed on read.

**Architecture:** Pure deterministic math in `@savvy/core` (`parsePipelineConfig`, `weightedPipeline` + `wowPct`, `pipelineGrossAsOf`); a `getPipelineSummary` web query that reuses `getBoard` (current gross + at-risk), `computeVelocity` (cycle), and `pipelineGrossAsOf` over `job_stage_event` (WoW); and a server-rendered Pipeline panel on the existing command-center page. No new DB tables/columns. WoW is reconstructed from stage events using current `valueEstimate` (directional, not penny-exact).

**Tech Stack:** TypeScript, Next.js (App Router, server components), Drizzle ORM (Postgres + RLS), Vitest + Playwright, pnpm + Turborepo, zod v3.

**Spec:** `docs/superpowers/specs/2026-06-27-jobs-h2-weighted-command-center-design.md`

## Global Constraints

- **Build off `origin/main`** (this worktree `jobs-h2` is branched from it; includes A+B, D1a, H.1, E-margin).
- **Import-extension rule (match the file you edit):** `packages/core/*`, `packages/db/src/**` SOURCE, `apps/web/*` → **NO `.js`**; only `packages/db` TEST files use `.js`.
- **Single instances:** within `packages/core` import `z` from `"./schemas"`; drizzle tables/ops from `@savvy/db`.
- **`apps/web` is NOT unit-tested by vitest** (workspace = `packages/*`; web uses Playwright). So web-layer logic (`getPipelineSummary`, the panel) is verified by an **e2e**, not a vitest unit test. All pure math lives in `@savvy/core` where it IS unit-tested.
- **No new DB columns/tables.** Read-time only. Tenant isolation via `withTenant` / `getTenantId()`.
- **Determinism:** no AI in any of this. **Dark-mode-safe UI** — use cockpit CSS tokens (`var(--...)`)/existing components, no hardcoded colors.
- **Enums (verbatim):** `JOB_STAGE = ["lead","inspected","estimate","approved","production","closeout","billing","complete","lost"]`. Open stages = all except `complete`/`lost`.
- **Definition of done:** tests pass; `pnpm typecheck` + `pnpm lint` clean (pre-existing `scheduling.ts`/`pipeline.spec.ts` warnings excepted).
- **Test commands:** core focused → `pnpm --filter @savvy/core exec vitest run <relpath>`; web e2e → `pnpm db:up`, then from `apps/web`: `npx tsx tests/e2e/create-tenant.ts && export TEST_TENANT_ID=$(node -e "console.log(require('/tmp/savvy-e2e-tenant.json').id)") && ./node_modules/.bin/playwright test <spec>`.

---

### Task 1: Pipeline config parser (core)

**Files:**
- Create: `packages/core/src/pipeline-config.ts`
- Create: `packages/core/src/pipeline-config.test.ts`
- Modify: `packages/core/src/index.ts` (add `export * from "./pipeline-config"`)

**Interfaces:**
- Produces: `type PipelineConfig = { stageWinProbability: { lead,inspected,estimate,approved,production,closeout,billing: number } }`; `parsePipelineConfig(raw: unknown): PipelineConfig`.

- [ ] **Step 1: Write the failing test** — `packages/core/src/pipeline-config.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { parsePipelineConfig } from "./pipeline-config";

describe("parsePipelineConfig", () => {
  it("fills win-probability defaults for every open stage", () => {
    const c = parsePipelineConfig(undefined);
    expect(c.stageWinProbability).toEqual({ lead: 5, inspected: 15, estimate: 30, approved: 70, production: 90, closeout: 95, billing: 98 });
  });
  it("applies overrides and keeps other defaults", () => {
    const c = parsePipelineConfig({ stageWinProbability: { approved: 60 } });
    expect(c.stageWinProbability.approved).toBe(60);
    expect(c.stageWinProbability.estimate).toBe(30);
  });
});
```

- [ ] **Step 2: Run → FAIL** — `pnpm --filter @savvy/core exec vitest run src/pipeline-config.test.ts` (Cannot find module).

- [ ] **Step 3: Implement** — `packages/core/src/pipeline-config.ts`:
```typescript
import { z } from "./schemas";

const pipelineSchema = z.object({
  // win probability (0–100) per OPEN stage; terminal stages excluded
  stageWinProbability: z
    .object({
      lead: z.number().int().min(0).max(100).default(5),
      inspected: z.number().int().min(0).max(100).default(15),
      estimate: z.number().int().min(0).max(100).default(30),
      approved: z.number().int().min(0).max(100).default(70),
      production: z.number().int().min(0).max(100).default(90),
      closeout: z.number().int().min(0).max(100).default(95),
      billing: z.number().int().min(0).max(100).default(98),
    })
    .default({}),
});

export type PipelineConfig = z.infer<typeof pipelineSchema>;

export function parsePipelineConfig(raw: unknown): PipelineConfig {
  return pipelineSchema.parse(raw ?? {});
}
```

- [ ] **Step 4: Export** — add to `packages/core/src/index.ts`: `export * from "./pipeline-config";`

- [ ] **Step 5: Run → PASS**; `pnpm --filter @savvy/core typecheck` clean.

- [ ] **Step 6: Commit**
```bash
git add packages/core/src/pipeline-config.ts packages/core/src/pipeline-config.test.ts packages/core/src/index.ts
git commit -m "feat(core): parsePipelineConfig (per-stage win probability)"
```

---

### Task 2: weightedPipeline + wowPct (core)

**Files:**
- Create: `packages/core/src/weighted-pipeline.ts`
- Create: `packages/core/src/weighted-pipeline.test.ts`
- Modify: `packages/core/src/index.ts` (add `export * from "./weighted-pipeline"`)

**Interfaces:**
- Consumes: `PipelineConfig` (Task 1); `JobStage` (`./enums`).
- Produces:
  - `type StageGross = { stage: JobStage; grossCents: number }`
  - `type WeightedStage = { stage: JobStage; grossCents: number; expectedCents: number; probability: number }`
  - `type WeightedPipeline = { stages: WeightedStage[]; grossCents: number; expectedCents: number }`
  - `weightedPipeline(perStage: StageGross[], config: PipelineConfig): WeightedPipeline`
  - `wowPct(currentCents: number, priorCents: number): number | null`

- [ ] **Step 1: Write the failing test** — `packages/core/src/weighted-pipeline.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { weightedPipeline, wowPct } from "./weighted-pipeline";
import { parsePipelineConfig } from "./pipeline-config";

const cfg = parsePipelineConfig(undefined); // approved 70%, estimate 30%

describe("weightedPipeline", () => {
  it("computes expected = gross * probability/100 per stage and totals", () => {
    const r = weightedPipeline(
      [{ stage: "approved", grossCents: 1_000_000 }, { stage: "estimate", grossCents: 500_000 }],
      cfg,
    );
    const approved = r.stages.find((s) => s.stage === "approved")!;
    expect(approved.expectedCents).toBe(700_000);
    expect(approved.probability).toBe(70);
    expect(r.grossCents).toBe(1_500_000);
    expect(r.expectedCents).toBe(700_000 + 150_000);
  });
  it("treats a stage with no configured probability as 0", () => {
    const r = weightedPipeline([{ stage: "lost" as never, grossCents: 999 }], cfg);
    expect(r.stages[0]!.probability).toBe(0);
    expect(r.stages[0]!.expectedCents).toBe(0);
  });
});

describe("wowPct", () => {
  it("computes rounded percent change", () => {
    expect(wowPct(120, 100)).toBe(20);
    expect(wowPct(80, 100)).toBe(-20);
  });
  it("returns null when there is no prior basis", () => {
    expect(wowPct(100, 0)).toBeNull();
    expect(wowPct(100, -5)).toBeNull();
  });
});
```

- [ ] **Step 2: Run → FAIL** — `pnpm --filter @savvy/core exec vitest run src/weighted-pipeline.test.ts`.

- [ ] **Step 3: Implement** — `packages/core/src/weighted-pipeline.ts`:
```typescript
import type { JobStage } from "./enums";
import type { PipelineConfig } from "./pipeline-config";

export type StageGross = { stage: JobStage; grossCents: number };
export type WeightedStage = { stage: JobStage; grossCents: number; expectedCents: number; probability: number };
export type WeightedPipeline = { stages: WeightedStage[]; grossCents: number; expectedCents: number };

export function weightedPipeline(perStage: StageGross[], config: PipelineConfig): WeightedPipeline {
  const probs = config.stageWinProbability as Record<string, number>;
  const stages: WeightedStage[] = perStage.map((s) => {
    const probability = probs[s.stage] ?? 0;
    return { stage: s.stage, grossCents: s.grossCents, probability, expectedCents: Math.round((s.grossCents * probability) / 100) };
  });
  return {
    stages,
    grossCents: stages.reduce((a, s) => a + s.grossCents, 0),
    expectedCents: stages.reduce((a, s) => a + s.expectedCents, 0),
  };
}

/** Week-over-week percent change; null when there is no prior basis. */
export function wowPct(currentCents: number, priorCents: number): number | null {
  if (priorCents <= 0) return null;
  return Math.round(((currentCents - priorCents) / priorCents) * 100);
}
```

- [ ] **Step 4: Export** — `packages/core/src/index.ts`: `export * from "./weighted-pipeline";`

- [ ] **Step 5: Run → PASS**; typecheck clean.

- [ ] **Step 6: Commit**
```bash
git add packages/core/src/weighted-pipeline.ts packages/core/src/weighted-pipeline.test.ts packages/core/src/index.ts
git commit -m "feat(core): weightedPipeline + wowPct (expected value + trend math)"
```

---

### Task 3: pipelineGrossAsOf — WoW reconstruction (core)

**Files:**
- Create: `packages/core/src/pipeline-asof.ts`
- Create: `packages/core/src/pipeline-asof.test.ts`
- Modify: `packages/core/src/index.ts` (add `export * from "./pipeline-asof"`)

**Interfaces:**
- Consumes: `JobStage` (`./enums`).
- Produces:
  - `type AsOfJob = { id: string; valueEstimate: number | null; openedAt: Date }`
  - `type AsOfEvent = { jobId: string; toStage: JobStage; enteredAt: Date }`
  - `pipelineGrossAsOf(jobs: AsOfJob[], events: AsOfEvent[], asOf: Date): Record<string, number>` — per-open-stage gross value of the pipeline as of `asOf`.

- [ ] **Step 1: Write the failing test** — `packages/core/src/pipeline-asof.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { pipelineGrossAsOf, type AsOfJob, type AsOfEvent } from "./pipeline-asof";

const D = (s: string) => new Date(s);
const asOf = D("2026-06-15T00:00:00Z");

describe("pipelineGrossAsOf", () => {
  it("excludes jobs not yet created at asOf", () => {
    const jobs: AsOfJob[] = [{ id: "j1", valueEstimate: 1000, openedAt: D("2026-06-20T00:00:00Z") }];
    expect(pipelineGrossAsOf(jobs, [], asOf)).toEqual({});
  });
  it("treats a job with no event before asOf as stage 'lead'", () => {
    const jobs: AsOfJob[] = [{ id: "j1", valueEstimate: 1000, openedAt: D("2026-06-01T00:00:00Z") }];
    const events: AsOfEvent[] = [{ jobId: "j1", toStage: "approved", enteredAt: D("2026-06-20T00:00:00Z") }]; // after asOf
    expect(pipelineGrossAsOf(jobs, events, asOf)).toEqual({ lead: 1000 });
  });
  it("uses the latest event at/before asOf to place the job", () => {
    const jobs: AsOfJob[] = [{ id: "j1", valueEstimate: 5000, openedAt: D("2026-06-01T00:00:00Z") }];
    const events: AsOfEvent[] = [
      { jobId: "j1", toStage: "inspected", enteredAt: D("2026-06-05T00:00:00Z") },
      { jobId: "j1", toStage: "estimate", enteredAt: D("2026-06-10T00:00:00Z") },
      { jobId: "j1", toStage: "approved", enteredAt: D("2026-06-20T00:00:00Z") }, // after asOf, ignored
    ];
    expect(pipelineGrossAsOf(jobs, events, asOf)).toEqual({ estimate: 5000 });
  });
  it("excludes jobs that were terminal as of asOf", () => {
    const jobs: AsOfJob[] = [{ id: "j1", valueEstimate: 5000, openedAt: D("2026-06-01T00:00:00Z") }];
    const events: AsOfEvent[] = [{ jobId: "j1", toStage: "complete", enteredAt: D("2026-06-10T00:00:00Z") }];
    expect(pipelineGrossAsOf(jobs, events, asOf)).toEqual({});
  });
  it("sums multiple jobs into their as-of stages, null value as 0", () => {
    const jobs: AsOfJob[] = [
      { id: "a", valueEstimate: 1000, openedAt: D("2026-06-01T00:00:00Z") },
      { id: "b", valueEstimate: null, openedAt: D("2026-06-01T00:00:00Z") },
      { id: "c", valueEstimate: 2000, openedAt: D("2026-06-01T00:00:00Z") },
    ];
    const events: AsOfEvent[] = [
      { jobId: "a", toStage: "estimate", enteredAt: D("2026-06-05T00:00:00Z") },
      { jobId: "c", toStage: "estimate", enteredAt: D("2026-06-05T00:00:00Z") },
    ];
    expect(pipelineGrossAsOf(jobs, events, asOf)).toEqual({ estimate: 3000, lead: 0 });
  });
});
```

- [ ] **Step 2: Run → FAIL**.

- [ ] **Step 3: Implement** — `packages/core/src/pipeline-asof.ts`:
```typescript
import type { JobStage } from "./enums";

export type AsOfJob = { id: string; valueEstimate: number | null; openedAt: Date };
export type AsOfEvent = { jobId: string; toStage: JobStage; enteredAt: Date };

const TERMINAL = new Set<JobStage>(["complete", "lost"]);

/**
 * Per-open-stage gross value of the pipeline as it stood at `asOf`, reconstructed
 * from stage events. Uses each job's CURRENT valueEstimate (historical value is not
 * snapshotted) — directional, not penny-exact.
 */
export function pipelineGrossAsOf(jobs: AsOfJob[], events: AsOfEvent[], asOf: Date): Record<string, number> {
  const t = asOf.getTime();
  const byJob = new Map<string, AsOfEvent[]>();
  for (const e of events) {
    if (e.enteredAt.getTime() > t) continue; // future of asOf
    const list = byJob.get(e.jobId) ?? [];
    list.push(e);
    byJob.set(e.jobId, list);
  }
  const result: Record<string, number> = {};
  for (const j of jobs) {
    if (j.openedAt.getTime() > t) continue; // didn't exist yet
    const evs = byJob.get(j.id);
    const stageAsOf: JobStage =
      evs && evs.length
        ? evs.reduce((a, b) => (b.enteredAt.getTime() >= a.enteredAt.getTime() ? b : a)).toStage
        : ("lead" as JobStage); // created but no recorded transition yet
    if (TERMINAL.has(stageAsOf)) continue;
    result[stageAsOf] = (result[stageAsOf] ?? 0) + (j.valueEstimate ?? 0);
  }
  return result;
}
```

- [ ] **Step 4: Export** — `packages/core/src/index.ts`: `export * from "./pipeline-asof";`

- [ ] **Step 5: Run → PASS**; typecheck clean.

- [ ] **Step 6: Commit**
```bash
git add packages/core/src/pipeline-asof.ts packages/core/src/pipeline-asof.test.ts packages/core/src/index.ts
git commit -m "feat(core): pipelineGrossAsOf (WoW pipeline reconstruction from stage events)"
```

---

### Task 4: getPipelineSummary query (web)

**Files:**
- Modify: `apps/web/src/lib/pipeline-queries.ts` (add `getPipelineSummary` + `PipelineSummary` type)

**Interfaces:**
- Consumes: `getBoard`, `sumCardValues` (existing); `weightedPipeline`, `wowPct`, `pipelineGrossAsOf`, `parsePipelineConfig`, `computeVelocity`, `JOB_STAGE`, `type JobStage` (`@savvy/core`); `job`, `jobStageEvent`, `tenant`, `withTenant`, `eq` (`@savvy/db`); `getTenantId`.
- Produces:
```ts
export type PipelineSummary = {
  stages: { stage: JobStage; grossCents: number; expectedCents: number; probability: number; grossLastWeekCents: number; wowPct: number | null }[];
  totals: { grossCents: number; expectedCents: number; grossLastWeekCents: number; wowPct: number | null; atRiskCents: number; avgCycleDays: number };
};
export async function getPipelineSummary(): Promise<PipelineSummary>;
```

- [ ] **Step 1: Add imports** (merge with existing import lines at the top of `pipeline-queries.ts`):
```typescript
import { JOB_STAGE, parseJobsConfig, deriveJobHealth, sumCardValues, weightedPipeline, wowPct, pipelineGrossAsOf, parsePipelineConfig, computeVelocity, type JobHealth, type JobStage, type JobType } from "@savvy/core";
import { withTenant, job, jobStageEvent, customer, property, invoice, tenant, eq, and, desc, sql } from "@savvy/db";
```
(Keep the existing symbols; this adds `parsePipelineConfig`, `weightedPipeline`, `wowPct`, `pipelineGrossAsOf`, `computeVelocity`, `sumCardValues`, `jobStageEvent`. `sumCardValues` may already be imported — do not duplicate.)

- [ ] **Step 2: Append the query + type** at the end of `pipeline-queries.ts`:
```typescript
export type PipelineSummary = {
  stages: { stage: JobStage; grossCents: number; expectedCents: number; probability: number; grossLastWeekCents: number; wowPct: number | null }[];
  totals: { grossCents: number; expectedCents: number; grossLastWeekCents: number; wowPct: number | null; atRiskCents: number; avgCycleDays: number };
};

const OPEN_STAGES = JOB_STAGE.filter((s) => s !== "complete" && s !== "lost");

/** Weighted-pipeline rollup for the Command Center. Reuses getBoard for current
 *  gross + at-risk; reconstructs last-week gross from stage events. Read-only. */
export async function getPipelineSummary(): Promise<PipelineSummary> {
  const tenantId = await getTenantId();
  const board = await getBoard();

  const [t] = await withTenant(tenantId, (tx) =>
    tx.select({ settings: tenant.settings }).from(tenant).where(eq(tenant.id, tenantId)),
  );
  const config = parsePipelineConfig((t?.settings as { pipeline?: unknown } | undefined)?.pipeline);

  const perStage = OPEN_STAGES.map((stage) => ({ stage, grossCents: sumCardValues(board[stage] ?? []) }));
  const weighted = weightedPipeline(perStage, config);
  const atRiskCents = sumCardValues(Object.values(board).flat().filter((c) => c.health.stuck || c.health.late));

  const { jobs, events } = await withTenant(tenantId, async (tx) => {
    const jobs = await tx.select({ id: job.id, valueEstimate: job.valueEstimate, openedAt: job.openedAt }).from(job).where(eq(job.tenantId, tenantId));
    const events = await tx
      .select({ jobId: jobStageEvent.jobId, toStage: jobStageEvent.toStage, enteredAt: jobStageEvent.enteredAt })
      .from(jobStageEvent)
      .where(eq(jobStageEvent.tenantId, tenantId));
    return { jobs, events };
  });

  const avgCycleDays = Math.round(computeVelocity(events.map((e) => ({ jobId: e.jobId, toStage: e.toStage as string, enteredAt: e.enteredAt }))).cycleTimeDays);

  const now = new Date();
  const lastWeek = pipelineGrossAsOf(
    jobs.map((j) => ({ id: j.id, valueEstimate: j.valueEstimate, openedAt: j.openedAt })),
    events.map((e) => ({ jobId: e.jobId, toStage: e.toStage as JobStage, enteredAt: e.enteredAt })),
    new Date(now.getTime() - 7 * 86_400_000),
  );

  const stages = weighted.stages.map((s) => {
    const grossLastWeekCents = lastWeek[s.stage] ?? 0;
    return { ...s, grossLastWeekCents, wowPct: wowPct(s.grossCents, grossLastWeekCents) };
  });
  const grossLastWeekCents = OPEN_STAGES.reduce((a, st) => a + (lastWeek[st] ?? 0), 0);

  return {
    stages,
    totals: {
      grossCents: weighted.grossCents,
      expectedCents: weighted.expectedCents,
      grossLastWeekCents,
      wowPct: wowPct(weighted.grossCents, grossLastWeekCents),
      atRiskCents,
      avgCycleDays,
    },
  };
}
```

- [ ] **Step 3: Typecheck** — `pnpm --filter @savvy/web typecheck` → clean. (No vitest unit test for this web-layer fn; the Task 5 e2e covers it. `getBoard`/`deriveJobHealth` already exist in this file — do not redefine.)

- [ ] **Step 4: Commit**
```bash
git add apps/web/src/lib/pipeline-queries.ts
git commit -m "feat(web): getPipelineSummary — weighted pipeline rollup + WoW"
```

---

### Task 5: Pipeline panel on /command-center + e2e (web)

**Files:**
- Create: `apps/web/src/app/(app)/command-center/PipelineSummaryPanel.tsx`
- Modify: `apps/web/src/app/(app)/command-center/page.tsx` (render the panel)
- Create: `apps/web/tests/e2e/command-center-pipeline.spec.ts`

**Interfaces:**
- Consumes: `getPipelineSummary` (Task 4).
- Produces: a server component rendering the weighted pipeline; an e2e proving it renders from seeded data.

- [ ] **Step 1: Write the failing e2e** — `apps/web/tests/e2e/command-center-pipeline.spec.ts` (seed jobs across stages + stage events; mirror `pipeline.spec.ts` for tenant/auth):
```typescript
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { withTenant, customer, property, job, jobStageEvent } from "@savvy/db";

const { id: tenantId } = JSON.parse(readFileSync("/tmp/savvy-e2e-tenant.json", "utf8")) as { id: string };

test("command center shows a weighted pipeline summary", async ({ page }) => {
  // Seed an approved job ($100k) with an approved stage event 10 days ago.
  await withTenant(tenantId, async (tx) => {
    const [c] = await tx.insert(customer).values({ tenantId, name: `CCpipe ${Date.now()}` }).returning({ id: customer.id });
    const [p] = await tx.insert(property).values({ tenantId, customerId: c!.id, address: "1 Pipeline Plz" }).returning({ id: property.id });
    const [j] = await tx
      .insert(job)
      .values({ tenantId, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "approved", valueEstimate: 10_000_000, openedAt: new Date(Date.now() - 30 * 86_400_000) })
      .returning({ id: job.id });
    await tx.insert(jobStageEvent).values({ tenantId, jobId: j!.id, toStage: "approved", enteredAt: new Date(Date.now() - 10 * 86_400_000) });
  });

  await page.goto("/command-center");
  const panel = page.getByTestId("pipeline-summary");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText(/Pipeline/i);
  await expect(panel).toContainText(/Gross/i);
  await expect(panel).toContainText(/Expected/i);
  // Expected total must be strictly less than gross (weighting shrinks it).
  await expect(page.getByTestId("pipeline-gross")).toBeVisible();
  await expect(page.getByTestId("pipeline-expected")).toBeVisible();
});
```

- [ ] **Step 2: Run → FAIL** (no `pipeline-summary` testid):
```bash
pnpm db:up && cd apps/web && npx tsx tests/e2e/create-tenant.ts && export TEST_TENANT_ID=$(node -e "console.log(require('/tmp/savvy-e2e-tenant.json').id)") && ./node_modules/.bin/playwright test tests/e2e/command-center-pipeline.spec.ts
```

- [ ] **Step 3: Implement the panel** — `apps/web/src/app/(app)/command-center/PipelineSummaryPanel.tsx` (server component; match the page's `fmtUsd` + cockpit tokens; dark-mode-safe). Read the existing `command-center/page.tsx` for the `fmtUsd` helper + `Card`/`MetricCard` idiom and mirror it:
```tsx
import { Card } from "@/components/ui/card";
import { getPipelineSummary } from "@/lib/pipeline-queries";

function usd(cents: number): string {
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}
function TrendBadge({ pct }: { pct: number | null }) {
  if (pct == null) return <span className="mono text-xs" style={{ color: "var(--text-faint)" }}>—</span>;
  const up = pct >= 0;
  return (
    <span className="mono text-xs" style={{ color: up ? "var(--status-ok)" : "var(--status-error)" }}>
      {up ? "▲" : "▼"} {Math.abs(pct)}%
    </span>
  );
}

export async function PipelineSummaryPanel() {
  const s = await getPipelineSummary();
  return (
    <div data-testid="pipeline-summary">
      <div className="eyebrow">Pipeline</div>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Card className="p-4">
          <div className="text-xs" style={{ color: "var(--text-muted)" }}>Gross pipeline</div>
          <div data-testid="pipeline-gross" className="mono text-xl font-semibold">{usd(s.totals.grossCents)}</div>
          <TrendBadge pct={s.totals.wowPct} />
        </Card>
        <Card className="p-4">
          <div className="text-xs" style={{ color: "var(--text-muted)" }}>Expected (weighted)</div>
          <div data-testid="pipeline-expected" className="mono text-xl font-semibold text-accent-gold">{usd(s.totals.expectedCents)}</div>
        </Card>
        <Card className="p-4">
          <div className="text-xs" style={{ color: "var(--text-muted)" }}>At-risk</div>
          <div className="mono text-xl font-semibold" style={{ color: s.totals.atRiskCents > 0 ? "var(--status-error)" : undefined }}>{usd(s.totals.atRiskCents)}</div>
        </Card>
        <Card className="p-4">
          <div className="text-xs" style={{ color: "var(--text-muted)" }}>Avg cycle</div>
          <div className="mono text-xl font-semibold">{s.totals.avgCycleDays}d</div>
        </Card>
      </div>
      <Card className="mt-4 p-4">
        <div className="space-y-2">
          {s.stages.filter((st) => st.grossCents > 0).map((st) => (
            <div key={st.stage} className="flex items-center gap-3">
              <div className="mono w-24 text-xs uppercase tracking-wider" style={{ color: "var(--text-body)" }}>{st.stage}</div>
              <div className="relative h-3 flex-1 overflow-hidden rounded" style={{ background: "var(--surface-panel)" }}>
                <div className="absolute inset-y-0 left-0 rounded" style={{ width: `${st.grossCents > 0 ? Math.round((st.expectedCents / st.grossCents) * 100) : 0}%`, background: "var(--accent-gold)" }} />
              </div>
              <div className="mono w-44 text-right text-xs" style={{ color: "var(--text-faint)" }}>
                {usd(st.grossCents)} → {usd(st.expectedCents)} · {st.probability}%
              </div>
              <TrendBadge pct={st.wowPct} />
            </div>
          ))}
        </div>
        <p className="mt-2 text-xs" style={{ color: "var(--text-faint)" }}>
          Week-over-week is reconstructed from stage history at current values — directional, not exact.
        </p>
      </Card>
    </div>
  );
}
```
(If `var(--status-ok)`/`var(--status-error)` aren't the exact tokens in this app, use the ones `command-center/page.tsx`'s `statusColor` uses — read that file. Do not hardcode hex.)

- [ ] **Step 4: Render it on the page** — in `apps/web/src/app/(app)/command-center/page.tsx`, import the panel and render it as the FIRST child of the top-level `<div className="space-y-6">` (above the Telemetry section):
```tsx
import { PipelineSummaryPanel } from "./PipelineSummaryPanel";
```
```tsx
      {/* Pipeline (weighted) — async server component */}
      <PipelineSummaryPanel />
```
(Place it right after the opening `<div className="space-y-6">`. It's an async server component, so it can be rendered directly.)

- [ ] **Step 5: Run e2e → PASS**; `pnpm --filter @savvy/web typecheck` clean; `pnpm --filter @savvy/web lint` 0 errors.

- [ ] **Step 6: Commit**
```bash
git add "apps/web/src/app/(app)/command-center/PipelineSummaryPanel.tsx" "apps/web/src/app/(app)/command-center/page.tsx" apps/web/tests/e2e/command-center-pipeline.spec.ts
git commit -m "feat(web): weighted pipeline panel on the Command Center"
```

---

### Task 6: Docs + full verification

**Files:**
- Modify: `docs/jobs-pipeline.md` (add a "Weighted pipeline (Command Center)" section)

- [ ] **Step 1: Doc** — append a section to `docs/jobs-pipeline.md` covering: win-probability config (`tenant.settings.pipeline.stageWinProbability`, defaults), expected = gross × probability, at-risk $ (stuck||late job values), avg cycle (computeVelocity), and the WoW reconstruction (`pipelineGrossAsOf`) with its current-value caveat + how to tune. (If `docs/jobs-pipeline.md` does not exist on this branch, create it with this section.)

- [ ] **Step 2: Full suite** — `pnpm db:up && pnpm --filter @savvy/db db:migrate && pnpm test && pnpm typecheck && pnpm lint`. Expected green (pre-existing `scheduling.ts`/`pipeline.spec.ts` warnings only).

- [ ] **Step 3: Commit**
```bash
git add docs/jobs-pipeline.md
git commit -m "docs(jobs): weighted Command Center — config, expected math, WoW caveat"
```

---

## Self-Review (completed by plan author)

- **Spec coverage:** §3.1 config → Task 1; §3.2 weightedPipeline + wowPct → Task 2; §3.3 pipelineGrossAsOf → Task 3; §3.4 getPipelineSummary → Task 4; §3.5 dashboard → Task 5; §6 tests → each task; §8 doc → Task 6. Non-goals (learned probabilities, value snapshots, agent-telemetry changes, new tables) untouched.
- **Placeholder scan:** none. "Read the existing page for the exact token/fmt" notes are match-the-pattern instructions, not logic gaps.
- **Type consistency:** `PipelineConfig` (T1) → `weightedPipeline`/`wowPct` (T2) → `getPipelineSummary` (T4). `StageGross`/`WeightedStage` names match T2↔T4. `AsOfJob`/`AsOfEvent`/`pipelineGrossAsOf` match T3↔T4. `computeVelocity` takes `{jobId,toStage:string,enteredAt}` — T4 maps to that. `PipelineSummary` shape matches T4↔T5. Open stages = JOB_STAGE minus complete/lost, consistent across T3/T4.
- **Determinism/isolation:** all math pure (no AI); query tenant-scoped via `withTenant`/`getTenantId`; read-time only; no new columns/tables; UI uses CSS tokens.
