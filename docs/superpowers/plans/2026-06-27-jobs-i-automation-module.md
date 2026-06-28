# Jobs I — Job Automation module (cockpit): Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only **Automation** module to the job cockpit that summarizes how autonomous a job is (an autonomy %, a "needs you" count, and a per-agent breakdown), derived from the job's existing `job_task` rows.

**Architecture:** A pure `summarizeJobAutomation(tasks)` in `@savvy/core` (co-located with the existing agent-activity rollups, reusing `AGENT`/`AGENT_LABELS`) computes the summary. The cockpit page computes it server-side from the job-task rows it already loads and renders a presentational `AutomationModule` reusing the existing `AgentAvatar`/`resolveAgent` persona system. No DB change.

**Tech Stack:** TypeScript, Next.js App Router (server component), Vitest (core), Playwright (web e2e). pnpm + Turborepo. Branches off `main` (D2a #60 + D2c #61 merged).

## Global Constraints

- **No schema change / no migration** — the module reads existing `job_task` columns (`ownerAgent`, `automationLevel`, `status`).
- **Read-only** — `automationLevel` is display-only at runtime today (no agent gates on it); do NOT add an editing control (that needs the future C/orchestration slice).
- **Autonomy weighting:** `full = 1.0`, `partial = 0.5`, `manual = 0`; `autonomyPct = round(Σweight / total × 100)`; `0` when no tasks.
- **"Needs you":** `status !== "done" && level !== "full"`.
- **Per-agent breakdown** iterates the canonical `AGENT` order; includes only agents that own ≥1 task on the job. Tasks with a null `ownerAgent` still count in the overall totals but are not in `byAgent`.
- **Pure logic lives in `@savvy/core`** (apps/web is NOT in the vitest workspace — web is verified by Playwright e2e only).
- **No `.js` extensions** in core/web source imports.
- Definition of done: `pnpm test && pnpm typecheck && pnpm lint` green; PR off `main` via `gh pr create --base main`.

---

## File Structure

**Modify:**
- `packages/core/src/agent-activity.ts` — add `JobTaskLite`, `JobAutomationSummary`, `AgentAutomation` types + `summarizeJobAutomation`.
- `packages/core/src/agent-activity.test.ts` — tests for `summarizeJobAutomation`.
- `apps/web/src/app/(app)/jobs/[id]/page.tsx` — compute the summary from the existing `taskRows`, render the module.
- `docs/jobs-pipeline.md` — Automation module note.

**Create:**
- `apps/web/src/app/(app)/jobs/[id]/AutomationModule.tsx` — presentational cockpit card.
- `apps/web/tests/e2e/automation-module.spec.ts` — e2e.

---

## Task 1: Core — `summarizeJobAutomation`

**Files:**
- Modify: `packages/core/src/agent-activity.ts`
- Test: `packages/core/src/agent-activity.test.ts`

**Interfaces:**
- Consumes: `AGENT`, `AGENT_LABELS`, `type Agent` (already in this file).
- Produces:
  - `type JobTaskLite = { ownerAgent: Agent | null; automationLevel: string | null; status: string }`
  - `type AgentAutomation = { agent: Agent; label: string; total: number; full: number; partial: number; manual: number }`
  - `type JobAutomationSummary = { total: number; full: number; partial: number; manual: number; autonomyPct: number; needsYouCount: number; byAgent: AgentAutomation[] }`
  - `summarizeJobAutomation(tasks: JobTaskLite[]): JobAutomationSummary`

- [ ] **Step 1: Write the failing test**

Append to `packages/core/src/agent-activity.test.ts` (add `summarizeJobAutomation` and `type JobTaskLite` to the existing import from `./agent-activity`):

```typescript
describe("summarizeJobAutomation", () => {
  const tasks: JobTaskLite[] = [
    { ownerAgent: "comms", automationLevel: "full", status: "done" },
    { ownerAgent: "comms", automationLevel: "full", status: "pending" },
    { ownerAgent: "scheduling", automationLevel: "partial", status: "pending" },
    { ownerAgent: "finance", automationLevel: "manual", status: "pending" },
    { ownerAgent: null, automationLevel: "manual", status: "done" },
  ];

  it("counts levels and computes a weighted autonomy percentage", () => {
    const s = summarizeJobAutomation(tasks);
    expect(s.total).toBe(5);
    expect(s.full).toBe(2);
    expect(s.partial).toBe(1);
    expect(s.manual).toBe(2);
    // weighted = 2*1 + 1*0.5 + 2*0 = 2.5 ; 2.5/5 = 50%
    expect(s.autonomyPct).toBe(50);
  });

  it("counts needs-you as non-done, non-full tasks", () => {
    // pending partial (scheduling) + pending manual (finance) = 2; the pending full and the done tasks are excluded
    expect(summarizeJobAutomation(tasks).needsYouCount).toBe(2);
  });

  it("breaks down by agent in AGENT order, only for agents that own a task", () => {
    const s = summarizeJobAutomation(tasks);
    expect(s.byAgent.map((a) => a.agent)).toEqual(["comms", "scheduling", "finance"]);
    const comms = s.byAgent.find((a) => a.agent === "comms")!;
    expect(comms).toEqual({ agent: "comms", label: "Comms", total: 2, full: 2, partial: 0, manual: 0 });
  });

  it("treats null/unknown automationLevel as manual", () => {
    const s = summarizeJobAutomation([{ ownerAgent: "comms", automationLevel: null, status: "pending" }]);
    expect(s.manual).toBe(1);
    expect(s.autonomyPct).toBe(0);
  });

  it("is all-zero for no tasks", () => {
    expect(summarizeJobAutomation([])).toEqual({
      total: 0, full: 0, partial: 0, manual: 0, autonomyPct: 0, needsYouCount: 0, byAgent: [],
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @savvy/core exec vitest run src/agent-activity.test.ts`
Expected: FAIL — `summarizeJobAutomation` not exported.

- [ ] **Step 3: Implement**

Append to `packages/core/src/agent-activity.ts`:

```typescript
/** A job_task reduced to what the automation summary needs. */
export type JobTaskLite = {
  ownerAgent: Agent | null;
  automationLevel: string | null;
  status: string;
};

export type AgentAutomation = {
  agent: Agent;
  label: string;
  total: number;
  full: number;
  partial: number;
  manual: number;
};

export type JobAutomationSummary = {
  total: number;
  full: number;
  partial: number;
  manual: number;
  autonomyPct: number;
  needsYouCount: number;
  byAgent: AgentAutomation[];
};

/** Normalize a stored automation level; anything unrecognized (incl. null) is "manual". */
function normLevel(level: string | null): "full" | "partial" | "manual" {
  return level === "full" || level === "partial" ? level : "manual";
}

/**
 * Summarize a job's CONFIGURED autonomy from its task rows (not runtime telemetry).
 * Weighted autonomy: full=1, partial=0.5, manual=0. "Needs you" = not-done, not-full.
 */
export function summarizeJobAutomation(tasks: JobTaskLite[]): JobAutomationSummary {
  const levels = tasks.map((t) => normLevel(t.automationLevel));
  const full = levels.filter((l) => l === "full").length;
  const partial = levels.filter((l) => l === "partial").length;
  const manual = levels.filter((l) => l === "manual").length;
  const total = tasks.length;
  const autonomyPct = total ? Math.round(((full + partial * 0.5) / total) * 100) : 0;
  const needsYouCount = tasks.filter((t) => t.status !== "done" && normLevel(t.automationLevel) !== "full").length;

  const byAgent: AgentAutomation[] = AGENT.map((agent) => {
    const mine = tasks.filter((t) => t.ownerAgent === agent);
    const lv = mine.map((t) => normLevel(t.automationLevel));
    return {
      agent,
      label: AGENT_LABELS[agent],
      total: mine.length,
      full: lv.filter((l) => l === "full").length,
      partial: lv.filter((l) => l === "partial").length,
      manual: lv.filter((l) => l === "manual").length,
    };
  }).filter((a) => a.total > 0);

  return { total, full, partial, manual, autonomyPct, needsYouCount, byAgent };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @savvy/core exec vitest run src/agent-activity.test.ts`
Expected: PASS (new cases + the existing agent-activity cases).

- [ ] **Step 5: Typecheck core**

Run: `pnpm --filter @savvy/core typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/agent-activity.ts packages/core/src/agent-activity.test.ts
git commit -m "feat(core): summarizeJobAutomation (configured autonomy rollup for the cockpit)"
```

---

## Task 2: Web — `AutomationModule` on the cockpit + e2e

**Files:**
- Create: `apps/web/src/app/(app)/jobs/[id]/AutomationModule.tsx`
- Modify: `apps/web/src/app/(app)/jobs/[id]/page.tsx`
- Test: `apps/web/tests/e2e/automation-module.spec.ts`

**Interfaces:**
- Consumes: `summarizeJobAutomation`, `type JobAutomationSummary` from `@savvy/core`; the existing `taskRows` in `page.tsx` (already selects `ownerAgent`, `automationLevel`, `status`); `AgentAvatar`, `resolveAgent`, `Card`/`CardHeader`/`CardTitle`/`CardContent`.

- [ ] **Step 1: Build the presentational module**

Create `apps/web/src/app/(app)/jobs/[id]/AutomationModule.tsx`:

```tsx
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { AgentAvatar } from "@/components/cockpit/AgentAvatar";
import { resolveAgent } from "@/lib/agents";
import type { JobAutomationSummary } from "@savvy/core";

export function AutomationModule({ summary }: { summary: JobAutomationSummary }) {
  return (
    <Card data-testid="automation-module">
      <CardHeader><CardTitle>Automation</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <div className="mono text-3xl font-semibold text-accent-gold" data-testid="autonomy-pct">{summary.autonomyPct}%</div>
            <div className="text-xs" style={{ color: "var(--text-faint)" }}>
              {summary.full + summary.partial} of {summary.total} tasks set to automate
            </div>
          </div>
          <div className="text-right">
            <div className="mono text-lg font-semibold" data-testid="needs-you-count">{summary.needsYouCount}</div>
            <div className="text-xs" style={{ color: "var(--text-faint)" }}>need you</div>
          </div>
        </div>

        {summary.byAgent.length > 0 && (
          <div className="space-y-2">
            {summary.byAgent.map((a) => {
              const { persona } = resolveAgent({ agent: a.agent });
              return (
                <div key={a.agent} className="flex items-center justify-between text-sm" data-testid="automation-agent-row">
                  <span className="flex items-center gap-2">
                    <AgentAvatar persona={persona} size="sm" />
                    <span style={{ color: "var(--text-muted)" }}>{a.label}</span>
                  </span>
                  <span className="mono text-xs" style={{ color: "var(--text-faint)" }}>
                    {a.full} full · {a.partial} partial · {a.manual} manual
                  </span>
                </div>
              );
            })}
          </div>
        )}

        {summary.total === 0 && (
          <p className="text-sm" style={{ color: "var(--text-faint)" }}>No tasks yet.</p>
        )}
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 2: Wire it into the cockpit page**

In `apps/web/src/app/(app)/jobs/[id]/page.tsx`:

1. Add imports (near the other cockpit imports):
   ```typescript
   import { summarizeJobAutomation } from "@savvy/core";
   import { AutomationModule } from "./AutomationModule";
   ```
   (`summarizeJobAutomation` can join an existing `@savvy/core` import line if one imports from `"@savvy/core"`.)

2. After `taskRows` is fetched (the `tx.select({...}).from(jobTask)...` block), compute the summary. The cleanest place is wherever the page already derives view data from `taskRows` (e.g. where `tasksByPhase` is built). Add:
   ```typescript
   const automationSummary = summarizeJobAutomation(
     taskRows.map((t) => ({ ownerAgent: t.ownerAgent, automationLevel: t.automationLevel, status: t.status })),
   );
   ```
   Thread `automationSummary` out to the render scope the same way `tasksByPhase` is (if the data is assembled inside a `withTenant`/loader function and returned as an object, add `automationSummary` to that returned object and destructure it where the component renders).

3. Render the module immediately AFTER the `job-margin` `</Card>` (and before `<JobTabs .../>`):
   ```tsx
   <AutomationModule summary={automationSummary} />
   ```

- [ ] **Step 3: Typecheck + lint**

Run: `pnpm --filter web typecheck && pnpm --filter web lint`
Expected: clean / no new errors (remove any unused import).

- [ ] **Step 4: Write the e2e**

Create `apps/web/tests/e2e/automation-module.spec.ts`:

```typescript
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { adminDb, customer, property, job, jobTask } from "@savvy/db";

const { id: tenantId } = JSON.parse(readFileSync("/tmp/savvy-e2e-tenant.json", "utf8")) as { id: string };

test("automation module: shows autonomy %, needs-you, and per-agent rows", async ({ page }) => {
  const stamp = randomUUID().slice(0, 8);
  const [cust] = await adminDb.insert(customer).values({ tenantId, name: `Auto ${stamp}`, email: `auto-${stamp}@e2e.test` }).returning();
  const [prop] = await adminDb.insert(property).values({ tenantId, customerId: cust!.id, address: `${stamp} Auto Way` }).returning();
  const [j] = await adminDb.insert(job).values({ tenantId, customerId: cust!.id, propertyId: prop!.id, type: "retail", stage: "production" }).returning();
  const jobId = j!.id;
  // 2 full (1 done, 1 pending) + 1 partial pending + 1 manual pending => autonomy 50%, needs-you 2
  await adminDb.insert(jobTask).values([
    { tenantId, jobId, key: "t1", title: "Send welcome", ownerAgent: "comms", automationLevel: "full", status: "done" },
    { tenantId, jobId, key: "t2", title: "Follow up", ownerAgent: "comms", automationLevel: "full", status: "pending" },
    { tenantId, jobId, key: "t3", title: "Book crew", ownerAgent: "scheduling", automationLevel: "partial", status: "pending" },
    { tenantId, jobId, key: "t4", title: "Collect deposit", ownerAgent: "finance", automationLevel: "manual", status: "pending" },
  ]);

  await page.goto(`/jobs/${jobId}`);
  await expect(page.getByTestId("automation-module")).toBeVisible();
  await expect(page.getByTestId("autonomy-pct")).toHaveText("50%");
  await expect(page.getByTestId("needs-you-count")).toHaveText("2");
  await expect(page.getByTestId("automation-agent-row")).toHaveCount(3);
});
```

- [ ] **Step 5: Run the e2e**

Setup: `pnpm db:up && pnpm --filter @savvy/db db:migrate`, then from `apps/web`:
```bash
npx tsx tests/e2e/create-tenant.ts
export TEST_TENANT_ID=$(node -e "console.log(require('/tmp/savvy-e2e-tenant.json').id)")
./node_modules/.bin/playwright test tests/e2e/automation-module.spec.ts
```
Expected: PASS. (Inngest `ECONNREFUSED` is benign.)

- [ ] **Step 6: Commit**

```bash
git add "apps/web/src/app/(app)/jobs/[id]/AutomationModule.tsx" "apps/web/src/app/(app)/jobs/[id]/page.tsx" apps/web/tests/e2e/automation-module.spec.ts
git commit -m "feat(web): Automation module on the job cockpit (autonomy %, needs-you, per-agent)"
```

---

## Task 3: Docs + full verification

**Files:**
- Modify: `docs/jobs-pipeline.md`

- [ ] **Step 1: Document the module**

Append to `docs/jobs-pipeline.md`:

```markdown
## Automation module (cockpit — Jobs I)

The job cockpit's **Automation** card summarizes the job's *configured* autonomy
from its `job_task` rows:

- **Autonomy %** — weighted across tasks (`full = 1`, `partial = 0.5`,
  `manual = 0`), i.e. how much of the job is set to run without a human.
- **Needs you** — count of tasks not yet `done` whose level is not `full`
  (manual/partial work still awaiting a person).
- **Per-agent breakdown** — for each of the five agents that owns a task, a
  `full / partial / manual` count with its persona avatar.

This is a read-only insight surface. `automationLevel` is not yet honored at
runtime by the agents — making it editable and enforced is the orchestration
(C) work. Logic: `summarizeJobAutomation` in `@savvy/core`.
```

- [ ] **Step 2: Full test suite**

Run: `pnpm test`
Expected: all packages green (core cases added).

- [ ] **Step 3: Typecheck + lint**

Run: `pnpm typecheck && pnpm lint`
Expected: typecheck clean; lint 0 errors.

- [ ] **Step 4: Commit**

```bash
git add docs/jobs-pipeline.md
git commit -m "docs(jobs): document the cockpit Automation module (I)"
```

- [ ] **Step 5: Open the PR**

```bash
git push -u origin jobs-i
gh pr create --base main --title "feat(jobs): I — cockpit Automation module (autonomy % + needs-you)" --body "<summary>"
```

---

## Self-Review notes

- **Spec coverage:** autonomy % + caption → Task 1 (`autonomyPct`) + Task 2 (render). Needs-you → Task 1 (`needsYouCount`) + Task 2. Per-agent breakdown → Task 1 (`byAgent`) + Task 2 (rows w/ AgentAvatar). Read-only (no editing) → honored; no action writes automationLevel. No schema change → confirmed (no db task).
- **Reuse over rebuild:** `summarizeJobAutomation` is added to the existing `agent-activity.ts`, reusing `AGENT`/`AGENT_LABELS`; the module reuses `AgentAvatar`/`resolveAgent`. No duplicate persona/label tables.
- **Type consistency:** `JobAutomationSummary`/`JobTaskLite` defined in Task 1, consumed by Task 2 with identical names. `summarizeJobAutomation(tasks)` signature identical at def and call.
- **Test tier:** pure logic in core (vitest); web verified by e2e only (apps/web not in the vitest workspace).
