# S3 HEARTBEAT Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a per-entity "heartbeat" (last-touch) chip on job/lead/pipeline cards + detail headers, and a "cold" badge when nothing has touched an entity in `COLD_DAYS`, linking to that entity's activity — all bound to real `agent_run` + human-action timestamps.

**Architecture:** A pure, unit-tested `@savvy/core` function decides the display state from timestamps; a batched tenant-scoped query computes `lastTouch` per entity (there is no `updated_at` on `job`/`lead`, so it is derived from `agent_run` + human-action tables); the **server** query that builds each board's card data attaches a serializable `heartbeat` state, and a static (no-JS) presentational component renders it. No polling — heartbeat changes on the order of hours/days and the spec says "static, no motion."

**Tech Stack:** Next.js App Router (server components compute state; the two drag-drop boards are client components fed via props), TypeScript, Drizzle (RLS via `withTenant`), Vitest (`@savvy/core`), Playwright (`apps/web` e2e), Tailwind + CSS custom properties.

## Global Constraints

- **No migration.** Uses existing indexes: `agent_run_job_idx (job_id)`, `agent_run_lead_idx (lead_id)` (Slice 0). Human-action tables are read via their existing tenant/entity indexes.
- **Honesty (spec §4):** `lastTouch` = newest of any **agent OR human** action on the entity — a human-worked entity (calls, notes) must NOT read cold just because no agent touched it. Cold = `now − lastTouch > COLD_DAYS`. Fallbacks: entity never touched → chip reads **"no activity yet"** (cold only if it was *created* more than `COLD_DAYS` ago); entity younger than `COLD_DAYS` → **no badge**. Nothing animates.
- **Tenant isolation:** every read goes through `withTenant(tenantId, …)` (RLS); no query bypasses it.
- **No hardcoded colors** — CSS custom properties only (dark-mode safe).
- **`apps/web` is Playwright-only** (no vitest) — all unit-testable logic lives in `@savvy/core`.
- Per slice: tests + `pnpm typecheck` + `pnpm lint` clean; small PR.

## Design decisions (flagged for owner review — consistent with the approved design)

1. **"Human action" sources for `lastTouch` (v1):** jobs → `agent_run` + `communication` + `appointment`; leads → `agent_run` + `lead_note` + `appointment`. These all have tenant/entity indexes. (Richer sources — `job_stage_event`, `crew_checkin`, `audit_log` — exist but `audit_log` is polymorphic/unindexed on entity; defer.)
2. **Cold is a pure elapsed-duration threshold** (`> COLD_DAYS × 24h`), timezone-independent — simpler and honest; the tenant-TZ note in the spec matters for the odometer's "today" window, not for a duration.
3. **`?lead=` activity filter is added** (symmetric with the existing `?job=`) so lead cold-badges can deep-link to `/activity?lead=<id>`. Small, reusable beyond S3.
4. **Transport = server-rendered per card, no poll.** Each board's server query attaches the computed `HeartbeatState`; the client boards render it. No provider, no `/api` route.

## File Structure

| File | Responsibility |
|------|----------------|
| `packages/core/src/heartbeat.ts` (create) | `heartbeatState()` pure fn + `mergeLastTouch()` helper + `HeartbeatState` type. |
| `packages/core/src/heartbeat.test.ts` (create) | Unit tests. |
| `packages/core/src/activity-query.ts` (modify) | Add `lead` → `leadId` to `parseActivityQuery` + `ActivityQuery`. |
| `packages/core/src/activity-query.test.ts` (modify) | `?lead=` cases. |
| `packages/core/src/index.ts` (modify) | Export `heartbeat`. |
| `packages/db/src/lifecycle/agent-run.ts` (modify) | `listAgentActivity` opts gain `leadId` filter. |
| `apps/web/src/lib/heartbeat-queries.ts` (create) | `lastTouchForJobs` / `lastTouchForLeads` batched, tenant-scoped. |
| `apps/web/src/lib/command-center-queries.ts` (modify) | `loadActivityPage` threads `leadId`. |
| `apps/web/src/lib/pipeline-queries.ts` (modify) | `getBoard` (jobs) + the pipeline board query attach `heartbeat` to each card; `BoardCard`/`PipelineBoardCard` gain `heartbeat`. |
| `apps/web/src/components/heartbeat/Heartbeat.tsx` (create) | Static chip + cold badge (deep-link). |
| `apps/web/src/app/(app)/jobs/board.tsx` (modify) | Render `<Heartbeat>` in `JobCard`. |
| `apps/web/src/app/(app)/leads/page.tsx` (modify) | Compute + render `<Heartbeat>` in the lead row (server component). |
| `apps/web/src/app/(app)/pipeline/PipelineBoard.tsx` (modify) | Render `<Heartbeat>` in the pipeline card. |
| `apps/web/src/app/(app)/jobs/[id]/page.tsx` (modify) | Compute + render `<Heartbeat>` in the detail header. |
| `apps/web/src/app/(app)/leads/[id]/page.tsx` (modify) | Compute + render `<Heartbeat>` in the detail header. |
| `apps/web/tests/e2e/heartbeat.spec.ts` (create) | e2e: cold badge appears/links; fresh entity none; touched shows relative time. |

---

### Task 1: `@savvy/core` — `heartbeatState` + `mergeLastTouch` (pure)

**Files:**
- Create: `packages/core/src/heartbeat.ts`, `packages/core/src/heartbeat.test.ts`
- Modify: `packages/core/src/index.ts` (add `export * from "./heartbeat";`)

**Interfaces produced:**
- `interface HeartbeatState { hasActivity: boolean; label: string; cold: boolean; }`
- `function heartbeatState(lastTouch: Date | null, createdAt: Date, now: Date, coldDays: number): HeartbeatState`
- `function mergeLastTouch(sources: ReadonlyArray<ReadonlyArray<{ id: string; ts: Date }>>): Map<string, Date>`

- [ ] **Step 1: Write the failing test** — `packages/core/src/heartbeat.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { heartbeatState, mergeLastTouch } from "./heartbeat";

const now = new Date("2026-07-11T12:00:00Z");
const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000);
const hoursAgo = (n: number) => new Date(now.getTime() - n * 3_600_000);

describe("heartbeatState", () => {
  it("never touched, created recently → 'no activity yet', not cold", () => {
    expect(heartbeatState(null, daysAgo(2), now, 7)).toEqual({ hasActivity: false, label: "no activity yet", cold: false });
  });

  it("never touched, created long ago → 'no activity yet', COLD", () => {
    expect(heartbeatState(null, daysAgo(9), now, 7)).toEqual({ hasActivity: false, label: "no activity yet", cold: true });
  });

  it("recently touched → relative label, not cold", () => {
    expect(heartbeatState(hoursAgo(3), daysAgo(30), now, 7)).toEqual({ hasActivity: true, label: "3h ago", cold: false });
  });

  it("touched long ago → relative label in days, COLD", () => {
    expect(heartbeatState(daysAgo(8), daysAgo(30), now, 7)).toEqual({ hasActivity: true, label: "8d ago", cold: true });
  });

  it("just touched → 'just now'", () => {
    expect(heartbeatState(now, daysAgo(1), now, 7).label).toBe("just now");
  });

  it("minutes granularity", () => {
    expect(heartbeatState(new Date(now.getTime() - 5 * 60000), now, now, 7).label).toBe("5m ago");
  });

  it("cold boundary is strict (> coldDays, not >=)", () => {
    expect(heartbeatState(daysAgo(7), now, now, 7).cold).toBe(false); // exactly 7d → not cold
    expect(heartbeatState(new Date(now.getTime() - (7 * 86_400_000 + 1)), now, now, 7).cold).toBe(true);
  });
});

describe("mergeLastTouch", () => {
  it("takes the max ts per id across sources, ignores empties", () => {
    const m = mergeLastTouch([
      [{ id: "a", ts: daysAgo(5) }, { id: "b", ts: daysAgo(1) }],
      [{ id: "a", ts: daysAgo(2) }], // newer for a
      [],
    ]);
    expect(m.get("a")).toEqual(daysAgo(2));
    expect(m.get("b")).toEqual(daysAgo(1));
    expect(m.size).toBe(2);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `pnpm --filter @savvy/core test -- heartbeat` → FAIL (module not found).

- [ ] **Step 3: Implement** — `packages/core/src/heartbeat.ts`:

```ts
/**
 * Presentational state for an entity's heartbeat chip + cold badge (spec §4).
 * `lastTouch` is the newest of any agent OR human action on the entity; `createdAt`
 * is the entity's own creation — the floor used for coldness when nothing has
 * touched it yet (a brand-new untouched lead isn't "cold" until COLD_DAYS after it
 * was created). Cold is a pure elapsed-duration threshold, timezone-independent.
 */
export interface HeartbeatState {
  hasActivity: boolean;
  label: string;
  cold: boolean;
}

function relTime(now: Date, then: Date): string {
  const mins = Math.max(0, Math.round((now.getTime() - then.getTime()) / 60_000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

export function heartbeatState(lastTouch: Date | null, createdAt: Date, now: Date, coldDays: number): HeartbeatState {
  const hasActivity = lastTouch !== null;
  const reference = lastTouch ?? createdAt; // cold measured from last touch, else from creation
  const cold = now.getTime() - reference.getTime() > coldDays * 86_400_000;
  return { hasActivity, label: hasActivity ? relTime(now, lastTouch as Date) : "no activity yet", cold };
}

/** Merge per-source [{id, ts}] lists into one Map<id, newest ts>. */
export function mergeLastTouch(sources: ReadonlyArray<ReadonlyArray<{ id: string; ts: Date }>>): Map<string, Date> {
  const out = new Map<string, Date>();
  for (const source of sources) {
    for (const { id, ts } of source) {
      const cur = out.get(id);
      if (!cur || ts.getTime() > cur.getTime()) out.set(id, ts);
    }
  }
  return out;
}
```

Add to `packages/core/src/index.ts` near the other showcase exports: `export * from "./heartbeat";`

- [ ] **Step 4: Run to verify it passes** — `pnpm --filter @savvy/core test -- heartbeat` → PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat(core): heartbeatState + mergeLastTouch for S3"`

---

### Task 2: Activity feed `?lead=` filter (symmetric with `?job=`)

**Files:**
- Modify: `packages/core/src/activity-query.ts`, `packages/core/src/activity-query.test.ts`
- Modify: `packages/db/src/lifecycle/agent-run.ts` (`listAgentActivity` opts + filter)
- Modify: `apps/web/src/lib/command-center-queries.ts` (`loadActivityPage` threads `leadId`)

**Interfaces:** `ActivityQuery` gains `leadId?: string`; `listAgentActivity` opts gain `leadId?: string`.

- [ ] **Step 1: Failing test** — in `packages/core/src/activity-query.test.ts`, add (mirroring the existing `job` cases):

```ts
it("parses a valid lead uuid", () => {
  const q = parseActivityQuery((k) => (k === "lead" ? "00000000-0000-0000-0000-000000000001" : null));
  expect(q.leadId).toBe("00000000-0000-0000-0000-000000000001");
});
it("drops a non-uuid lead param", () => {
  const q = parseActivityQuery((k) => (k === "lead" ? "not-a-uuid" : null));
  expect(q.leadId).toBeUndefined();
});
```

- [ ] **Step 2: Verify fail** — `pnpm --filter @savvy/core test -- activity-query` → FAIL.

- [ ] **Step 3: Implement** — in `packages/core/src/activity-query.ts`: add `leadId?: string;` to the `ActivityQuery` interface, and in the parser body (mirroring the `job`/`jobId` block using `UUID_RE`):

```ts
  const lead = get("lead");
  if (lead && UUID_RE.test(lead)) result.leadId = lead;
```

In `packages/db/src/lifecycle/agent-run.ts`, extend the `listAgentActivity` opts type (around line 120) with `leadId?: string` and add, next to the existing `if (opts.jobId) …` (around line 131):

```ts
  if (opts.leadId) conds.push(eq(agentRun.leadId, opts.leadId));
```

In `apps/web/src/lib/command-center-queries.ts`, ensure `loadActivityPage` passes `leadId` through to `listAgentActivity` (add `leadId: opts.leadId` wherever it forwards `jobId`).

- [ ] **Step 4: Verify pass + typecheck** — `pnpm --filter @savvy/core test -- activity-query` → PASS; `pnpm typecheck` → clean.
- [ ] **Step 5: Commit** — `git commit -am "feat: ?lead= filter for the activity feed"`

---

### Task 3: `lastTouchForJobs` / `lastTouchForLeads` batched queries

**Files:** Create `apps/web/src/lib/heartbeat-queries.ts`.

**Interfaces produced:**
- `lastTouchForJobs(jobIds: string[]): Promise<Map<string, Date>>`
- `lastTouchForLeads(leadIds: string[]): Promise<Map<string, Date>>`

> No vitest in apps/web; the merge logic is `mergeLastTouch` (unit-tested in Task 1). Gate = typecheck; behavior via the Task-8 e2e.

- [ ] **Step 1: Implement** — `apps/web/src/lib/heartbeat-queries.ts`:

```ts
import "server-only";
import { withTenant, agentRun, communication, appointment, leadNote, and, eq, inArray, sql } from "@savvy/db";
import { mergeLastTouch } from "@savvy/core";
import { getTenantId } from "./tenant";

type Row = { id: string | null; ts: string | null };
const clean = (rows: Row[]) => rows.filter((r): r is { id: string; ts: string } => !!r.id && !!r.ts).map((r) => ({ id: r.id, ts: new Date(r.ts) }));

/** Newest agent OR human touch per job. One grouped query per source, merged in JS. */
export async function lastTouchForJobs(jobIds: string[]): Promise<Map<string, Date>> {
  if (jobIds.length === 0) return new Map();
  const tenantId = await getTenantId();
  const [runs, comms, appts] = await Promise.all([
    withTenant(tenantId, (tx) => tx.select({ id: agentRun.jobId, ts: sql<string>`max(${agentRun.startedAt})` }).from(agentRun).where(and(eq(agentRun.tenantId, tenantId), inArray(agentRun.jobId, jobIds))).groupBy(agentRun.jobId)),
    withTenant(tenantId, (tx) => tx.select({ id: communication.jobId, ts: sql<string>`max(${communication.createdAt})` }).from(communication).where(and(eq(communication.tenantId, tenantId), inArray(communication.jobId, jobIds))).groupBy(communication.jobId)),
    withTenant(tenantId, (tx) => tx.select({ id: appointment.jobId, ts: sql<string>`max(${appointment.createdAt})` }).from(appointment).where(and(eq(appointment.tenantId, tenantId), inArray(appointment.jobId, jobIds))).groupBy(appointment.jobId)),
  ]);
  return mergeLastTouch([clean(runs as Row[]), clean(comms as Row[]), clean(appts as Row[])]);
}

/** Newest agent OR human touch per lead. */
export async function lastTouchForLeads(leadIds: string[]): Promise<Map<string, Date>> {
  if (leadIds.length === 0) return new Map();
  const tenantId = await getTenantId();
  const [runs, notes, appts] = await Promise.all([
    withTenant(tenantId, (tx) => tx.select({ id: agentRun.leadId, ts: sql<string>`max(${agentRun.startedAt})` }).from(agentRun).where(and(eq(agentRun.tenantId, tenantId), inArray(agentRun.leadId, leadIds))).groupBy(agentRun.leadId)),
    withTenant(tenantId, (tx) => tx.select({ id: leadNote.leadId, ts: sql<string>`max(${leadNote.createdAt})` }).from(leadNote).where(and(eq(leadNote.tenantId, tenantId), inArray(leadNote.leadId, leadIds))).groupBy(leadNote.leadId)),
    withTenant(tenantId, (tx) => tx.select({ id: appointment.leadId, ts: sql<string>`max(${appointment.createdAt})` }).from(appointment).where(and(eq(appointment.tenantId, tenantId), inArray(appointment.leadId, leadIds))).groupBy(appointment.leadId)),
  ]);
  return mergeLastTouch([clean(runs as Row[]), clean(notes as Row[]), clean(appts as Row[])]);
}
```

> **Implementer:** verify `communication`, `appointment`, `leadNote` are exported from the `@savvy/db` barrel (they are, via `schema/index.ts`) and that `communication.jobId`, `appointment.jobId`/`appointment.leadId`, `leadNote.leadId`, `leadNote.tenantId` exist (confirmed in `schema/comms.ts` + `schema/crm.ts`). If `leadNote` has no `tenantId` column, scope via its `leadId` inArray alone under `withTenant` (RLS still applies).

- [ ] **Step 2: Typecheck** — `pnpm --filter @savvy/web typecheck` → clean.
- [ ] **Step 3: Commit** — `git commit -am "feat(web): batched lastTouch queries for jobs + leads"`

---

### Task 4: `Heartbeat` presentational component (static)

**Files:** Create `apps/web/src/components/heartbeat/Heartbeat.tsx`.

**Interface:** `Heartbeat({ kind, id, state }: { kind: "job" | "lead"; id: string; state: HeartbeatState })`. No `"use client"` — pure render, mountable from server or client. Emits `data-testid="heartbeat"` (with `data-cold`), `heartbeat-label`, and `heartbeat-cold` (the deep-link).

- [ ] **Step 1: Implement**:

```tsx
import Link from "next/link";
import type { HeartbeatState } from "@savvy/core";

/** Static last-touch chip + optional cold badge. No animation (spec: heartbeat is
 *  static). The cold badge deep-links to the entity's activity feed. */
export function Heartbeat({ kind, id, state }: { kind: "job" | "lead"; id: string; state: HeartbeatState }) {
  return (
    <span data-testid="heartbeat" data-cold={state.cold} className="inline-flex items-center gap-1.5">
      <span className="mono text-[11px]" style={{ color: "var(--text-faint)" }} data-testid="heartbeat-label">
        {state.label}
      </span>
      {state.cold && (
        <Link
          href={`/activity?${kind}=${id}`}
          data-testid="heartbeat-cold"
          className="mono rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide"
          style={{ background: "var(--status-error-010, rgba(229,86,75,0.12))", color: "var(--status-error)" }}
        >
          cold
        </Link>
      )}
    </span>
  );
}
```

- [ ] **Step 2: Typecheck + lint** — `pnpm --filter @savvy/web typecheck && pnpm --filter @savvy/web lint` → clean.
- [ ] **Step 3: Commit** — `git commit -am "feat(web): static Heartbeat chip + cold badge component"`

---

### Task 5: Wire heartbeat into the JOB board (`getBoard` + `JobCard`)

**Files:** Modify `apps/web/src/lib/pipeline-queries.ts` (`getBoard`, `BoardCard`), `apps/web/src/app/(app)/jobs/board.tsx` (`JobCard`).

- [ ] **Step 1: Attach `heartbeat` to `BoardCard`.** In `pipeline-queries.ts`:
  - Add `createdAt` to the `job` select in `getBoard` (needed as the cold floor).
  - Add `heartbeat: HeartbeatState;` to the `BoardCard` type.
  - After building the card rows, collect all job ids, call `lastTouchForJobs(ids)`, and set `heartbeat: heartbeatState(touch.get(r.id) ?? null, new Date(r.createdAt), new Date(), SHOWCASE.COLD_DAYS)` on each card.
  - Import `heartbeatState, SHOWCASE, type HeartbeatState` from `@savvy/core` and `lastTouchForJobs` from `./heartbeat-queries`.

```ts
// in getBoard, after rows are selected (rows have r.id, r.createdAt, …):
const touch = await lastTouchForJobs(rows.map((r) => r.id));
const now = new Date();
// when mapping each row to a BoardCard, add:
heartbeat: heartbeatState(touch.get(r.id) ?? null, new Date(r.createdAt as unknown as string), now, SHOWCASE.COLD_DAYS),
```

- [ ] **Step 2: Render in `JobCard`.** In `board.tsx`, import `Heartbeat` and mount it in the footer flex row (the `flex items-center gap-1.5` at ~`:99`, beside `CardInflight`):

```tsx
<Heartbeat kind="job" id={card.id} state={card.heartbeat} />
```

- [ ] **Step 3: Typecheck + lint** → clean.
- [ ] **Step 4: Commit** — `git commit -am "feat(web): heartbeat chip + cold badge on job board cards"`

---

### Task 6: Wire heartbeat into the LEAD board (server component)

**Files:** Modify `apps/web/src/app/(app)/leads/page.tsx`.

`leads/page.tsx` is a server component — compute inline.

- [ ] **Step 1:** After the leads are loaded (the array rendered at ~`:88`), collect ids, call `lastTouchForLeads(ids)`, build a `Map<id, HeartbeatState>` with `heartbeatState(touch.get(l.id) ?? null, new Date(l.createdAt), now, SHOWCASE.COLD_DAYS)`. Ensure the lead query exposes `createdAt` (add it if missing).
- [ ] **Step 2:** In the lead row's trailing `<span className="flex items-center gap-1.5">` (~`:100`, beside `CardInflight`), render `<Heartbeat kind="lead" id={l.id} state={hbById.get(l.id)!} />`.
- [ ] **Step 3:** Imports: `Heartbeat`, `lastTouchForLeads`, `heartbeatState`, `SHOWCASE`.
- [ ] **Step 4: Typecheck + lint** → clean.
- [ ] **Step 5: Commit** — `git commit -am "feat(web): heartbeat chip + cold badge on lead rows"`

---

### Task 7: Wire heartbeat into the PIPELINE board (mixed job/lead)

**Files:** Modify `apps/web/src/lib/pipeline-queries.ts` (the pipeline board query + `PipelineBoardCard`), `apps/web/src/app/(app)/pipeline/PipelineBoard.tsx`.

The pipeline card is mixed `kind: "job" | "lead"` — compute both maps.

- [ ] **Step 1:** Add `heartbeat: HeartbeatState;` to `PipelineBoardCard`. In the pipeline board query, split card ids by kind, call `lastTouchForJobs(jobIds)` and `lastTouchForLeads(leadIds)` (in parallel), and set each card's `heartbeat` from the right map + the card's own `createdAt` (add `createdAt` to the job/lead selects if not present). Use `SHOWCASE.COLD_DAYS` + one shared `now`.
- [ ] **Step 2:** In `PipelineBoard.tsx`, render `<Heartbeat kind={c.kind} id={c.id} state={c.heartbeat} />` in the card's mono row (~`:96`, beside `CardInflight`).
- [ ] **Step 3: Typecheck + lint** → clean.
- [ ] **Step 4: Commit** — `git commit -am "feat(web): heartbeat chip + cold badge on pipeline cards"`

---

### Task 8: Detail headers + Playwright e2e

**Files:** Modify `apps/web/src/app/(app)/jobs/[id]/page.tsx`, `apps/web/src/app/(app)/leads/[id]/page.tsx`; create `apps/web/tests/e2e/heartbeat.spec.ts`.

- [ ] **Step 1: Failing e2e** — `apps/web/tests/e2e/heartbeat.spec.ts`:

```ts
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { adminDb, withTenant, customer, property, job, agentRun } from "@savvy/db";

const { id: tenantId } = JSON.parse(readFileSync("/tmp/savvy-e2e-tenant.json", "utf8")) as { id: string };

test("a job with no touch in COLD_DAYS shows a cold badge linking to its activity; a freshly-touched job does not", async ({ page }) => {
  // Cold job: created 10 days ago, no agent_run/comm/appointment.
  const { coldId, warmId } = await withTenant(tenantId, async (tx) => {
    const [c] = await tx.insert(customer).values({ tenantId, name: "Heartbeat HO" }).returning();
    const [p] = await tx.insert(property).values({ tenantId, customerId: c.id, address: "1 Heartbeat Way, Mesa AZ" }).returning();
    const old = new Date(Date.now() - 10 * 86_400_000);
    const [cold] = await tx.insert(job).values({ tenantId, customerId: c.id, propertyId: p.id, stage: "production", createdAt: old, stageEnteredAt: old }).returning();
    const [warm] = await tx.insert(job).values({ tenantId, customerId: c.id, propertyId: p.id, stage: "production" }).returning();
    return { coldId: cold.id, warmId: warm.id };
  });
  // Give the warm job a fresh agent_run touch.
  await adminDb.insert(agentRun).values({ tenantId, agent: "orchestrator", taskKey: "ops.digest", status: "ok", jobId: warmId });

  await page.goto("/jobs");
  const coldCard = page.locator(`[data-job-id="${coldId}"]`);
  const warmCard = page.locator(`[data-job-id="${warmId}"]`);

  await expect(coldCard.getByTestId("heartbeat-cold")).toBeVisible();
  await expect(coldCard.getByTestId("heartbeat-cold")).toHaveAttribute("href", `/activity?job=${coldId}`);
  await expect(coldCard.getByTestId("heartbeat-label")).toHaveText("no activity yet");

  await expect(warmCard.getByTestId("heartbeat-cold")).toHaveCount(0); // freshly touched → not cold
  await expect(warmCard.getByTestId("heartbeat-label")).not.toHaveText("no activity yet");
});
```

- [ ] **Step 2: Verify fail** (controller runs it — see run recipe below): no `heartbeat-cold` yet → FAIL.

- [ ] **Step 3: Mount on detail headers.** In `jobs/[id]/page.tsx` (server), compute `const hb = heartbeatState((await lastTouchForJobs([id])).get(id) ?? null, new Date(job.createdAt), new Date(), SHOWCASE.COLD_DAYS);` and render `<Heartbeat kind="job" id={id} state={hb} />` in the badge row (~`:413`, beside `CardInflight`). Do the same in `leads/[id]/page.tsx` with `lastTouchForLeads` in the `PageHeader right=` slot (~`:82`). Ensure each detail query exposes the entity `createdAt`.

- [ ] **Step 4: Verify e2e passes** (controller runs), then full gates `pnpm typecheck && pnpm lint`.
- [ ] **Step 5: Commit** — `git commit -am "feat(web): heartbeat on job/lead detail headers + e2e"`

**e2e run recipe (controller):** DB up on :5432; `pnpm --filter @savvy/web exec tsx tests/e2e/create-tenant.ts` (prints tenant id); then `TEST_TENANT_ID=<id> pnpm --filter @savvy/web exec playwright test tests/e2e/heartbeat.spec.ts --workers=1`. (The Playwright webServer boot has hung subagents before — the controller runs the e2e.)

---

## Self-Review

**Spec coverage (design §5 Slice 3 + §4):**
- `lastTouch = max(agent_run.startedAt) + human actions` → Task 3 (agent_run + communication/lead_note + appointment) ✅
- Chip on job/lead/pipeline cards → Tasks 5/6/7 ✅; detail headers → Task 8 ✅
- Cold badge past `COLD_DAYS`, links to `?job=` activity → Task 4 (badge) + Task 2 (`?lead=` symmetry) ✅
- Fallbacks: no-runs → "no activity yet"; young entity → no badge → Task 1 unit tests ✅
- Static (no motion) → component has no JS/animation ✅
- No migration; tenant isolation via `withTenant`; no hardcoded colors ✅

**Known limitations (documented):** human-action sources are v1-scoped (agent_run + comms/notes + appointments); `job_stage_event`/`crew_checkin`/`audit_log` deferred. Cold uses elapsed-duration (not calendar-day-in-tenant-TZ) — simpler and honest. The "no activity yet" copy and non-cold path are proven by the Task 1 unit tests; the e2e proves the cold badge + link + fresh-entity-no-badge on a real render.

**Type consistency:** `HeartbeatState` identical across Tasks 1→4→5/6/7/8; `heartbeatState(lastTouch, createdAt, now, coldDays)` and `lastTouchForJobs/Leads(ids): Promise<Map<string,Date>>` used consistently at every call site.

**Owner decisions (flag for Brett):** the 4 design decisions above (human-touch sources, duration-based cold, `?lead=` addition, server-render no-poll) — all consistent with the approved design; adjust freely.
