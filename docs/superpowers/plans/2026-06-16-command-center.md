# Command Center Screen — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A read-only `/command-center` screen that makes the agent layer visible — live agent-activity feed + per-agent coverage cards + headline automation stats, rendered from real `agent_run` data.

**Architecture:** Pure rollup functions in `@savvy/core` (mirrors `computeVelocity`/`summarizeRepPerformance`); tenant-scoped queries in `apps/web/src/lib/command-center-queries.ts` (mirrors `dashboard-queries.ts`); a `force-dynamic` server page mirroring the dashboard page; one nav link. No schema change.

**Tech Stack:** Next.js App Router (server components), Drizzle (RLS), Vitest, Playwright.

---

### Task 1: Pure agent-activity rollups (`@savvy/core`)

**Files:**
- Create: `packages/core/src/agent-activity.ts`
- Test: `packages/core/src/agent-activity.test.ts`
- Modify: `packages/core/src/index.ts` (export)

- [ ] **Step 1: Write the failing test** `packages/core/src/agent-activity.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { summarizeAgentCoverage, summarizeAutomationStats, AGENT_LABELS } from "./agent-activity";

const now = new Date("2026-06-16T12:00:00Z");
const h = (n: number) => new Date(now.getTime() - n * 3_600_000); // n hours ago

const rows = [
  { agent: "finance" as const, status: "ok", modelUsed: null, costCents: 0, startedAt: h(1) },
  { agent: "finance" as const, status: "skipped", modelUsed: null, costCents: null, startedAt: h(2) },
  { agent: "comms" as const, status: "ok", modelUsed: "claude-haiku-4-5", costCents: 12, startedAt: h(3) },
  { agent: "comms" as const, status: "error", modelUsed: "claude-haiku-4-5", costCents: 5, startedAt: h(30) },
];

describe("summarizeAgentCoverage", () => {
  it("returns one entry per agent (all five), with counts and last-run", () => {
    const cov = summarizeAgentCoverage(rows, now);
    expect(cov.map((c) => c.agent)).toEqual(["orchestrator", "comms", "scheduling", "finance", "claims"]);
    const finance = cov.find((c) => c.agent === "finance")!;
    expect(finance).toMatchObject({ total: 2, ok: 1, skipped: 1, error: 0, label: "Finance" });
    expect(finance.lastRunAt).toEqual(h(1));
    const comms = cov.find((c) => c.agent === "comms")!;
    expect(comms).toMatchObject({ total: 2, ok: 1, error: 1 });
    const sched = cov.find((c) => c.agent === "scheduling")!;
    expect(sched).toMatchObject({ total: 0, lastRunAt: null });
  });
});

describe("summarizeAutomationStats", () => {
  it("counts 24h actions, AI vs deterministic, spend, error rate", () => {
    const s = summarizeAutomationStats(rows, now);
    expect(s.last24h).toBe(3);                 // the h(30) row is outside 24h
    expect(s.aiRuns).toBe(2);                  // modelUsed set
    expect(s.deterministicRuns).toBe(2);       // modelUsed null
    expect(s.spendCents).toBe(17);             // 0+0+12+5
    expect(s.errorRate).toBeCloseTo(0.25);     // 1 error / 4 runs
    expect(s.activeAgents).toBe(2);            // finance + comms
  });
});

it("AGENT_LABELS covers all five agents", () => {
  expect(Object.keys(AGENT_LABELS).sort()).toEqual(["claims", "comms", "finance", "orchestrator", "scheduling"]);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @savvy/core test -- agent-activity`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement** `packages/core/src/agent-activity.ts`:
```ts
import { AGENT, type Agent } from "./enums";

export const AGENT_LABELS: Record<Agent, string> = {
  orchestrator: "Orchestrator",
  comms: "Comms",
  scheduling: "Scheduling",
  finance: "Finance",
  claims: "Claims",
};

/** The minimal shape both rollups need from an agent_run row. */
export type AgentRunLite = {
  agent: Agent;
  status: string;
  modelUsed: string | null;
  costCents: number | null;
  startedAt: Date;
};

export type AgentCoverage = {
  agent: Agent;
  label: string;
  total: number;
  ok: number;
  error: number;
  skipped: number;
  lastRunAt: Date | null;
};

/** One entry per agent (all five, in AGENT order) so the UI always shows the full roster. */
export function summarizeAgentCoverage(rows: AgentRunLite[], _now: Date): AgentCoverage[] {
  return AGENT.map((agent) => {
    const mine = rows.filter((r) => r.agent === agent);
    let last: Date | null = null;
    for (const r of mine) if (!last || r.startedAt > last) last = r.startedAt;
    return {
      agent,
      label: AGENT_LABELS[agent],
      total: mine.length,
      ok: mine.filter((r) => r.status === "ok").length,
      error: mine.filter((r) => r.status === "error").length,
      skipped: mine.filter((r) => r.status === "skipped").length,
      lastRunAt: last,
    };
  });
}

export type AutomationStats = {
  last24h: number;
  aiRuns: number;
  deterministicRuns: number;
  spendCents: number;
  errorRate: number;
  activeAgents: number;
};

export function summarizeAutomationStats(rows: AgentRunLite[], now: Date): AutomationStats {
  const dayAgo = now.getTime() - 86_400_000;
  const aiRuns = rows.filter((r) => r.modelUsed != null).length;
  const errors = rows.filter((r) => r.status === "error").length;
  return {
    last24h: rows.filter((r) => r.startedAt.getTime() >= dayAgo).length,
    aiRuns,
    deterministicRuns: rows.length - aiRuns,
    spendCents: rows.reduce((sum, r) => sum + (r.costCents ?? 0), 0),
    errorRate: rows.length ? errors / rows.length : 0,
    activeAgents: new Set(rows.map((r) => r.agent)).size,
  };
}
```

Add to `packages/core/src/index.ts` (follow the existing `export * from "./..."` / `export {}` style — use whichever the file uses):
```ts
export * from "./agent-activity";
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @savvy/core test -- agent-activity`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/agent-activity.ts packages/core/src/agent-activity.test.ts packages/core/src/index.ts
git commit -m "feat(core): agent-activity rollups for the Command Center"
```

---

### Task 2: Command Center queries (`apps/web`)

**Files:**
- Create: `apps/web/src/lib/command-center-queries.ts`
- Test: `apps/web/tests/command-center-queries.test.ts`

- [ ] **Step 1: Write the failing test** `apps/web/tests/command-center-queries.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { adminDb, withTenant, eq, tenant, customer, property, job, agentRun } from "@savvy/db";
import { getAgentRunWindow, getAgentActivity } from "@/lib/command-center-queries";

async function seedTenant() {
  const [t] = await adminDb.insert(tenant).values({
    name: "CC", publicKey: `pk-${crypto.randomUUID()}`, clerkOrgId: `org-${crypto.randomUUID()}`,
  }).returning();
  const [c] = await adminDb.insert(customer).values({ tenantId: t!.id, name: "Dana Owner" }).returning();
  const [p] = await adminDb.insert(property).values({ tenantId: t!.id, customerId: c!.id, address: "1 Rd" }).returning();
  const [j] = await adminDb.insert(job).values({ tenantId: t!.id, customerId: c!.id, propertyId: p!.id }).returning();
  return { t: t!, j: j! };
}

describe("command-center-queries", () => {
  it("getAgentRunWindow returns this tenant's runs as lite rows; getAgentActivity joins customer name", async () => {
    const { t, j } = await seedTenant();
    await adminDb.insert(agentRun).values([
      { tenantId: t.id, agent: "finance", taskKey: "change-order.auto-send-invoice", status: "ok", jobId: j.id, modelUsed: null },
      { tenantId: t.id, agent: "comms", taskKey: "lead.qualify", status: "ok", modelUsed: "claude-haiku-4-5", costCents: 9 },
    ]);
    // Cross-tenant row must NOT leak.
    const { t: other } = await seedTenant();
    await adminDb.insert(agentRun).values({ tenantId: other.id, agent: "finance", taskKey: "x", status: "ok" });

    const win = await getAgentRunWindow(t.id, 30);
    expect(win.length).toBe(2);
    expect(win.every((r) => typeof r.agent === "string" && r.startedAt instanceof Date)).toBe(true);

    const feed = await getAgentActivity(t.id, 30);
    expect(feed.length).toBe(2);
    const financeRow = feed.find((r) => r.agent === "finance")!;
    expect(financeRow.target).toBe("Dana Owner");
    expect(financeRow.taskKey).toBe("change-order.auto-send-invoice");
    const commsRow = feed.find((r) => r.agent === "comms")!;
    expect(commsRow.target).toBeNull(); // no jobId
  });
});
```
(These queries take an explicit `tenantId` param so the test can pass a seeded tenant without Clerk. The page wrappers resolve `getTenantId()` themselves — see Step 3.)

- [ ] **Step 2: Run to verify it fails**

Run (from repo root, env exported):
```
export DATABASE_URL=postgres://savvy_app:savvy_app@localhost:5432/savvy
export DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/savvy
pnpm --filter @savvy/web test -- command-center-queries
```
Expected: FAIL (module missing).

- [ ] **Step 3: Implement** `apps/web/src/lib/command-center-queries.ts`:
```ts
import { withTenant, agentRun, job, customer, desc, eq, gte, sql } from "@savvy/db";
import type { AgentRunLite } from "@savvy/core";
import { getTenantId } from "./tenant";

/** Lite rows for the pure rollups (coverage + stats), within a trailing N-day window. */
export async function getAgentRunWindow(tenantId: string, days: number): Promise<AgentRunLite[]> {
  const since = new Date(Date.now() - days * 86_400_000);
  const rows = await withTenant(tenantId, (tx) =>
    tx.select({
      agent: agentRun.agent, status: agentRun.status, modelUsed: agentRun.modelUsed,
      costCents: agentRun.costCents, startedAt: agentRun.startedAt,
    }).from(agentRun).where(gte(agentRun.startedAt, since)),
  );
  return rows;
}

export type ActivityRow = {
  id: string; agent: string; taskKey: string | null; status: string;
  modelUsed: string | null; startedAt: Date; target: string | null;
};

/** Detailed feed: newest runs joined to the customer name (via job) for a readable target. */
export async function getAgentActivity(tenantId: string, limit: number): Promise<ActivityRow[]> {
  const rows = await withTenant(tenantId, (tx) =>
    tx.select({
      id: agentRun.id, agent: agentRun.agent, taskKey: agentRun.taskKey, status: agentRun.status,
      modelUsed: agentRun.modelUsed, startedAt: agentRun.startedAt, target: customer.name,
    })
      .from(agentRun)
      .leftJoin(job, eq(job.id, agentRun.jobId))
      .leftJoin(customer, eq(customer.id, job.customerId))
      .orderBy(desc(agentRun.startedAt))
      .limit(limit),
  );
  return rows;
}

// Page-facing wrappers (resolve the active tenant from Clerk/TEST_MODE).
export async function loadAgentRunWindow(days = 30) { return getAgentRunWindow(await getTenantId(), days); }
export async function loadAgentActivity(limit = 30) { return getAgentActivity(await getTenantId(), limit); }
```
Note: if `gte`/`sql` are not already re-exported by `@savvy/db`, remove `sql` (unused) and confirm `gte` is exported — it is a drizzle operator re-exported alongside `eq`/`desc`/`count`. If `gte` is missing from the `@savvy/db` barrel, add `gte` to its drizzle-orm re-export line.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @savvy/web test -- command-center-queries`
Expected: PASS (2 runs returned, cross-tenant excluded, join yields "Dana Owner").

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/command-center-queries.ts apps/web/tests/command-center-queries.test.ts packages/db/src/index.ts
git commit -m "feat(web): Command Center queries (agent activity feed + window)"
```
(Include `packages/db/src/index.ts` only if you had to add `gte` to the barrel.)

---

### Task 3: Command Center page + nav link

**Files:**
- Create: `apps/web/src/app/(app)/command-center/page.tsx`
- Modify: `apps/web/src/app/(app)/layout.tsx` (add nav entry)

- [ ] **Step 1: Add the nav link.** In `apps/web/src/app/(app)/layout.tsx`, insert after the Dashboard entry:
```ts
  { href: "/command-center", label: "Command Center" },
```

- [ ] **Step 2: Implement the page** `apps/web/src/app/(app)/command-center/page.tsx`:
```tsx
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { summarizeAgentCoverage, summarizeAutomationStats } from "@savvy/core";
import { loadAgentRunWindow, loadAgentActivity } from "@/lib/command-center-queries";

export const dynamic = "force-dynamic"; // always read live, tenant-scoped data

function fmtUsd(cents: number): string {
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
}
function ago(d: Date): string {
  const mins = Math.round((Date.now() - new Date(d).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}
const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  ok: "default", running: "secondary", skipped: "outline", error: "destructive",
};

export default async function CommandCenterPage() {
  const [window, activity] = await Promise.all([loadAgentRunWindow(30), loadAgentActivity(30)]);
  const now = new Date();
  const stats = summarizeAutomationStats(window, now);
  const coverage = summarizeAgentCoverage(window, now);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Command Center</h1>
        <p className="text-sm text-muted-foreground">What your agents are doing — live from the activity log.</p>
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Card className="p-4"><div className="text-sm text-muted-foreground">Actions (24h)</div>
          <div className="text-3xl font-semibold">{stats.last24h}</div></Card>
        <Card className="p-4"><div className="text-sm text-muted-foreground">AI spend (30d)</div>
          <div className="text-3xl font-semibold">{fmtUsd(stats.spendCents)}</div></Card>
        <Card className="p-4"><div className="text-sm text-muted-foreground">Error rate</div>
          <div className="text-3xl font-semibold">{Math.round(stats.errorRate * 100)}%</div></Card>
        <Card className="p-4"><div className="text-sm text-muted-foreground">Active agents</div>
          <div className="text-3xl font-semibold">{stats.activeAgents}/5</div></Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="p-4 lg:col-span-2">
          <h2 className="font-semibold mb-3">Agent Activity</h2>
          {activity.length === 0 ? (
            <p className="text-sm text-muted-foreground">No agent activity yet — agents run automatically on events (a new lead, an approved change order, a late invoice).</p>
          ) : (
            <ul className="divide-y">
              {activity.map((r) => (
                <li key={r.id} className="flex items-center gap-3 py-2 text-sm">
                  <Badge variant="secondary" className="capitalize">{r.agent}</Badge>
                  <span className="font-medium">{r.taskKey ?? "action"}</span>
                  <span className="text-muted-foreground">{r.target ?? "—"}</span>
                  <span className="ml-auto flex items-center gap-2">
                    {r.modelUsed ? <span className="text-xs text-muted-foreground">{r.modelUsed}</span> : null}
                    <Badge variant={STATUS_VARIANT[r.status] ?? "outline"}>{r.status}</Badge>
                    <span className="text-xs text-muted-foreground w-16 text-right">{ago(r.startedAt)}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card className="p-4">
          <h2 className="font-semibold mb-3">Agent Coverage</h2>
          <ul className="space-y-2">
            {coverage.map((c) => (
              <li key={c.agent} className="flex items-center justify-between text-sm">
                <span className="flex items-center gap-2">
                  <span className={`h-2 w-2 rounded-full ${c.total === 0 ? "bg-muted-foreground/30" : c.error > 0 ? "bg-destructive" : "bg-green-500"}`} />
                  {c.label}{c.agent === "claims" ? <span className="text-xs text-muted-foreground">(deferred)</span> : null}
                </span>
                <span className="text-muted-foreground">
                  {c.total === 0 ? "—" : `${c.total} run${c.total === 1 ? "" : "s"} · ${c.lastRunAt ? ago(c.lastRunAt) : "—"}`}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}
```
Note: `window` shadows the global — that's fine in a server module, but rename to `runWindow` if lint flags `no-restricted-globals`/`no-shadow`. Verify the import paths `@/components/ui/card` and `@/components/ui/badge` exist (the dashboard page imports exactly these). `Badge` variants used: default/secondary/destructive/outline — confirm the Badge component supports them (it's the standard shadcn Badge; if `outline` is unsupported, fall back to `secondary`).

- [ ] **Step 3: Typecheck + lint the web app**

```
pnpm --filter @savvy/web typecheck
pnpm --filter @savvy/web lint
```
Both clean (0 errors). Fix any shadow/unused warnings introduced by this change.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/app/\(app\)/command-center/page.tsx apps/web/src/app/\(app\)/layout.tsx
git commit -m "feat(web): Command Center screen — agent activity feed + coverage"
```

---

### Task 4: e2e + full gate + PR

**Files:**
- Create: `apps/web/tests/e2e/command-center.spec.ts`

- [ ] **Step 1: Write the e2e** `apps/web/tests/e2e/command-center.spec.ts` (mirror an existing spec's tenant/seed setup — read `apps/web/tests/e2e/change-order.spec.ts` for the `adminDb` seed + `/tmp/savvy-e2e-tenant.json` tenant-id pattern):
```ts
import { test, expect } from "@playwright/test";
import { adminDb, agentRun } from "@savvy/db";
import { readFileSync } from "node:fs";

const tenantId = JSON.parse(readFileSync("/tmp/savvy-e2e-tenant.json", "utf8")).id as string;

test("command center shows a seeded agent run and the five agent cards", async ({ page }) => {
  await adminDb.insert(agentRun).values({
    tenantId, agent: "finance", taskKey: "change-order.auto-send-invoice", status: "ok", modelUsed: null,
  });
  await page.goto("/command-center");
  await expect(page.getByRole("heading", { name: "Command Center" })).toBeVisible();
  await expect(page.getByText("change-order.auto-send-invoice").first()).toBeVisible();
  for (const label of ["Orchestrator", "Comms", "Scheduling", "Finance", "Claims"]) {
    await expect(page.getByText(label, { exact: false }).first()).toBeVisible();
  }
});
```
Confirm the exact seed/tenant-id mechanism against `change-order.spec.ts` and match it (don't invent a new one).

- [ ] **Step 2: Sync + full gate (repo root)**

```bash
git fetch origin main
git log --oneline $(git merge-base HEAD origin/main)..origin/main   # rebase if advanced (no migration to renumber)
export DATABASE_URL=postgres://savvy_app:savvy_app@localhost:5432/savvy
export DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/savvy
pnpm typecheck && pnpm lint && pnpm test
```
Expected: typecheck clean, lint 0 errors, all tests pass (existing 201 + new core + query tests). Don't run e2e locally (slow/flaky) — let CI run it.

- [ ] **Step 3: Push + PR**

```bash
git push -u origin feat/command-center
gh pr create --base main --title "Command Center: make the agent layer visible" \
  --body "Read-only /command-center screen rendering live from agent_run: activity feed (agent · action · target · model · status · time) + per-agent coverage cards (all five; claims=deferred) + headline stats (24h actions, AI spend, error rate, active agents). Pure rollups in @savvy/core; queries mirror dashboard-queries; no schema change. Spec/plan in docs/superpowers/."
```

- [ ] **Step 4: Watch CI; merge on green**

```bash
gh pr checks --watch
gh pr merge --squash --delete-branch
```
On the Google-Fonts/geist e2e flake (whole suite 500s identically), `gh run rerun <id> --failed`.

---

## Self-review
- **Spec coverage (§6):** activity feed (Task 2/3), coverage cards for all five agents incl. claims-deferred (Task 1/3), headline stats (Task 1/3), empty state (Task 3), read-only + force-dynamic (Task 3), existing primitives only (Card/Badge). RLS isolation asserted (Task 2 cross-tenant test).
- **Placeholders:** none — full code provided.
- **Type consistency:** `AgentRunLite` defined in core (Task 1) is the exact select shape returned by `getAgentRunWindow` (Task 2) and consumed by both pure rollups (Task 1); `ActivityRow.target` (string|null) matches the leftJoin customer.name; `summarizeAutomationStats` returns `activeAgents` (used by the page card) — included in the Task 1 type and test.

## Deferred (note, don't build here)
- Capability-tier rename (`reflex`/`workhorse`/`reasoning`) — data-coupled (`AI_DRAFT_CAPABILITY` core enum + drip step configs); do as its own careful PR with aliases/migration.
- Slice 2 AI scope-drafting.
- Live auto-refresh (polling/websockets) — v1 is force-dynamic + navigation.
