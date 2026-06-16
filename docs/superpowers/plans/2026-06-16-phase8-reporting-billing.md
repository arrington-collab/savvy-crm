# Phase 8 — Reporting & Billing Meters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-tenant usage metering (jobs, AI spend, AI voice minutes, storage) computed against revenue-band allowances into a monthly billing snapshot, plus velocity + rep/team reporting on the dashboard and a `/billing` page. Compute + display only (no Stripe charging).

**Architecture:** Pure `@savvy/core` for band/bill math + reporting summaries; `@savvy/db` aggregates usage and upserts `usage_snapshot`; two Inngest crons (monthly meter + daily cold-archive); voice duration captured on the Twilio call path; Next.js `/billing` page + expanded `/dashboard`.

**Tech Stack:** TypeScript, pnpm/Turborepo, Drizzle (Postgres + RLS), Inngest (v3 crons), Vitest, Playwright, Next.js App Router.

**Spec:** `docs/superpowers/specs/2026-06-16-phase8-reporting-billing-design.md`

---

## Conventions (read once)

- Run one package's tests from repo root: `pnpm test <pattern>`. Test packages: `@savvy/core`, `@savvy/db`, `@savvy/agents`, `@savvy/integrations`.
- DB env (start `docker compose up -d` first):
  ```bash
  export DATABASE_URL=postgres://savvy_app:savvy_app@localhost:5432/savvy
  export DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/savvy
  ```
- App/agent code imports tables + operators (`eq`, `and`, `sql`, `gte`, `lt`, `count`, `sum`, `isNull`) from `@savvy/db`, `z` + helpers from `@savvy/core`. No `.js` in source; `.js` in `@savvy/db` test files.
- Money = integer cents. Static gate before each commit: `pnpm typecheck && pnpm lint && pnpm test` (affected package min).
- New tenant tables get `tenantIsolation()` + the RLS isolation test (Task 9).

## File Structure

| File | Responsibility | Wave |
|------|----------------|------|
| `packages/core/src/billing-bands.ts` (new) | `BILLING_BANDS` + `BillingBand` + `getBand` | 0 |
| `packages/core/src/billing.ts` (new) | `computeBill` + `UsageTotals` | 0 |
| `packages/core/src/velocity.ts` (new) | `computeVelocity` | A |
| `packages/core/src/rep-performance.ts` (new) | `summarizeRepPerformance` | A |
| `packages/core/src/index.ts` (mod) | re-export the above | 0/A |
| `packages/db/src/schema/billing.ts` (new) | `usageSnapshot` table | 0 |
| `packages/db/src/schema/ops.ts` (mod) | `document.archivedAt` | 0 |
| `packages/db/src/schema/comms.ts` (mod) | `communication.durationSeconds` | 0 |
| `packages/db/src/schema/index.ts` (mod) | `export * from "./billing"` | 0 |
| `packages/db/drizzle/0008_*.sql` (gen) | migration | 0 |
| `packages/db/src/lifecycle/usage.ts` (new) | `computeTenantUsage`, `recordUsageSnapshot` | B |
| `packages/db/src/index.ts` (mod) | export usage helpers | B |
| `packages/agents/src/functions/meter-usage.ts` (new) | `meterUsageMonthly` cron | C |
| `packages/agents/src/functions/cold-archive.ts` (new) | `coldArchiveDocuments` cron | C |
| `packages/agents/src/index.ts` (mod) | register crons | C |
| `apps/web/src/app/api/twilio/voice/route.ts` (mod) | capture `durationSeconds` | C |
| `apps/web/src/lib/billing-queries.ts` (new) | current usage + snapshots | D |
| `apps/web/src/app/(app)/billing/*` (new) | billing page | D |
| `apps/web/src/lib/dashboard-queries.ts` (mod) | velocity + rep perf | A |
| `apps/web/src/app/(app)/dashboard/page.tsx` (mod) | velocity + rep cards | A |
| `apps/web/tests/e2e/billing.spec.ts` (new) | e2e | gate |

> **Note:** confirm the comms schema filename (`grep -rl "communication = pgTable" packages/db/src/schema`); it may be `comms.ts` or `crm.ts`. The voice channel value is `"call"` (per `COMM_CHANNEL`).

---

# Wave 0 — Foundation

## Task 1: Billing bands config

**Files:** Create `packages/core/src/billing-bands.ts`; Modify `packages/core/src/index.ts`; Test `packages/core/src/billing-bands.test.ts`

- [ ] **Step 1: Failing test:**

```ts
import { describe, it, expect } from "vitest";
import { BILLING_BANDS, getBand } from "./billing-bands";

describe("billing bands", () => {
  it("has ascending bands with all allowance + overage keys", () => {
    expect(BILLING_BANDS.length).toBeGreaterThanOrEqual(3);
    for (const b of BILLING_BANDS) {
      expect(b.allowances).toHaveProperty("jobsProcessed");
      expect(b.allowances).toHaveProperty("aiSpendCents");
      expect(b.allowances).toHaveProperty("aiVoiceMinutes");
      expect(b.allowances).toHaveProperty("storageBytes");
      expect(b.overageRates).toHaveProperty("perJobCents");
      expect(b.overageRates).toHaveProperty("perVoiceMinuteCents");
      expect(b.overageRates).toHaveProperty("perGbStorageCents");
      expect(b.overageRates).toHaveProperty("perAiSpendDollarCents");
    }
  });
  it("getBand returns the matching band, else the first (smallest)", () => {
    expect(getBand(BILLING_BANDS[1]!.key).key).toBe(BILLING_BANDS[1]!.key);
    expect(getBand(null).key).toBe(BILLING_BANDS[0]!.key);
    expect(getBand("nonexistent").key).toBe(BILLING_BANDS[0]!.key);
  });
});
```

- [ ] **Step 2:** `pnpm test billing-bands` → FAIL.
- [ ] **Step 3: Implement** `packages/core/src/billing-bands.ts`:

```ts
export interface BillingBand {
  key: string;
  name: string;
  monthlyPriceCents: number;
  allowances: { jobsProcessed: number; aiSpendCents: number; aiVoiceMinutes: number; storageBytes: number };
  overageRates: { perJobCents: number; perVoiceMinuteCents: number; perGbStorageCents: number; perAiSpendDollarCents: number };
}

const GB = 1024 ** 3;

// Platform pricing. Placeholder figures the operator tunes; revenue-band names
// map to the roofing company's annual revenue tier.
export const BILLING_BANDS: BillingBand[] = [
  { key: "starter", name: "Starter", monthlyPriceCents: 49900,
    allowances: { jobsProcessed: 50, aiSpendCents: 5000, aiVoiceMinutes: 500, storageBytes: 10 * GB },
    overageRates: { perJobCents: 500, perVoiceMinuteCents: 15, perGbStorageCents: 25, perAiSpendDollarCents: 150 } },
  { key: "growth", name: "Growth", monthlyPriceCents: 99900,
    allowances: { jobsProcessed: 150, aiSpendCents: 20000, aiVoiceMinutes: 2000, storageBytes: 50 * GB },
    overageRates: { perJobCents: 400, perVoiceMinuteCents: 12, perGbStorageCents: 20, perAiSpendDollarCents: 140 } },
  { key: "scale", name: "Scale", monthlyPriceCents: 199900,
    allowances: { jobsProcessed: 500, aiSpendCents: 75000, aiVoiceMinutes: 8000, storageBytes: 200 * GB },
    overageRates: { perJobCents: 300, perVoiceMinuteCents: 10, perGbStorageCents: 15, perAiSpendDollarCents: 130 } },
];

export function getBand(key: string | null | undefined): BillingBand {
  return BILLING_BANDS.find((b) => b.key === key) ?? BILLING_BANDS[0]!;
}
```

- [ ] **Step 4:** add `export * from "./billing-bands";` to `index.ts`; `pnpm test billing-bands` → PASS.
- [ ] **Step 5:** `git add packages/core/src/billing-bands.ts packages/core/src/billing-bands.test.ts packages/core/src/index.ts && git commit -m "feat(core): billing band config + getBand"`

## Task 2: `computeBill`

**Files:** Create `packages/core/src/billing.ts`; Modify `index.ts`; Test `packages/core/src/billing.test.ts`

- [ ] **Step 1: Failing test:**

```ts
import { describe, it, expect } from "vitest";
import { computeBill } from "./billing";
import { getBand } from "./billing-bands";

const band = getBand("starter"); // price 49900; allow {50 jobs, 5000c ai, 500 min, 10GB}
const GB = 1024 ** 3;

describe("computeBill", () => {
  it("base only when under all allowances", () => {
    const b = computeBill({ jobsProcessed: 10, aiSpendCents: 1000, aiVoiceMinutes: 100, storageBytes: GB }, band);
    expect(b.basePriceCents).toBe(49900);
    expect(b.overageTotalCents).toBe(0);
    expect(b.totalCents).toBe(49900);
  });
  it("charges per-meter overage above allowance", () => {
    const b = computeBill(
      { jobsProcessed: 60, aiSpendCents: 5300, aiVoiceMinutes: 600, storageBytes: 12 * GB }, band);
    // jobs: 10 over * 500 = 5000; voice: 100 over * 15 = 1500;
    // storage: ceil(2GB) * 25 = 50; ai: ceil(300c/100=3) * 150 = 450
    expect(b.overages).toEqual({ jobs: 5000, voice: 1500, storage: 50, aiSpend: 450 });
    expect(b.overageTotalCents).toBe(7000);
    expect(b.totalCents).toBe(49900 + 7000);
  });
});
```

- [ ] **Step 2:** `pnpm test billing.test` → FAIL.
- [ ] **Step 3: Implement** `packages/core/src/billing.ts`:

```ts
import type { BillingBand } from "./billing-bands";

export interface UsageTotals {
  jobsProcessed: number;
  aiSpendCents: number;
  aiVoiceMinutes: number;
  storageBytes: number;
}

const GB = 1024 ** 3;

export function computeBill(usage: UsageTotals, band: BillingBand): {
  basePriceCents: number;
  overages: { jobs: number; voice: number; storage: number; aiSpend: number };
  overageTotalCents: number;
  totalCents: number;
} {
  const a = band.allowances;
  const r = band.overageRates;
  const overJobs = Math.max(0, usage.jobsProcessed - a.jobsProcessed);
  const overMin = Math.max(0, usage.aiVoiceMinutes - a.aiVoiceMinutes);
  const overGb = Math.ceil(Math.max(0, usage.storageBytes - a.storageBytes) / GB);
  const overAiDollars = Math.ceil(Math.max(0, usage.aiSpendCents - a.aiSpendCents) / 100);
  const overages = {
    jobs: overJobs * r.perJobCents,
    voice: overMin * r.perVoiceMinuteCents,
    storage: overGb * r.perGbStorageCents,
    aiSpend: overAiDollars * r.perAiSpendDollarCents,
  };
  const overageTotalCents = overages.jobs + overages.voice + overages.storage + overages.aiSpend;
  return { basePriceCents: band.monthlyPriceCents, overages, overageTotalCents, totalCents: band.monthlyPriceCents + overageTotalCents };
}
```

- [ ] **Step 4:** add `export * from "./billing";` to `index.ts`; `pnpm test billing.test` → PASS.
- [ ] **Step 5:** `git add packages/core/src/billing.ts packages/core/src/billing.test.ts packages/core/src/index.ts && git commit -m "feat(core): computeBill (base + per-meter overages)"`

## Task 3: Schema — `usage_snapshot` + `archivedAt` + `durationSeconds` + migration

**Files:** Create `packages/db/src/schema/billing.ts`; Modify `schema/ops.ts`, the comms schema file, `schema/index.ts`; Generate migration; Test `packages/db/tests/usage-snapshot.test.ts`

- [ ] **Step 1: Create** `packages/db/src/schema/billing.ts`:

```ts
import { pgTable, uuid, text, integer, bigint, index, uniqueIndex } from "drizzle-orm/pg-core";
import { idCol, createdAt, tenantIsolation } from "./_rls";
import { tenant } from "./tenancy";

export const usageSnapshot = pgTable("usage_snapshot", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  periodKey: text("period_key").notNull(), // YYYY-MM
  jobsProcessed: integer("jobs_processed").notNull().default(0),
  aiSpendCents: integer("ai_spend_cents").notNull().default(0),
  aiVoiceMinutes: integer("ai_voice_minutes").notNull().default(0),
  storageBytes: bigint("storage_bytes", { mode: "number" }).notNull().default(0),
  bandKey: text("band_key").notNull(),
  basePriceCents: integer("base_price_cents").notNull().default(0),
  overageCents: integer("overage_cents").notNull().default(0),
  totalCents: integer("total_cents").notNull().default(0),
  createdAt: createdAt(),
}, (t) => [
  index("usage_snapshot_tenant_idx").on(t.tenantId),
  uniqueIndex("usage_snapshot_tenant_period_uniq").on(t.tenantId, t.periodKey),
  tenantIsolation(),
]);
```

- [ ] **Step 2:** Add `archivedAt: timestamp("archived_at", { withTimezone: true }),` to the `document` table in `schema/ops.ts` (import `timestamp` if missing). Add `durationSeconds: integer("duration_seconds"),` to the `communication` table in its schema file (import `integer` if missing).

- [ ] **Step 3:** Add `export * from "./billing";` to `packages/db/src/schema/index.ts`.

- [ ] **Step 4: Generate + apply** (additive → non-interactive):
  ```bash
  pnpm db:migrate   # apply existing first
  pnpm db:generate  # creates 0008_*.sql
  pnpm db:migrate
  ```

- [ ] **Step 5: Test** `packages/db/tests/usage-snapshot.test.ts` (use the real tenant helper — `grep "export" packages/db/tests/helpers.ts`; it's `makeTenant`):

```ts
import { describe, it, expect } from "vitest";
import { withTenant } from "../src/tenant.js";
import { usageSnapshot } from "../src/schema/billing.js";
import { makeTenant } from "./helpers.js";

describe("usage_snapshot", () => {
  it("inserts + reads tenant-scoped", async () => {
    const { tenantId } = await makeTenant();
    const row = await withTenant(tenantId, async (tx) => {
      const [r] = await tx.insert(usageSnapshot).values({
        tenantId, periodKey: "2026-06", jobsProcessed: 10, aiSpendCents: 100,
        aiVoiceMinutes: 5, storageBytes: 123, bandKey: "starter",
        basePriceCents: 49900, overageCents: 0, totalCents: 49900,
      }).returning();
      return r;
    });
    expect(row!.totalCents).toBe(49900);
  });
});
```

- [ ] **Step 6:** `pnpm test usage-snapshot` → PASS.
- [ ] **Step 7:** `git add packages/db/src/schema packages/db/drizzle packages/db/tests/usage-snapshot.test.ts && git commit -m "feat(db): usage_snapshot table + document.archivedAt + communication.durationSeconds"`

---

# Wave A — Reporting

## Task 4: `computeVelocity`

**Files:** Create `packages/core/src/velocity.ts`; Modify `index.ts`; Test `packages/core/src/velocity.test.ts`

- [ ] **Step 1: Failing test:**

```ts
import { describe, it, expect } from "vitest";
import { computeVelocity } from "./velocity";

describe("computeVelocity", () => {
  it("averages days between consecutive stage entries and total cycle time", () => {
    const events = [
      { jobId: "j1", toStage: "lead", enteredAt: new Date("2026-01-01T00:00:00Z") },
      { jobId: "j1", toStage: "inspected", enteredAt: new Date("2026-01-03T00:00:00Z") }, // 2d in lead
      { jobId: "j1", toStage: "approved", enteredAt: new Date("2026-01-07T00:00:00Z") }, // 4d in inspected
    ];
    const v = computeVelocity(events);
    expect(v.perStageAvgDays.lead).toBeCloseTo(2);
    expect(v.perStageAvgDays.inspected).toBeCloseTo(4);
    expect(v.cycleTimeDays).toBeCloseTo(6); // first -> last
  });
  it("handles empty input", () => {
    expect(computeVelocity([])).toEqual({ perStageAvgDays: {}, cycleTimeDays: 0 });
  });
});
```

- [ ] **Step 2:** `pnpm test velocity` → FAIL.
- [ ] **Step 3: Implement** `packages/core/src/velocity.ts`:

```ts
export interface StageEvent { jobId: string; toStage: string; enteredAt: Date }

const DAY = 86_400_000;

/** Avg days spent in each stage (time from entering it to entering the next), + overall cycle time. */
export function computeVelocity(events: StageEvent[]): { perStageAvgDays: Record<string, number>; cycleTimeDays: number } {
  const byJob = new Map<string, StageEvent[]>();
  for (const e of events) {
    const arr = byJob.get(e.jobId) ?? [];
    arr.push(e);
    byJob.set(e.jobId, arr);
  }
  const durations = new Map<string, number[]>(); // stage -> [days]
  let totalCycle = 0;
  let cycleCount = 0;
  for (const arr of byJob.values()) {
    const sorted = [...arr].sort((a, b) => a.enteredAt.getTime() - b.enteredAt.getTime());
    for (let i = 0; i < sorted.length - 1; i++) {
      const days = (sorted[i + 1]!.enteredAt.getTime() - sorted[i]!.enteredAt.getTime()) / DAY;
      const list = durations.get(sorted[i]!.toStage) ?? [];
      list.push(days);
      durations.set(sorted[i]!.toStage, list);
    }
    if (sorted.length >= 2) {
      totalCycle += (sorted.at(-1)!.enteredAt.getTime() - sorted[0]!.enteredAt.getTime()) / DAY;
      cycleCount++;
    }
  }
  const perStageAvgDays: Record<string, number> = {};
  for (const [stage, list] of durations) perStageAvgDays[stage] = list.reduce((s, d) => s + d, 0) / list.length;
  return { perStageAvgDays, cycleTimeDays: cycleCount ? totalCycle / cycleCount : 0 };
}
```

- [ ] **Step 4:** add `export * from "./velocity";` to `index.ts`; `pnpm test velocity` → PASS.
- [ ] **Step 5:** `git add packages/core/src/velocity.ts packages/core/src/velocity.test.ts packages/core/src/index.ts && git commit -m "feat(core): computeVelocity (days-in-stage + cycle time)"`

## Task 5: `summarizeRepPerformance`

**Files:** Create `packages/core/src/rep-performance.ts`; Modify `index.ts`; Test `packages/core/src/rep-performance.test.ts`

- [ ] **Step 1: Failing test:**

```ts
import { describe, it, expect } from "vitest";
import { summarizeRepPerformance } from "./rep-performance";

describe("summarizeRepPerformance", () => {
  it("aggregates per rep + team rollup", () => {
    const rows = [
      { userId: "u1", name: "Ann", stage: "approved", valueCents: 100000, daysToClose: 10 },
      { userId: "u1", name: "Ann", stage: "lead", valueCents: 0, daysToClose: null },
      { userId: "u2", name: "Bo", stage: "approved", valueCents: 200000, daysToClose: 20 },
    ];
    const out = summarizeRepPerformance(rows);
    const ann = out.reps.find((r) => r.userId === "u1")!;
    expect(ann.jobsAssigned).toBe(2);
    expect(ann.approved).toBe(1);
    expect(ann.totalValueCents).toBe(100000);
    expect(ann.avgDaysToClose).toBeCloseTo(10);
    expect(out.team.jobsAssigned).toBe(3);
    expect(out.team.approved).toBe(2);
    expect(out.team.totalValueCents).toBe(300000);
  });
});
```

- [ ] **Step 2:** `pnpm test rep-performance` → FAIL.
- [ ] **Step 3: Implement** `packages/core/src/rep-performance.ts`:

```ts
export interface RepJobRow { userId: string; name: string; stage: string; valueCents: number; daysToClose: number | null }
export interface RepSummary { userId: string; name: string; jobsAssigned: number; approved: number; totalValueCents: number; avgDaysToClose: number }

const WON_STAGES = new Set(["approved", "production", "closeout", "billing", "complete"]);

export function summarizeRepPerformance(rows: RepJobRow[]): {
  reps: RepSummary[];
  team: { jobsAssigned: number; approved: number; totalValueCents: number };
} {
  const byUser = new Map<string, RepJobRow[]>();
  for (const r of rows) {
    const arr = byUser.get(r.userId) ?? [];
    arr.push(r);
    byUser.set(r.userId, arr);
  }
  const reps: RepSummary[] = [];
  for (const [userId, arr] of byUser) {
    const won = arr.filter((r) => WON_STAGES.has(r.stage));
    const closeTimes = won.map((r) => r.daysToClose).filter((d): d is number => d != null);
    reps.push({
      userId, name: arr[0]!.name, jobsAssigned: arr.length, approved: won.length,
      totalValueCents: won.reduce((s, r) => s + r.valueCents, 0),
      avgDaysToClose: closeTimes.length ? closeTimes.reduce((s, d) => s + d, 0) / closeTimes.length : 0,
    });
  }
  reps.sort((a, b) => b.totalValueCents - a.totalValueCents);
  const team = {
    jobsAssigned: reps.reduce((s, r) => s + r.jobsAssigned, 0),
    approved: reps.reduce((s, r) => s + r.approved, 0),
    totalValueCents: reps.reduce((s, r) => s + r.totalValueCents, 0),
  };
  return { reps, team };
}
```

- [ ] **Step 4:** add `export * from "./rep-performance";` to `index.ts`; `pnpm test rep-performance` → PASS.
- [ ] **Step 5:** `git add packages/core/src/rep-performance.ts packages/core/src/rep-performance.test.ts packages/core/src/index.ts && git commit -m "feat(core): summarizeRepPerformance"`

## Task 6: Dashboard reporting queries + cards

**Files:** Modify `apps/web/src/lib/dashboard-queries.ts`, `apps/web/src/app/(app)/dashboard/page.tsx`

- [ ] **Step 1: Queries** — add to `dashboard-queries.ts` (mirror the existing `getPipelineCounts` server-only/`withTenant` shape):

```ts
import { withTenant, job, jobStageEvent, user, eq } from "@savvy/db";
import { computeVelocity, summarizeRepPerformance } from "@savvy/core";
import { getTenantId } from "./tenant";

export async function getVelocity() {
  const tenantId = await getTenantId();
  const events = await withTenant(tenantId, (tx) =>
    tx.select({ jobId: jobStageEvent.jobId, toStage: jobStageEvent.toStage, enteredAt: jobStageEvent.enteredAt })
      .from(jobStageEvent));
  return computeVelocity(events.map((e) => ({ jobId: e.jobId, toStage: e.toStage ?? "", enteredAt: e.enteredAt! })));
}

export async function getRepPerformance() {
  const tenantId = await getTenantId();
  const rows = await withTenant(tenantId, (tx) =>
    tx.select({
      userId: job.assignedUserId, name: user.name, stage: job.stage,
      valueCents: job.valueEstimate, openedAt: job.openedAt, closedAt: job.closedAt,
    }).from(job).innerJoin(user, eq(user.id, job.assignedUserId)));
  const DAY = 86_400_000;
  return summarizeRepPerformance(rows.map((r) => ({
    userId: r.userId!, name: r.name, stage: r.stage,
    valueCents: r.valueCents ?? 0,
    daysToClose: r.openedAt && r.closedAt ? (r.closedAt.getTime() - r.openedAt.getTime()) / DAY : null,
  })));
}
```

> Verify column names on `job` (`assignedUserId`, `valueEstimate`, `openedAt`, `closedAt`) against `schema/jobs.ts`; adjust if different. If `openedAt`/`closedAt` don't exist, use `createdAt` and `stageEnteredAt` as the closest signals and note it.

- [ ] **Step 2: Cards** — in `dashboard/page.tsx`, call `getVelocity()` + `getRepPerformance()` and render a **Velocity** card (per-stage avg days + cycle time) and a **Rep/Team performance** table (rep rows + team totals). Mirror the existing dashboard card markup. Add `data-testid="velocity-card"` and `data-testid="rep-performance"`.
- [ ] **Step 3:** `pnpm --filter @savvy/web typecheck` → PASS.
- [ ] **Step 4:** `git add apps/web/src/lib/dashboard-queries.ts "apps/web/src/app/(app)/dashboard/page.tsx" && git commit -m "feat(web): dashboard velocity + rep/team performance"`

---

# Wave B — Metering

## Task 7: `computeTenantUsage`

**Files:** Create `packages/db/src/lifecycle/usage.ts` (the `computeTenantUsage` half); Test `packages/db/tests/usage.test.ts`

- [ ] **Step 1: Failing test** (mirror `helpers.ts`; seed job + agent_run + voice comm + docs in a period):

```ts
import { describe, it, expect } from "vitest";
import { computeTenantUsage } from "../src/lifecycle/usage.js";
import { adminDb } from "../src/admin-client.js";
import { agentRun, communication, document, job } from "../src/schema/index.js";
import { makeTenant, makeJobWithProperty } from "./helpers.js";

describe("computeTenantUsage", () => {
  it("aggregates jobs, ai spend, voice minutes, active storage in the period", async () => {
    const { tenantId } = await makeTenant();
    const jobId = await makeJobWithProperty(tenantId); // returns a job id (created now)
    const start = new Date("2026-06-01T00:00:00Z");
    const end = new Date("2026-07-01T00:00:00Z");
    const mid = new Date("2026-06-15T00:00:00Z");
    await adminDb.insert(agentRun).values({ tenantId, agent: "finance", status: "ok", costCents: 250, startedAt: mid });
    await adminDb.insert(communication).values({ tenantId, channel: "call", direction: "inbound", durationSeconds: 180, createdAt: mid });
    await adminDb.insert(communication).values({ tenantId, channel: "sms", direction: "inbound", durationSeconds: 999, createdAt: mid }); // excluded (not call)
    await adminDb.insert(document).values({ tenantId, kind: "photo", r2Key: "a", sizeBytes: 1000, createdAt: mid });
    await adminDb.insert(document).values({ tenantId, kind: "photo", r2Key: "b", sizeBytes: 5000, archivedAt: mid, createdAt: mid }); // excluded (archived)

    const u = await computeTenantUsage(tenantId, start, end);
    expect(u.aiSpendCents).toBe(250);
    expect(u.aiVoiceMinutes).toBe(3); // floor(180/60)
    expect(u.storageBytes).toBe(1000); // archived excluded
    expect(u.jobsProcessed).toBeGreaterThanOrEqual(1);
  });
});
```

> Adapt to the real `makeJobWithProperty` (added in Phase 7's `helpers.ts`). Use the actual `job` "created in period" column (`openedAt` or `createdAt`).

- [ ] **Step 2:** `pnpm test usage.test` → FAIL.
- [ ] **Step 3: Implement** the first half of `packages/db/src/lifecycle/usage.ts`:

```ts
import { withTenant } from "../tenant";
import { job } from "../schema/jobs";
import { agentRun } from "../schema/index";
import { communication } from "../schema/index";
import { document } from "../schema/ops";
import { and, eq, gte, lt, isNull, sql } from "drizzle-orm";
import type { UsageTotals } from "@savvy/core";

// Column for "job created in period": use job.openedAt if present, else createdAt.
export async function computeTenantUsage(tenantId: string, start: Date, end: Date): Promise<UsageTotals> {
  return withTenant(tenantId, async (tx) => {
    const [jobs] = await tx.select({ n: sql<number>`count(*)::int` }).from(job)
      .where(and(gte(job.openedAt, start), lt(job.openedAt, end)));
    const [ai] = await tx.select({ c: sql<number>`coalesce(sum(${agentRun.costCents}),0)::int` }).from(agentRun)
      .where(and(gte(agentRun.startedAt, start), lt(agentRun.startedAt, end)));
    const [voice] = await tx.select({ s: sql<number>`coalesce(sum(${communication.durationSeconds}),0)::int` }).from(communication)
      .where(and(eq(communication.channel, "call"), gte(communication.createdAt, start), lt(communication.createdAt, end)));
    const [stor] = await tx.select({ b: sql<number>`coalesce(sum(${document.sizeBytes}),0)::bigint` }).from(document)
      .where(isNull(document.archivedAt));
    return {
      jobsProcessed: jobs?.n ?? 0,
      aiSpendCents: ai?.c ?? 0,
      aiVoiceMinutes: Math.floor((voice?.s ?? 0) / 60),
      storageBytes: Number(stor?.b ?? 0),
    };
  });
}
```

> Confirm `agentRun`/`communication` import paths (they may live in `schema/index` or a specific file — `grep "export const agentRun" packages/db/src/schema`). Confirm `job.openedAt` exists; if not, use `job.createdAt`.

- [ ] **Step 4:** `pnpm test usage.test` → PASS.
- [ ] **Step 5:** `git add packages/db/src/lifecycle/usage.ts packages/db/tests/usage.test.ts && git commit -m "feat(db): computeTenantUsage (jobs/ai/voice/storage, archived excluded)"`

## Task 8: `recordUsageSnapshot`

**Files:** Modify `packages/db/src/lifecycle/usage.ts`, `packages/db/src/index.ts`; Test `packages/db/tests/record-usage-snapshot.test.ts`

- [ ] **Step 1: Failing test:**

```ts
import { describe, it, expect } from "vitest";
import { recordUsageSnapshot } from "../src/lifecycle/usage.js";
import { withTenant } from "../src/tenant.js";
import { usageSnapshot } from "../src/schema/billing.js";
import { tenant } from "../src/schema/index.js";
import { adminDb } from "../src/admin-client.js";
import { eq } from "drizzle-orm";
import { makeTenant } from "./helpers.js";

describe("recordUsageSnapshot", () => {
  it("computes + upserts a snapshot idempotently", async () => {
    const { tenantId } = await makeTenant();
    await adminDb.update(tenant).set({ revenueBand: "starter" }).where(eq(tenant.id, tenantId));
    const a = await recordUsageSnapshot(tenantId, "2026-06");
    expect(a.bandKey).toBe("starter");
    expect(a.basePriceCents).toBe(49900);
    const b = await recordUsageSnapshot(tenantId, "2026-06"); // re-run updates in place
    expect(b.totalCents).toBe(a.totalCents);
    const rows = await withTenant(tenantId, (tx) => tx.select().from(usageSnapshot).where(eq(usageSnapshot.periodKey, "2026-06")));
    expect(rows).toHaveLength(1);
  });
});
```

- [ ] **Step 2:** `pnpm test record-usage-snapshot` → FAIL.
- [ ] **Step 3: Implement** — append to `packages/db/src/lifecycle/usage.ts`:

```ts
import { tenant } from "../schema/tenancy";
import { usageSnapshot } from "../schema/billing";
import { getBand, computeBill } from "@savvy/core";

function periodBounds(periodKey: string): { start: Date; end: Date } {
  const [y, m] = periodKey.split("-").map(Number);
  return { start: new Date(Date.UTC(y!, m! - 1, 1)), end: new Date(Date.UTC(y!, m!, 1)) };
}

export async function recordUsageSnapshot(tenantId: string, periodKey: string) {
  const { start, end } = periodBounds(periodKey);
  const usage = await computeTenantUsage(tenantId, start, end);
  return withTenant(tenantId, async (tx) => {
    const [t] = await tx.select().from(tenant).where(eq(tenant.id, tenantId));
    const band = getBand(t?.revenueBand ?? null);
    const bill = computeBill(usage, band);
    const values = {
      tenantId, periodKey,
      jobsProcessed: usage.jobsProcessed, aiSpendCents: usage.aiSpendCents,
      aiVoiceMinutes: usage.aiVoiceMinutes, storageBytes: usage.storageBytes,
      bandKey: band.key, basePriceCents: bill.basePriceCents,
      overageCents: bill.overageTotalCents, totalCents: bill.totalCents,
    };
    const [row] = await tx.insert(usageSnapshot).values(values)
      .onConflictDoUpdate({ target: [usageSnapshot.tenantId, usageSnapshot.periodKey], set: values })
      .returning();
    return row!;
  });
}
```

- [ ] **Step 4:** export both from `packages/db/src/index.ts`: `export { computeTenantUsage, recordUsageSnapshot } from "./lifecycle/usage";`
- [ ] **Step 5:** `pnpm test record-usage-snapshot` → PASS.
- [ ] **Step 6:** `git add packages/db/src/lifecycle/usage.ts packages/db/src/index.ts packages/db/tests/record-usage-snapshot.test.ts && git commit -m "feat(db): recordUsageSnapshot (idempotent monthly upsert)"`

## Task 9: RLS isolation for `usage_snapshot`

**Files:** Modify `packages/db/tests/isolation.test.ts`

- [ ] **Step 1:** Import `usageSnapshot`; in `beforeAll` insert one row for tenant B (`periodKey: "2026-06", bandKey: "starter"`, the rest 0); in `afterAll` delete `usageSnapshot` where tenantB before the tenant delete; add a test:

```ts
it("SELECT on usage_snapshot is tenant-scoped (A cannot see B)", async () => {
  const rows = await withTenant(tenantAId, (tx) => tx.select().from(usageSnapshot));
  expect(rows.some((r) => r.tenantId === tenantBId)).toBe(false);
});
```

- [ ] **Step 2:** `pnpm test isolation` → PASS.
- [ ] **Step 3:** `git add packages/db/tests/isolation.test.ts && git commit -m "test(db): RLS isolation covers usage_snapshot"`

---

# Wave C — Workflows + capture

## Task 10: `meterUsageMonthly` cron

**Files:** Create `packages/agents/src/functions/meter-usage.ts`; Modify `packages/agents/src/index.ts`; Test `packages/agents/src/functions/meter-usage.test.ts`

- [ ] **Step 1: Implement** `packages/agents/src/functions/meter-usage.ts`:

```ts
import { adminDb, recordUsageSnapshot, tenant } from "@savvy/db";
import { inngest } from "../client";

/** Prior-month key in UTC, e.g. run in July -> "2026-06". */
export function priorMonthKey(now: Date): string {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth(); // 0-based; prior month = m-1, handled by Date
  const d = new Date(Date.UTC(y, m - 1, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export const meterUsageMonthly = inngest.createFunction(
  { id: "meter-usage-monthly", concurrency: { limit: 1 } },
  { cron: "TZ=America/Phoenix 0 6 1 * *" }, // 06:00 on the 1st, meters the prior month
  async ({ step }) => {
    const periodKey = await step.run("period", async () => priorMonthKey(new Date()));
    const tenants = await step.run("list-tenants", async () => adminDb.select({ id: tenant.id }).from(tenant));
    for (const t of tenants) {
      await step.run(`meter-${t.id}`, () => recordUsageSnapshot(t.id, periodKey));
    }
    return { metered: tenants.length, periodKey };
  },
);
```

> Confirm `{ cron: "..." }` is the trigger shape for Inngest 3.22 (it is for v3). `new Date()` inside a `step.run` is acceptable here (not a workflow-determinism concern for a monthly batch). Register `meterUsageMonthly` in `index.ts` (import + re-export + functions array).

- [ ] **Step 2: Test** `meter-usage.test.ts` — unit-test `priorMonthKey` (e.g. `priorMonthKey(new Date("2026-07-10")) === "2026-06"`; January → prior-year December) and, with a seeded tenant (`revenueBand: "starter"`), call `recordUsageSnapshot` directly to assert a snapshot is written (the cron just loops this). Mirror the live-DB agents test pattern.
- [ ] **Step 3:** `pnpm test meter-usage`; `pnpm typecheck && pnpm lint` → PASS.
- [ ] **Step 4:** `git add packages/agents/src/functions/meter-usage.ts packages/agents/src/functions/meter-usage.test.ts packages/agents/src/index.ts && git commit -m "feat(agents): meterUsageMonthly cron"`

## Task 11: `coldArchiveDocuments` cron

**Files:** Create `packages/agents/src/functions/cold-archive.ts`; Modify `packages/agents/src/index.ts`; Test `packages/agents/src/functions/cold-archive.test.ts`

- [ ] **Step 1: Implement** `packages/agents/src/functions/cold-archive.ts`:

```ts
import { adminDb, withTenant, document, tenant, and, isNull, lt, sql } from "@savvy/db";
import { inngest } from "../client";

const ARCHIVE_AFTER_DAYS = 90;

export async function archiveOldDocuments(tenantId: string, cutoff: Date): Promise<number> {
  return withTenant(tenantId, async (tx) => {
    const res = await tx.update(document).set({ archivedAt: sql`now()` })
      .where(and(isNull(document.archivedAt), lt(document.createdAt, cutoff)))
      .returning({ id: document.id });
    return res.length;
  });
}

export const coldArchiveDocuments = inngest.createFunction(
  { id: "cold-archive-documents", concurrency: { limit: 1 } },
  { cron: "TZ=America/Phoenix 0 4 * * *" }, // daily 04:00
  async ({ step }) => {
    const cutoff = await step.run("cutoff", async () => new Date(Date.now() - ARCHIVE_AFTER_DAYS * 86_400_000));
    const tenants = await step.run("list-tenants", async () => adminDb.select({ id: tenant.id }).from(tenant));
    let archived = 0;
    for (const t of tenants) {
      archived += await step.run(`archive-${t.id}`, () => archiveOldDocuments(t.id, cutoff));
    }
    return { archived };
  },
);
```

> Register in `index.ts`. Confirm `document`/`and`/`isNull`/`lt`/`sql` are exported from `@savvy/db` (they are).

- [ ] **Step 2: Test** `cold-archive.test.ts` (live DB): seed a tenant + two documents (one `createdAt` 120 days ago, one today); call `archiveOldDocuments(tenantId, cutoff=90d ago)`; assert the old doc has `archivedAt` set and the recent one is still null.
- [ ] **Step 3:** `pnpm test cold-archive`; `pnpm typecheck && pnpm lint` → PASS.
- [ ] **Step 4:** `git add packages/agents/src/functions/cold-archive.ts packages/agents/src/functions/cold-archive.test.ts packages/agents/src/index.ts && git commit -m "feat(agents): coldArchiveDocuments daily cron"`

## Task 12: Capture voice duration

**Files:** Modify `apps/web/src/app/api/twilio/voice/route.ts`

- [ ] **Step 1:** Read the route. It logs a `communication` row with `channel: "call"`. Twilio posts `CallDuration` (seconds, string) on the call **status callback** (and on some voice webhooks at completion). Update the row insert (or add handling) to set `durationSeconds: CallDuration ? parseInt(CallDuration, 10) : null` read from the form body. If the route only fires at call *start* (no duration yet), set `durationSeconds` when present and add a short code comment that full duration requires Twilio's `statusCallback` to POST here at completion (operational config — note it; do not build a new endpoint unless one already exists).

```ts
// inside the handler, after parsing the form body `params`:
const callDuration = params.get("CallDuration");
// ...in the communication insert values:
durationSeconds: callDuration ? parseInt(callDuration, 10) : null,
```

- [ ] **Step 2:** `pnpm --filter @savvy/web typecheck` → PASS.
- [ ] **Step 3:** `git add apps/web/src/app/api/twilio/voice/route.ts && git commit -m "feat(web): capture call duration on the voice path for AI-minute metering"`

---

# Wave D — Billing UI

## Task 13: Billing queries + `/billing` page

**Files:** Create `apps/web/src/lib/billing-queries.ts`, `apps/web/src/app/(app)/billing/page.tsx`, `BillingClient.tsx`; Modify `apps/web/src/app/(app)/layout.tsx`

- [ ] **Step 1: Queries** `billing-queries.ts` (server-only):

```ts
import "server-only";
import { withTenant, usageSnapshot, tenant, eq, desc } from "@savvy/db";
import { computeTenantUsage } from "@savvy/db";
import { getBand, computeBill } from "@savvy/core";
import { getTenantId } from "./tenant";

export async function getCurrentBilling() {
  const tenantId = await getTenantId();
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const usage = await computeTenantUsage(tenantId, start, end);
  const [t] = await withTenant(tenantId, (tx) => tx.select().from(tenant).where(eq(tenant.id, tenantId)));
  const band = getBand(t?.revenueBand ?? null);
  return { usage, band, bill: computeBill(usage, band) };
}

export async function listUsageSnapshots() {
  const tenantId = await getTenantId();
  return withTenant(tenantId, (tx) =>
    tx.select().from(usageSnapshot).orderBy(desc(usageSnapshot.periodKey)));
}
```

- [ ] **Step 2: Page** `billing/page.tsx` (`force-dynamic`): load both, render `<BillingClient current={...} history={...} />`.
- [ ] **Step 3: Client** `BillingClient.tsx` (`"use client"`): current-period section with one row per meter (used vs `band.allowances`, simple progress bar), a bill breakdown (base + each overage + total via `fmtUsd`), and a history table of snapshots. `data-testid="billing-page"`, the current total `data-testid="billing-total"`.
- [ ] **Step 4: Nav** — add a `Billing` link to `layout.tsx`.
- [ ] **Step 5:** `pnpm --filter @savvy/web typecheck` → PASS.
- [ ] **Step 6:** `git add apps/web/src/lib/billing-queries.ts "apps/web/src/app/(app)/billing" "apps/web/src/app/(app)/layout.tsx" && git commit -m "feat(web): billing page (usage vs allowances + computed bill + history)"`

---

# Wave Gate — e2e + gate + PR

## Task 14: e2e

**Files:** Create `apps/web/tests/e2e/billing.spec.ts`

Reuse the harness (`TEST_MODE=1`, ai-stub, inngest-cli dev, `create-tenant.ts`). Mirror `finance.spec.ts`.

- [ ] **Step 1: Write the e2e:**
  1. Seed (adminDb): set `tenant.revenueBand = "starter"`; create a user + customer + property + job (assigned, `valueEstimate`); insert a few `agent_run` (costCents), a `communication` (`channel:"call"`, `durationSeconds`), and `document` rows in the current month; write a couple `job_stage_event` rows for velocity.
  2. Call `recordUsageSnapshot(tenantId, <currentPeriodKey>)` (import from `@savvy/db`) — or fire the cron via `inngest.send` if a manual trigger exists; the direct call is deterministic.
  3. `/billing` → assert `billing-page` visible, the band name shown, and `billing-total` shows the expected `$` (base + any overage).
  4. `/dashboard` → assert `velocity-card` and `rep-performance` are visible with data.
- [ ] **Step 2:** Run via the recipe (start ai-stub + inngest dev + create-tenant, `playwright test billing.spec.ts`); verify PASS; kill servers (`pkill -f ai-stub.mjs; pkill -f inngest-cli; pkill -f "next dev"`).
- [ ] **Step 3:** `git add apps/web/tests/e2e/billing.spec.ts && git commit -m "test(e2e): billing — usage metered, bill + dashboard reports render"`

## Task 15: Final gate + PR

- [ ] **Step 1: Full static gate:**
  ```bash
  export DATABASE_URL=postgres://savvy_app:savvy_app@localhost:5432/savvy DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/savvy
  pnpm typecheck && pnpm lint && pnpm test
  ```
  Expected: all green.
- [ ] **Step 2: Push + PR:**
  ```bash
  git push -u origin HEAD
  gh pr create --title "Phase 8: Reporting & billing meters" \
    --body "Implements the Phase 8 spec: usage metering (jobs/AI spend/voice minutes/storage) -> revenue-band bill + overages in monthly usage_snapshot, daily cold-archive, velocity + rep/team dashboards, and a /billing page. Compute + display only. See docs/superpowers/specs/2026-06-16-phase8-reporting-billing-design.md."
  ```

---

## Self-Review (completed by plan author)

**Spec coverage:** §2 schema (usage_snapshot, document.archivedAt, communication.durationSeconds) → Task 3. §3 billing core (bands, computeBill) → Tasks 1–2; reporting pure (velocity, rep perf) → Tasks 4–5. §4 aggregation (computeTenantUsage, recordUsageSnapshot) → Tasks 7–8. §5 crons (meter monthly, cold-archive daily) + voice capture → Tasks 10–12. §6 web (billing page, dashboard cards) → Tasks 6, 13. §7 testing (unit, db, agents, RLS, e2e) → inline + Tasks 9, 14. §8 DoD → Tasks 14–15. ✅

**Verifications flagged inline (confirm against live code):** comms schema filename + voice channel value `"call"` (Tasks 3, 7, 12); `job` columns `assignedUserId`/`valueEstimate`/`openedAt`/`closedAt` (Tasks 6, 7); `agentRun`/`communication` export paths (Task 7); `helpers.ts` `makeTenant`/`makeJobWithProperty` (Tasks 3, 7); Inngest `{cron}` trigger for v3.22 (Tasks 10–11); whether the voice route fires at call start vs completion (Task 12).

**Type consistency:** `UsageTotals` (Task 2) is produced by `computeTenantUsage` (Task 7) and consumed by `computeBill` (Task 2) + `recordUsageSnapshot` (Task 8) + billing-queries (Task 13). `BillingBand` (Task 1) → `computeBill`/`getBand` (Tasks 2, 8, 13). `usageSnapshot` columns (Task 3) match `recordUsageSnapshot` insert (Task 8) + isolation seed (Task 9) + queries (Task 13). `StageEvent`/`RepJobRow` (Tasks 4–5) match dashboard-queries mapping (Task 6). ✅
