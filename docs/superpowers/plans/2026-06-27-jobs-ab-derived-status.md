# Jobs A+B — Derived Status + Carryover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add compute-on-read job health (`stuck`/`late`), config-driven board badges + a needs-attention filter, invoice→stage wiring, and a `job.type` carryover heuristic — improving the existing Jobs spine without new DB columns.

**Architecture:** Pure deterministic helpers in `@savvy/core` (`parseJobsConfig`, `deriveJobHealth`, `leadToJobType`); a `@savvy/db` change to `convertLeadToJob`; two `@savvy/agents` Inngest functions wiring existing `invoice/sent`/`invoice/paid` events to the deterministic `recordStageChange`; and `@savvy/web` board surfacing. Health is never stored — it is recomputed on every board read, so it cannot drift.

**Tech Stack:** TypeScript, Next.js (App Router), Drizzle ORM (Postgres + RLS), Inngest, Vitest + Playwright, pnpm + Turborepo, zod (v3).

**Spec:** `docs/superpowers/specs/2026-06-27-jobs-ab-derived-status-design.md`

## Global Constraints

- **Build off `origin/main`** (this worktree `jobs-ab-derived-status` is branched from it; includes the voice merge #54).
- **Import-extension rule (match the file you edit):** `packages/core/*`, `packages/db/src/**` SOURCE, `apps/web/*` → **NO `.js`** in import paths; only `packages/db` **TEST** files use `.js`. A `.js` in a db source file breaks the Turbopack e2e webServer.
- **Single instances:** within `packages/core` import `z` from `"./schemas"` (never bare `zod`); drizzle ops + tables come from `@savvy/db`; `recordStageChange`, `withTenant`, `invoice`, `job`, `eq` are imported from `@savvy/db`.
- **No new DB columns and no migration.** Health is read-time only.
- **Tenant isolation:** every DB read/write is tenant-scoped via `withTenant` / explicit `tenantId`. The board query already resolves tenant via `getTenantId()`.
- **Determinism:** the derivation contains **no AI**. Only the Inngest stage-sync writes go through `recordStageChange` (which writes `audit_log`).
- **Enums (verbatim):** `JOB_STAGE = ["lead","inspected","estimate","approved","production","closeout","billing","complete","lost"]`; `JOB_TYPE = ["retail","insurance","repair","commercial"]`.
- **Definition of done:** tests written + passing; `pnpm typecheck` + `pnpm lint` clean (pre-existing `scheduling.ts` / `pipeline.spec.ts` warnings excepted).
- **Test commands:** core/agents focused run → `pnpm --filter @savvy/<pkg> exec vitest run <relpath>`; db integration → `pnpm db:up` then `pnpm --filter @savvy/db test <relpath>`.

---

### Task 1: Jobs config parser + `leadToJobType` (core)

**Files:**
- Create: `packages/core/src/jobs-config.ts`
- Create: `packages/core/src/jobs-config.test.ts`
- Modify: `packages/core/src/index.ts` (add `export * from "./jobs-config"`)

**Interfaces:**
- Produces:
  - `type JobsConfig = { stageThresholds: { inspected,estimate,approved,production,closeout,billing: number }, buildSlaDays: { retail,insurance,repair,commercial: number } }`
  - `parseJobsConfig(raw: unknown): JobsConfig`
  - `leadToJobType(lane: string | null): JobType` — `"storm" → "insurance"`, else `"retail"`.

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/jobs-config.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { parseJobsConfig, leadToJobType } from "./jobs-config";

describe("parseJobsConfig", () => {
  it("fills defaults from empty/undefined input", () => {
    const c = parseJobsConfig(undefined);
    expect(c.stageThresholds.estimate).toBe(7);
    expect(c.stageThresholds.production).toBe(14);
    expect(c.buildSlaDays.retail).toBe(21);
    expect(c.buildSlaDays.insurance).toBe(45);
  });
  it("applies per-tenant overrides and keeps other defaults", () => {
    const c = parseJobsConfig({ stageThresholds: { estimate: 3 }, buildSlaDays: { insurance: 60 } });
    expect(c.stageThresholds.estimate).toBe(3);
    expect(c.stageThresholds.billing).toBe(10); // default preserved
    expect(c.buildSlaDays.insurance).toBe(60);
    expect(c.buildSlaDays.retail).toBe(21); // default preserved
  });
});

describe("leadToJobType", () => {
  it("maps storm lane to insurance and everything else to retail", () => {
    expect(leadToJobType("storm")).toBe("insurance");
    expect(leadToJobType("tile")).toBe("retail");
    expect(leadToJobType("standard")).toBe("retail");
    expect(leadToJobType(null)).toBe("retail");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @savvy/core exec vitest run src/jobs-config.test.ts`
Expected: FAIL — `Cannot find module './jobs-config'`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/core/src/jobs-config.ts`:
```typescript
import { z } from "./schemas";
import type { JobType } from "./enums";

const jobsSchema = z.object({
  // days-in-stage before a job is "stuck"; terminal stages (lead/complete/lost) intentionally absent
  stageThresholds: z
    .object({
      inspected: z.number().int().min(1).default(3),
      estimate: z.number().int().min(1).default(7),
      approved: z.number().int().min(1).default(5),
      production: z.number().int().min(1).default(14),
      closeout: z.number().int().min(1).default(5),
      billing: z.number().int().min(1).default(10),
    })
    .default({}),
  // approved-date → expected completion, per job type
  buildSlaDays: z
    .object({
      retail: z.number().int().min(1).default(21),
      insurance: z.number().int().min(1).default(45),
      repair: z.number().int().min(1).default(10),
      commercial: z.number().int().min(1).default(60),
    })
    .default({}),
});

export type JobsConfig = z.infer<typeof jobsSchema>;

export function parseJobsConfig(raw: unknown): JobsConfig {
  return jobsSchema.parse(raw ?? {});
}

/**
 * Best-effort job lane heuristic. There is no retail/insurance flag on the lead;
 * lead.lane is "storm" | "tile" | "standard". Storm-damage leads are usually
 * insurance claims. Correctable later (piece G / editable type).
 */
export function leadToJobType(lane: string | null): JobType {
  return lane === "storm" ? "insurance" : "retail";
}
```

- [ ] **Step 4: Add the export**

In `packages/core/src/index.ts`, add alongside the other `export * from` lines:
```typescript
export * from "./jobs-config";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @savvy/core exec vitest run src/jobs-config.test.ts`
Expected: PASS (5 assertions across 3 tests).

- [ ] **Step 6: Typecheck + commit**

Run: `pnpm --filter @savvy/core typecheck` → clean.
```bash
git add packages/core/src/jobs-config.ts packages/core/src/jobs-config.test.ts packages/core/src/index.ts
git commit -m "feat(core): parseJobsConfig + leadToJobType (jobs health config + lane heuristic)"
```

---

### Task 2: `deriveJobHealth` (core)

**Files:**
- Create: `packages/core/src/job-health.ts`
- Create: `packages/core/src/job-health.test.ts`
- Modify: `packages/core/src/index.ts` (add `export * from "./job-health"`)

**Interfaces:**
- Consumes: `JobsConfig` (Task 1); `JobStage`, `JobType` (`./enums`).
- Produces:
  - `type JobHealthSignals = { stage: JobStage; stageEnteredAt: Date; type: JobType; approvedAt: Date | null; hasPastDueInvoice: boolean }`
  - `type JobHealth = { stuck: boolean; late: boolean; reasons: string[] }`
  - `deriveJobHealth(s: JobHealthSignals, config: JobsConfig, now: Date): JobHealth`

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/job-health.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { deriveJobHealth, type JobHealthSignals } from "./job-health";
import { parseJobsConfig } from "./jobs-config";

const cfg = parseJobsConfig(undefined); // estimate threshold 7, retail SLA 21
const now = new Date("2026-06-27T12:00:00Z");
const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000);

const base: JobHealthSignals = {
  stage: "estimate",
  stageEnteredAt: daysAgo(2),
  type: "retail",
  approvedAt: null,
  hasPastDueInvoice: false,
};

describe("deriveJobHealth", () => {
  it("is healthy when within stage threshold, not past SLA, no past-due", () => {
    expect(deriveJobHealth(base, cfg, now)).toEqual({ stuck: false, late: false, reasons: [] });
  });
  it("flags stuck when days-in-stage exceeds the stage threshold", () => {
    const r = deriveJobHealth({ ...base, stageEnteredAt: daysAgo(9) }, cfg, now); // >7
    expect(r.stuck).toBe(true);
    expect(r.reasons.join(" ")).toMatch(/stuck 9d in estimate/);
  });
  it("never flags stuck in terminal stages (no configured threshold)", () => {
    const r = deriveJobHealth({ ...base, stage: "complete", stageEnteredAt: daysAgo(99) }, cfg, now);
    expect(r.stuck).toBe(false);
  });
  it("flags late when now is past approvedAt + buildSlaDays[type]", () => {
    const r = deriveJobHealth({ ...base, approvedAt: daysAgo(30) }, cfg, now); // retail SLA 21
    expect(r.late).toBe(true);
    expect(r.reasons.join(" ")).toMatch(/past expected completion/);
  });
  it("does not flag late by SLA when not yet approved", () => {
    expect(deriveJobHealth({ ...base, approvedAt: null }, cfg, now).late).toBe(false);
  });
  it("flags late on a past-due invoice regardless of stage/approval", () => {
    const r = deriveJobHealth({ ...base, hasPastDueInvoice: true }, cfg, now);
    expect(r.late).toBe(true);
    expect(r.reasons.join(" ")).toMatch(/invoice past due/);
  });
  it("can be both stuck and late", () => {
    const r = deriveJobHealth({ ...base, stageEnteredAt: daysAgo(9), approvedAt: daysAgo(30) }, cfg, now);
    expect(r).toMatchObject({ stuck: true, late: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @savvy/core exec vitest run src/job-health.test.ts`
Expected: FAIL — `Cannot find module './job-health'`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/core/src/job-health.ts`:
```typescript
import type { JobStage, JobType } from "./enums";
import type { JobsConfig } from "./jobs-config";

const DAY = 86_400_000;

export type JobHealthSignals = {
  stage: JobStage;
  stageEnteredAt: Date;
  type: JobType;
  approvedAt: Date | null;
  hasPastDueInvoice: boolean;
};

export type JobHealth = { stuck: boolean; late: boolean; reasons: string[] };

export function deriveJobHealth(s: JobHealthSignals, config: JobsConfig, now: Date): JobHealth {
  const reasons: string[] = [];

  // stuck: only for stages with a configured threshold (terminal stages omitted)
  const threshold = (config.stageThresholds as Record<string, number>)[s.stage];
  const daysInStage = Math.floor((now.getTime() - s.stageEnteredAt.getTime()) / DAY);
  const stuck = threshold != null && daysInStage > threshold;
  if (stuck) reasons.push(`stuck ${daysInStage}d in ${s.stage} (>${threshold})`);

  // late: past expected completion (approved + buildSla) OR a past-due invoice
  let late = false;
  if (s.approvedAt) {
    const dueMs = s.approvedAt.getTime() + config.buildSlaDays[s.type] * DAY;
    if (now.getTime() > dueMs) {
      late = true;
      reasons.push(`past expected completion by ${Math.floor((now.getTime() - dueMs) / DAY)}d`);
    }
  }
  if (s.hasPastDueInvoice) {
    late = true;
    reasons.push("invoice past due");
  }

  return { stuck, late, reasons };
}
```

- [ ] **Step 4: Add the export**

In `packages/core/src/index.ts`:
```typescript
export * from "./job-health";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @savvy/core exec vitest run src/job-health.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 6: Typecheck + commit**

Run: `pnpm --filter @savvy/core typecheck` → clean.
```bash
git add packages/core/src/job-health.ts packages/core/src/job-health.test.ts packages/core/src/index.ts
git commit -m "feat(core): deriveJobHealth (read-time stuck/late derivation)"
```

---

### Task 3: `job.type` carryover in `convertLeadToJob` (db)

**Files:**
- Modify: `packages/db/src/lifecycle/appointments.ts` (the `convertLeadToJob` function)
- Create: `packages/db/src/lifecycle/convert-lead-to-job.test.ts`

**Interfaces:**
- Consumes: `leadToJobType` (Task 1) from `@savvy/core`.
- Produces: `convertLeadToJob` now sets `job.type` from the lead's lane and seeds the matching task templates. Signature unchanged: `convertLeadToJob(args: { tenantId: string; leadId: string }): Promise<{ jobId: string; customerId: string }>`.

- [ ] **Step 1: Write the failing test**

Create `packages/db/src/lifecycle/convert-lead-to-job.test.ts` (db tests use `.js` imports). Read a sibling (`packages/db/src/lifecycle/voice.test.ts`) to match the exact NOT-NULL columns for `customer`/`property`/`lead` seeding before running:
```typescript
import { describe, it, expect } from "vitest";
import { withTenant } from "../tenant.js";
import { adminDb, tenant, customer, property, lead, job, jobTask, eq, and } from "../index.js";
import { convertLeadToJob } from "./appointments.js";

async function mkTenant(name: string) {
  const [t] = await adminDb.insert(tenant).values({ name, publicKey: `k-${name}-${Date.now()}`, clerkOrgId: `o-${name}-${Date.now()}` }).returning();
  return t!.id;
}
async function mkLead(tenantId: string, lane: string) {
  return withTenant(tenantId, async (tx) => {
    const [c] = await tx.insert(customer).values({ tenantId, name: "Caller", phone: `+1602555${Math.floor(1000 + Math.random() * 8999)}` }).returning({ id: customer.id });
    const [p] = await tx.insert(property).values({ tenantId, customerId: c!.id, address: "1 Main St" }).returning({ id: property.id });
    const [l] = await tx.insert(lead).values({ tenantId, customerId: c!.id, propertyId: p!.id, source: "test", lane }).returning({ id: lead.id });
    return l!.id;
  });
}

describe("convertLeadToJob job.type carryover", () => {
  it("opens an insurance job for a storm-lane lead and seeds insurance tasks", async () => {
    const tid = await mkTenant("ctj-storm");
    const leadId = await mkLead(tid, "storm");
    const { jobId } = await convertLeadToJob({ tenantId: tid, leadId });
    const [j] = await adminDb.select({ type: job.type }).from(job).where(eq(job.id, jobId));
    expect(j!.type).toBe("insurance");
    const tasks = await adminDb.select({ id: jobTask.id }).from(jobTask).where(and(eq(jobTask.tenantId, tid), eq(jobTask.jobId, jobId)));
    expect(tasks.length).toBeGreaterThan(0); // insurance templates seeded
  });
  it("opens a retail job for a standard-lane lead", async () => {
    const tid = await mkTenant("ctj-std");
    const leadId = await mkLead(tid, "standard");
    const { jobId } = await convertLeadToJob({ tenantId: tid, leadId });
    const [j] = await adminDb.select({ type: job.type }).from(job).where(eq(job.id, jobId));
    expect(j!.type).toBe("retail");
  });
});
```
(If `jobTask` is not exported from `../index`, import the table from its schema module as the sibling tests do; confirm by matching an existing db test that reads `job_task`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm db:up && pnpm --filter @savvy/db db:migrate && pnpm --filter @savvy/db test src/lifecycle/convert-lead-to-job.test.ts`
Expected: FAIL — first test gets `type === "retail"` (hardcoded) instead of `"insurance"`.

- [ ] **Step 3: Write minimal implementation**

In `packages/db/src/lifecycle/appointments.ts`, add the import (merge with the existing `@savvy/core` import line if present):
```typescript
import { leadToJobType } from "@savvy/core";
```
Inside `convertLeadToJob`, after `const [l] = ...` is loaded and before the insert, compute the type, then use it in **both** the insert and `seedJobTasks`:
```typescript
    const jobType = leadToJobType(l.lane ?? null);
    const [newJob] = await tx.insert(job).values({
      tenantId: args.tenantId, customerId: l.customerId!, propertyId: l.propertyId!,
      type: jobType, stage: "lead", leadId: l.id,
    }).returning();
    await seedJobTasks(tx as never, { id: newJob!.id, tenantId: args.tenantId, type: jobType });
```
(Replace the two existing `"retail"` literals — the `type:` field and the `seedJobTasks` arg. Leave everything else, including the idempotent "already booked → return existing" branch, unchanged.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @savvy/db test src/lifecycle/convert-lead-to-job.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm --filter @savvy/db typecheck` → clean.
```bash
git add packages/db/src/lifecycle/appointments.ts packages/db/src/lifecycle/convert-lead-to-job.test.ts
git commit -m "feat(db): carry lead lane into job.type (storm -> insurance) at conversion"
```

---

### Task 4: invoice → stage Inngest wiring (agents)

**Files:**
- Create: `packages/agents/src/functions/invoice-stage.ts`
- Create: `packages/agents/src/functions/invoice-stage.test.ts`
- Modify: `packages/agents/src/index.ts` (import + export + register both functions)

**Interfaces:**
- Consumes: `JOB_STAGE`, `JobStage` (`@savvy/core`); `withTenant`, `invoice`, `job`, `eq`, `recordStageChange` (`@savvy/db`); `inngest` (`../client`); events `invoice/sent` / `invoice/paid` (`{ data: { invoiceId, tenantId } }`).
- Produces:
  - `syncInvoiceStage(tenantId: string, invoiceId: string, toStage: JobStage): Promise<{ jobId: string; toStage: JobStage } | { skipped: string }>`
  - Inngest fns `invoiceSentToBilling`, `invoicePaidToComplete`.

- [ ] **Step 1: Write the failing test**

Create `packages/agents/src/functions/invoice-stage.test.ts` (agents source = NO `.js`). This exercises the pure `syncInvoiceStage` against the DB:
```typescript
import { describe, it, expect } from "vitest";
import { withTenant, adminDb, tenant, customer, property, job, invoice, eq } from "@savvy/db";
import { syncInvoiceStage } from "./invoice-stage";

async function seedJobAt(stage: string) {
  const [t] = await adminDb.insert(tenant).values({ name: "inv", publicKey: `k-${Date.now()}-${Math.random()}`, clerkOrgId: `o-${Date.now()}-${Math.random()}` }).returning();
  const tid = t!.id;
  const ids = await withTenant(tid, async (tx) => {
    const [c] = await tx.insert(customer).values({ tenantId: tid, name: "C" }).returning({ id: customer.id });
    const [p] = await tx.insert(property).values({ tenantId: tid, customerId: c!.id, address: "1 St" }).returning({ id: property.id });
    const [j] = await tx.insert(job).values({ tenantId: tid, customerId: c!.id, propertyId: p!.id, type: "retail", stage }).returning({ id: job.id });
    const [inv] = await tx.insert(invoice).values({ tenantId: tid, jobId: j!.id, status: "sent", amountDue: 1000 }).returning({ id: invoice.id });
    return { jid: j!.id, invId: inv!.id };
  });
  return { tid, ...ids };
}

describe("syncInvoiceStage", () => {
  it("advances closeout → billing on invoice/sent", async () => {
    const { tid, jid, invId } = await seedJobAt("closeout");
    const r = await syncInvoiceStage(tid, invId, "billing");
    expect(r).toMatchObject({ jobId: jid, toStage: "billing" });
    const [j] = await adminDb.select({ stage: job.stage }).from(job).where(eq(job.id, jid));
    expect(j!.stage).toBe("billing");
  });
  it("is forward-only: does not pull a complete job back to billing", async () => {
    const { tid, invId, jid } = await seedJobAt("complete");
    const r = await syncInvoiceStage(tid, invId, "billing");
    expect(r).toMatchObject({ skipped: "not_forward" });
    const [j] = await adminDb.select({ stage: job.stage }).from(job).where(eq(job.id, jid));
    expect(j!.stage).toBe("complete");
  });
});
```
(`recordStageChange` requires no photos for non-`complete` targets, so the `billing` advance needs no document seeding. Confirm `invoice` insert columns against `schema/finance.ts` — `jobId` is NOT NULL.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm db:up && pnpm --filter @savvy/db db:migrate && pnpm --filter @savvy/agents test src/functions/invoice-stage.test.ts`
Expected: FAIL — `Cannot find module './invoice-stage'`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/agents/src/functions/invoice-stage.ts`:
```typescript
import { withTenant, invoice, job, eq, recordStageChange } from "@savvy/db";
import { JOB_STAGE, type JobStage } from "@savvy/core";
import { inngest } from "../client";

/**
 * Advance a job's stage from an invoice event. Forward-only (never regress),
 * idempotent (recordStageChange no-ops re-fires), and gate-aware: a move to
 * `complete` that fails the close-out photo gate leaves the job in place.
 */
export async function syncInvoiceStage(
  tenantId: string,
  invoiceId: string,
  toStage: JobStage,
): Promise<{ jobId: string; toStage: JobStage } | { skipped: string }> {
  return withTenant(tenantId, async (tx) => {
    const [inv] = await tx.select().from(invoice).where(eq(invoice.id, invoiceId));
    if (!inv) return { skipped: "no_invoice" };
    const [j] = await tx.select().from(job).where(eq(job.id, inv.jobId));
    if (!j) return { skipped: "no_job" };

    // forward-only: target must be strictly ahead of the current stage
    if (JOB_STAGE.indexOf(toStage) <= JOB_STAGE.indexOf(j.stage as JobStage)) {
      return { skipped: "not_forward" };
    }

    try {
      await recordStageChange(tx, { tenantId, jobId: j.id, toStage, byAgent: "orchestrator" });
    } catch (e) {
      // close-out photo gate unmet on the move to `complete` — leave the job in billing
      if (e instanceof Error && e.name === "IncompletePhotosError") return { skipped: "photo_gate" };
      throw e;
    }
    return { jobId: j.id, toStage };
  });
}

export const invoiceSentToBilling = inngest.createFunction(
  { id: "invoice-sent-to-billing", concurrency: { limit: 5 } },
  { event: "invoice/sent" },
  async ({ event, step }) => step.run("sync", () => syncInvoiceStage(event.data.tenantId, event.data.invoiceId, "billing")),
);

export const invoicePaidToComplete = inngest.createFunction(
  { id: "invoice-paid-to-complete", concurrency: { limit: 5 } },
  { event: "invoice/paid" },
  async ({ event, step }) => step.run("sync", () => syncInvoiceStage(event.data.tenantId, event.data.invoiceId, "complete")),
);
```

- [ ] **Step 4: Register the functions**

In `packages/agents/src/index.ts`: add the import near the other `./functions/*` imports, add an `export { ... }` line, and append both to the `functions` array:
```typescript
import { invoiceSentToBilling, invoicePaidToComplete } from "./functions/invoice-stage";
```
```typescript
export { invoiceSentToBilling, invoicePaidToComplete } from "./functions/invoice-stage";
```
```typescript
// ...add to the end of the `export const functions = [ ... ]` array:
  invoiceSentToBilling, invoicePaidToComplete,
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @savvy/agents test src/functions/invoice-stage.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Typecheck + commit**

Run: `pnpm --filter @savvy/agents typecheck` → clean.
```bash
git add packages/agents/src/functions/invoice-stage.ts packages/agents/src/functions/invoice-stage.test.ts packages/agents/src/index.ts
git commit -m "feat(agents): invoice/sent->billing, invoice/paid->complete (forward-only, gate-aware)"
```

---

### Task 5: Board health signals (web — pipeline-queries)

**Files:**
- Modify: `apps/web/src/lib/pipeline-queries.ts` (`getBoard` + `BoardCard`)

**Interfaces:**
- Consumes: `parseJobsConfig`, `deriveJobHealth`, `type JobHealth` (`@savvy/core`); `tenant` table (`@savvy/db`).
- Produces: `BoardCard` gains `type: string` and `health: JobHealth`. `getBoard` attaches health per card. No signature change.

- [ ] **Step 1: Extend the query + attach health**

In `apps/web/src/lib/pipeline-queries.ts`:
1. Add imports (merge with existing): `import { parseJobsConfig, deriveJobHealth, type JobHealth, type JobStage, type JobType } from "@savvy/core";` and add `tenant` to the existing `@savvy/db` import.
2. Extend `BoardCard`:
```typescript
export type BoardCard = {
  id: string; stage: string; customerName: string; address: string;
  valueEstimate: number | null; stageEnteredAt: string;
  agent: string | null; taskKey: string | null;
  type: string; health: JobHealth;
};
```
3. In `getBoard`, add `type` and two signal subqueries to the select, and load tenant settings, then map health. Replace the select + grouping with:
```typescript
  const tenantId = await getTenantId();
  const rows = await withTenant(tenantId, (tx) =>
    tx.select({
      id: job.id, stage: job.stage, valueEstimate: job.valueEstimate,
      stageEnteredAt: job.stageEnteredAt, type: job.type,
      customerName: customer.name, address: property.address,
      agent: sql<string | null>`(select agent from agent_run where job_id = ${job.id} order by started_at desc limit 1)`,
      taskKey: sql<string | null>`(select task_key from agent_run where job_id = ${job.id} order by started_at desc limit 1)`,
      approvedAt: sql<string | null>`(select entered_at from job_stage_event where job_id = ${job.id} and to_stage = 'approved' order by entered_at asc limit 1)`,
      pastDue: sql<boolean>`exists (select 1 from invoice where job_id = ${job.id} and status in ('sent','overdue') and due_at is not null and due_at < now() and coalesce(amount_paid,0) < coalesce(amount_due,0))`,
    }).from(job)
      .leftJoin(customer, eq(customer.id, job.customerId))
      .leftJoin(property, eq(property.id, job.propertyId))
      .orderBy(desc(job.stageEnteredAt)),
  );

  const [t] = await withTenant(tenantId, (tx) =>
    tx.select({ settings: tenant.settings }).from(tenant).where(eq(tenant.id, tenantId)),
  );
  const config = parseJobsConfig((t?.settings as { jobs?: unknown } | undefined)?.jobs);
  const now = new Date();
```
4. When building each card, compute health from the row:
```typescript
    const health = deriveJobHealth(
      {
        stage: r.stage as JobStage,
        stageEnteredAt: new Date(r.stageEnteredAt as unknown as string),
        type: r.type as JobType,
        approvedAt: r.approvedAt ? new Date(r.approvedAt) : null,
        hasPastDueInvoice: !!r.pastDue,
      },
      config,
      now,
    );
```
and include `type: r.type, health,` in the pushed `BoardCard` (keep `stageEnteredAt` stringified as before). (Match the file's existing grouping shape — only add the two fields.)

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @savvy/web typecheck`
Expected: clean. (No standalone unit test here — `getBoard` depends on `getTenantId()`; behavior is verified by the e2e in Task 6.)

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/lib/pipeline-queries.ts
git commit -m "feat(web): attach derived job health to board cards"
```

---

### Task 6: Board badges + needs-attention filter + e2e (web)

**Files:**
- Modify: `apps/web/src/app/(app)/jobs/board.tsx`
- Create: `apps/web/tests/e2e/jobs-health.spec.ts`

**Interfaces:**
- Consumes: `BoardCard.health` (Task 5).
- Produces: At-risk/Late badges on cards; a "Needs attention (N)" count + filter toggle.

- [ ] **Step 1: Write the failing e2e**

Create `apps/web/tests/e2e/jobs-health.spec.ts` (mirror `pipeline.spec.ts` for tenant/auth setup; seed via `adminDb`/`withTenant`). It seeds a job whose `stageEnteredAt` is far in the past so it is `stuck`, then asserts the board renders an At-risk badge and the needs-attention count:
```typescript
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { withTenant, adminDb, customer, property, job, eq } from "@savvy/db";

const { id: tenantId } = JSON.parse(readFileSync("/tmp/savvy-e2e-tenant.json", "utf8")) as { id: string };

test("a long-idle job shows an At-risk badge on the board", async ({ page }) => {
  const old = new Date(Date.now() - 30 * 86_400_000).toISOString();
  await withTenant(tenantId, async (tx) => {
    const [c] = await tx.insert(customer).values({ tenantId, name: "Risky Rita" }).returning({ id: customer.id });
    const [p] = await tx.insert(property).values({ tenantId, customerId: c!.id, address: "9 Stuck Ln" }).returning({ id: property.id });
    await tx.insert(job).values({ tenantId, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "estimate" }).returning({ id: job.id });
  });
  // Backdate stage entry so the estimate job is stuck (>7d).
  await adminDb.update(job).set({ stageEnteredAt: new Date(old) }).where(and(eq(job.tenantId, tenantId), eq(property.address, "9 Stuck Ln")));

  await page.goto("/jobs");
  await expect(page.getByText("Risky Rita")).toBeVisible();
  await expect(page.getByText(/At risk/i).first()).toBeVisible();
  await expect(page.getByText(/Needs attention/i)).toBeVisible();
});
```
(Adjust the backdate `update` to target the seeded job id you captured from the insert — simpler than joining on address; capture `jobId` from the `returning` and `eq(job.id, jobId)`. Match `pipeline.spec.ts` for how it resolves `TEST_TENANT_ID` and auth/storage state.)

- [ ] **Step 2: Run e2e to verify it fails**

Run: `pnpm db:up && cd apps/web && npx tsx tests/e2e/create-tenant.ts && export TEST_TENANT_ID=$(node -e "console.log(require('/tmp/savvy-e2e-tenant.json').id)") && ./node_modules/.bin/playwright test tests/e2e/jobs-health.spec.ts`
Expected: FAIL — no "At risk" badge rendered yet.

- [ ] **Step 3: Render badges + needs-attention in the board**

In `apps/web/src/app/(app)/jobs/board.tsx`:
1. On each card, after the days-in-stage line, render badges from `card.health` (use the existing Tailwind/shadcn badge styling already in the file; do not hardcode colors that break dark mode):
```tsx
{card.health.stuck && (
  <span title={card.health.reasons.join("; ")} className="rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">At risk</span>
)}
{card.health.late && (
  <span title={card.health.reasons.join("; ")} className="rounded bg-red-100 px-1.5 py-0.5 text-xs font-medium text-red-800 dark:bg-red-900/40 dark:text-red-200">Late</span>
)}
```
2. Compute the needs-attention count across all columns and render it in the board header with a filter toggle (use the board's existing client `useState`; default off):
```tsx
const needsAttention = Object.values(byStage).flat().filter((c) => c.health.stuck || c.health.late);
// header:
<button onClick={() => setOnlyAttention((v) => !v)} className="text-sm font-medium underline-offset-2 hover:underline">
  Needs attention ({needsAttention.length})
</button>
// when rendering a column's cards, filter when onlyAttention is true:
const visible = onlyAttention ? cards.filter((c) => c.health.stuck || c.health.late) : cards;
```
(Wire `onlyAttention`/`setOnlyAttention` via `useState(false)` in the existing client component; match the file's prop/threading style.)

- [ ] **Step 4: Run e2e to verify it passes**

Run: `./node_modules/.bin/playwright test tests/e2e/jobs-health.spec.ts` (from `apps/web`, with `TEST_TENANT_ID` exported as above)
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm --filter @savvy/web typecheck` → clean.
```bash
git add "apps/web/src/app/(app)/jobs/board.tsx" apps/web/tests/e2e/jobs-health.spec.ts
git commit -m "feat(web): At-risk/Late badges + needs-attention filter on the jobs board"
```

---

### Task 7: Pipeline doc + full verification

**Files:**
- Create: `docs/jobs-pipeline.md`

- [ ] **Step 1: Write the doc**

Create `docs/jobs-pipeline.md` covering: the 9-stage model; the event→stage map (`estimate/accepted→approved`, `invoice/sent→billing`, `invoice/paid→complete`, with material/GPS/photo events marked "future pieces C/D"); the health derivation (`stuck` = days-in-stage > `settings.jobs.stageThresholds[stage]`; `late` = past `approvedAt + buildSlaDays[type]` or a past-due invoice); the `leadToJobType` heuristic and its limitation; and a "How to tune" section showing the `tenant.settings.jobs` shape with defaults. Note that health is computed on read (no backfill) and that invoice→billing is forward-only and may skip an unreached close-out (the photo gate still applies on `complete`).

- [ ] **Step 2: Full suite + typecheck + lint**

Run: `pnpm db:up && pnpm --filter @savvy/db db:migrate && pnpm test && pnpm typecheck && pnpm lint`
Expected: green (pre-existing `scheduling.ts` unused-var and `pipeline.spec.ts` unused-import warnings only).

- [ ] **Step 3: Commit**

```bash
git add docs/jobs-pipeline.md
git commit -m "docs(jobs): pipeline stage/event map, health derivation, and tuning guide"
```

---

## Self-Review (completed by plan author)

- **Spec coverage:** §3.1 config → Task 1; §3.2 deriveJobHealth → Task 2; §3.3 job.type carryover (storm→insurance heuristic) → Task 3; §3.4 invoice→stage (forward-only, gate-aware) → Task 4; §3.5 board badges + needs-attention → Tasks 5–6; §5 testing → each task's tests; §7 repo doc → Task 7. Non-goals (exception queue J, material/GPS/photo events C/D, weighted Command Center H.2, new columns/migration) are untouched.
- **Placeholder scan:** none. "Confirm against sibling/schema" notes are read-an-existing-pattern instructions (the established way to match fixtures/columns), not logic placeholders.
- **Type consistency:** `JobsConfig` (Task 1) consumed by `deriveJobHealth` (Task 2) and `getBoard` (Task 5). `JobHealthSignals`/`JobHealth` names match between Task 2 and Tasks 5–6. `leadToJobType(lane)` signature matches its Task 3 call site. `syncInvoiceStage(tenantId, invoiceId, toStage)` matches between Task 4 definition and its Inngest call sites. Enum string literals (`"storm"`, `"approved"`, `"billing"`, `"complete"`) match the verbatim enums in Global Constraints.
- **Determinism / isolation:** derivation is pure (no AI); all DB access tenant-scoped; Inngest fns idempotent + forward-only; no new columns or migration.
