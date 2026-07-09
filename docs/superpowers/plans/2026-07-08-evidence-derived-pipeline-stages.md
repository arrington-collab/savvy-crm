# Evidence-Derived Pipeline Stages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a job's pipeline stage a consequence of evidence — forward transitions are rejected at the single write path unless the job has the contiguous evidence for the target stage, existing over-declared jobs are re-derived, and an exception vector catches bypasses.

**Architecture:** A pure `@savvy/core` module derives the contiguous evidence stage; a db evidence-gatherer reads the existing tables; the gate lives inside `recordStageChange` (the only `job.stage` writer) so every caller is covered; `convertLeadToJob` lands jobs at their derived stage; an idempotent script re-derives all jobs; an unbound invariant + an exception-queue vector surface violations; the board's waiting-on line names the next missing artifact.

**Tech Stack:** TypeScript, Drizzle/Postgres (RLS via `withTenant`), Next.js App Router, Vitest, Playwright.

## Global Constraints

- **Contiguous evidence model** — a job may be at stage S only with evidence for every gated stage from `inspected` up to S.
- **Single write path** — all gating lives in `recordStageChange`; never add a second `job.stage` writer.
- **No migration** — evidence is in existing tables; backward-reason uses the existing `job_stage_event.note`; the exception vector is a derived check; the `job.stage_evidence` invariant is **unbound** (no `CHECK_BINDINGS`/bound-set-test change).
- **Terminal `lost` is exempt** from the new evidence + reason gates (keeps the existing chargeback path).
- **Tenant isolation** on every query (`withTenant`/RLS).
- Evidence facts (verbatim): appointment status enum is `scheduled|done|canceled|no_show` (finished = **`done`**, not `completed`); inspection = `appointment type='inspection' status='done'` (job or lead) OR `document kind='photo'` (job or lead); estimate = an `estimate` row (job or lead); approval = `estimate.status='accepted'` (job or lead) OR `document.kind='contract'` (job or lead); production = `appointment type='crew' status='scheduled'` (job) OR `material_order status in ('ordered','delivered')` (job); closeout = `missingProductionPhotos` empty; billing = an `invoice` row (job); paid = `invoice.status='paid'` (job).
- Test commands: `pnpm --filter @savvy/core exec vitest run <file>`, `pnpm --filter @savvy/db exec vitest run <file>`, `pnpm -w typecheck`, `pnpm -w lint`. Ignore the shared-Postgres `health-sweep.test.ts` teardown flake. DB fixtures: `makeTenant`, `makeJobWithProperty`, `makeLeadWithProperty` from `packages/db/tests/helpers.js`.

---

### Task 1: Core evidence model (`@savvy/core`)

**Files:**
- Create: `packages/core/src/stage-evidence.ts`
- Modify: `packages/core/src/index.ts` (barrel)
- Test: `packages/core/src/stage-evidence.test.ts`

**Interfaces:**
- Produces: `interface StageEvidence { inspection: boolean; estimate: boolean; approval: boolean; production: boolean; closeoutPhotos: boolean; invoice: boolean; invoicePaid: boolean }`; `deriveContiguousStage(ev): JobStage`; `missingEvidenceFor(stage: JobStage, ev): string | null`; `stageEvidenceSatisfied(stage: JobStage, ev): boolean`; `STAGE_EVIDENCE_LABEL: Record<string,string>`.

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/stage-evidence.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { deriveContiguousStage, missingEvidenceFor, stageEvidenceSatisfied, type StageEvidence } from "./stage-evidence";

const NONE: StageEvidence = { inspection: false, estimate: false, approval: false, production: false, closeoutPhotos: false, invoice: false, invoicePaid: false };
const ev = (p: Partial<StageEvidence>): StageEvidence => ({ ...NONE, ...p });

describe("deriveContiguousStage", () => {
  it("no evidence → lead (the Josh case)", () => {
    expect(deriveContiguousStage(NONE)).toBe("lead");
  });
  it("inspection only → inspected", () => {
    expect(deriveContiguousStage(ev({ inspection: true }))).toBe("inspected");
  });
  it("funnel chain (inspection+estimate+approval) → approved", () => {
    expect(deriveContiguousStage(ev({ inspection: true, estimate: true, approval: true }))).toBe("approved");
  });
  it("is contiguous — approval without inspection → lead (gap at inspection)", () => {
    expect(deriveContiguousStage(ev({ approval: true }))).toBe("lead");
  });
  it("full chain to billing", () => {
    expect(deriveContiguousStage(ev({ inspection: true, estimate: true, approval: true, production: true, closeoutPhotos: true, invoice: true }))).toBe("billing");
  });
});

describe("missingEvidenceFor", () => {
  it("names the first missing gate up to the target", () => {
    expect(missingEvidenceFor("approved", NONE)).toBe("inspection");
    expect(missingEvidenceFor("approved", ev({ inspection: true }))).toBe("estimate");
    expect(missingEvidenceFor("approved", ev({ inspection: true, estimate: true }))).toBe("approval");
    expect(missingEvidenceFor("approved", ev({ inspection: true, estimate: true, approval: true }))).toBeNull();
  });
  it("lead/lost have no gate", () => {
    expect(missingEvidenceFor("lead", NONE)).toBeNull();
    expect(missingEvidenceFor("lost", NONE)).toBeNull();
  });
});

describe("stageEvidenceSatisfied (own-stage, for the exception vector)", () => {
  it("inspected requires inspection; independent of other gates", () => {
    expect(stageEvidenceSatisfied("inspected", NONE)).toBe(false);
    expect(stageEvidenceSatisfied("inspected", ev({ inspection: true }))).toBe(true);
  });
  it("lead/lost always satisfied", () => {
    expect(stageEvidenceSatisfied("lead", NONE)).toBe(true);
    expect(stageEvidenceSatisfied("lost", NONE)).toBe(true);
  });
  it("production satisfied by production evidence alone (own-stage)", () => {
    expect(stageEvidenceSatisfied("production", ev({ production: true }))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @savvy/core exec vitest run src/stage-evidence.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `packages/core/src/stage-evidence.ts`:

```ts
import type { JobStage } from "./enums";

export interface StageEvidence {
  inspection: boolean;
  estimate: boolean;
  approval: boolean;
  production: boolean;
  closeoutPhotos: boolean;
  invoice: boolean;
  invoicePaid: boolean;
}

// Gated stages in ladder order, each with the evidence key it requires + a human label.
const GATED: { stage: JobStage; key: keyof StageEvidence; label: string }[] = [
  { stage: "inspected", key: "inspection", label: "inspection" },
  { stage: "estimate", key: "estimate", label: "estimate" },
  { stage: "approved", key: "approval", label: "approval" },
  { stage: "production", key: "production", label: "crew or materials" },
  { stage: "closeout", key: "closeoutPhotos", label: "completion photos" },
  { stage: "billing", key: "invoice", label: "invoice" },
  { stage: "complete", key: "invoicePaid", label: "paid invoice" },
];

export const STAGE_EVIDENCE_LABEL: Record<string, string> = Object.fromEntries(GATED.map((g) => [g.stage, g.label]));

/** Highest stage whose evidence chain from 'inspected' up is unbroken; 'lead' if the first gate fails. */
export function deriveContiguousStage(ev: StageEvidence): JobStage {
  let derived: JobStage = "lead";
  for (const g of GATED) {
    if (!ev[g.key]) break;
    derived = g.stage;
  }
  return derived;
}

/** Label of the first missing gate at/below `stage` — what the job still needs to reach it. */
export function missingEvidenceFor(stage: JobStage, ev: StageEvidence): string | null {
  const target = GATED.findIndex((g) => g.stage === stage);
  if (target < 0) return null; // lead / lost — ungated
  for (let i = 0; i <= target; i++) {
    if (!ev[GATED[i]!.key]) return GATED[i]!.label;
  }
  return null;
}

/** Own-stage predicate: does the job hold the evidence its CURRENT stage requires? */
export function stageEvidenceSatisfied(stage: JobStage, ev: StageEvidence): boolean {
  const g = GATED.find((x) => x.stage === stage);
  return g ? ev[g.key] : true; // lead/lost ungated
}
```

Add to `packages/core/src/index.ts`: `export * from "./stage-evidence";`

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @savvy/core exec vitest run src/stage-evidence.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core
git commit -m "feat(pipeline): contiguous stage-evidence model (core)"
```

---

### Task 2: Evidence gatherer (`@savvy/db`)

**Files:**
- Create: `packages/db/src/lifecycle/stage-evidence-db.ts`
- Modify: `packages/db/src/index.ts` (barrel)
- Test: `packages/db/tests/stage-evidence-db.test.ts`

**Interfaces:**
- Consumes: `StageEvidence` (Task 1).
- Produces: `gatherStageEvidence(tx: Tx, input: { tenantId: string; jobId: string }): Promise<StageEvidence>`.

- [ ] **Step 1: Write the failing test**

Create `packages/db/tests/stage-evidence-db.test.ts`:

```ts
import { afterAll, expect, it } from "vitest";
import { withTenant } from "../src/tenant.js";
import { adminDb, adminPool, eq } from "../src/index.js";
import { tenant, job, estimate, document, appointment } from "../src/schema/index.js";
import { gatherStageEvidence } from "../src/lifecycle/stage-evidence-db.js";
import { makeTenant, makeJobWithProperty } from "./helpers.js";

const tids: string[] = [];
afterAll(async () => {
  for (const t of tids) await adminDb.delete(tenant).where(eq(tenant.id, t)).catch(() => {});
  await adminPool.end();
});

it("no evidence → all false", async () => {
  const { tenantId } = await makeTenant(); tids.push(tenantId);
  const { jobId } = await makeJobWithProperty(tenantId);
  const ev = await withTenant(tenantId, (tx) => gatherStageEvidence(tx, { tenantId, jobId }));
  expect(ev.inspection).toBe(false);
  expect(ev.estimate).toBe(false);
  expect(ev.approval).toBe(false);
});

it("a photo doc → inspection true; an estimate row → estimate true; an accepted estimate → approval true", async () => {
  const { tenantId } = await makeTenant(); tids.push(tenantId);
  const { jobId, propertyId } = await makeJobWithProperty(tenantId);
  await adminDb.insert(document).values({ tenantId, jobId, propertyId, kind: "photo", r2Key: "k" });
  await adminDb.insert(estimate).values({ tenantId, jobId, propertyId, status: "accepted", lineItems: [] });
  const ev = await withTenant(tenantId, (tx) => gatherStageEvidence(tx, { tenantId, jobId }));
  expect(ev.inspection).toBe(true);
  expect(ev.estimate).toBe(true);
  expect(ev.approval).toBe(true);
});

it("a done inspection appointment → inspection true", async () => {
  const { tenantId } = await makeTenant(); tids.push(tenantId);
  const { jobId, propertyId } = await makeJobWithProperty(tenantId);
  await adminDb.insert(appointment).values({ tenantId, jobId, propertyId, type: "inspection", status: "done", startsAt: new Date(), endsAt: new Date() });
  const ev = await withTenant(tenantId, (tx) => gatherStageEvidence(tx, { tenantId, jobId }));
  expect(ev.inspection).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @savvy/db exec vitest run tests/stage-evidence-db.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `packages/db/src/lifecycle/stage-evidence-db.ts`:

```ts
import { and, eq, or, inArray, sql } from "drizzle-orm";
import { job } from "../schema/jobs";
import { appointment } from "../schema/comms";
import { estimate, invoice } from "../schema/finance";
import { document } from "../schema/ops";
import { materialOrder } from "../schema/procurement";
import { db } from "../client";
import type { StageEvidence } from "@savvy/core";
import { missingProductionPhotos } from "./production-signals";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Read the evidence booleans for one job from the existing tables (job- and lead-scoped). */
export async function gatherStageEvidence(tx: Tx, input: { tenantId: string; jobId: string }): Promise<StageEvidence> {
  const [j] = await tx.select({ leadId: job.leadId }).from(job).where(eq(job.id, input.jobId));
  const leadId = j?.leadId ?? null;
  // job-or-lead scoping for pre-job (lead-scoped) evidence
  const jobOrLead = (jobCol: unknown, leadCol: unknown) =>
    leadId ? or(eq(jobCol as never, input.jobId), eq(leadCol as never, leadId)) : eq(jobCol as never, input.jobId);
  const exists = async (rows: Promise<{ x: number }[]>) => (await rows).length > 0;

  const inspectionAppt = exists(
    tx.select({ x: sql<number>`1` }).from(appointment)
      .where(and(jobOrLead(appointment.jobId, appointment.leadId), eq(appointment.type, "inspection"), eq(appointment.status, "done"))).limit(1),
  );
  const anyPhoto = exists(
    tx.select({ x: sql<number>`1` }).from(document)
      .where(and(jobOrLead(document.jobId, document.leadId), eq(document.kind, "photo"))).limit(1),
  );
  const anyEstimate = exists(
    tx.select({ x: sql<number>`1` }).from(estimate).where(jobOrLead(estimate.jobId, estimate.leadId)).limit(1),
  );
  const acceptedEstimate = exists(
    tx.select({ x: sql<number>`1` }).from(estimate).where(and(jobOrLead(estimate.jobId, estimate.leadId), eq(estimate.status, "accepted"))).limit(1),
  );
  const contractDoc = exists(
    tx.select({ x: sql<number>`1` }).from(document).where(and(jobOrLead(document.jobId, document.leadId), eq(document.kind, "contract"))).limit(1),
  );
  const crewScheduled = exists(
    tx.select({ x: sql<number>`1` }).from(appointment).where(and(eq(appointment.jobId, input.jobId), eq(appointment.type, "crew"), eq(appointment.status, "scheduled"))).limit(1),
  );
  const materialsOrdered = exists(
    tx.select({ x: sql<number>`1` }).from(materialOrder).where(and(eq(materialOrder.jobId, input.jobId), inArray(materialOrder.status, ["ordered", "delivered"]))).limit(1),
  );
  const anyInvoice = exists(
    tx.select({ x: sql<number>`1` }).from(invoice).where(eq(invoice.jobId, input.jobId)).limit(1),
  );
  const paidInvoice = exists(
    tx.select({ x: sql<number>`1` }).from(invoice).where(and(eq(invoice.jobId, input.jobId), eq(invoice.status, "paid"))).limit(1),
  );

  const [insp, photo, est, acc, contract, crew, mats, inv, paid, missPhotos] = await Promise.all([
    inspectionAppt, anyPhoto, anyEstimate, acceptedEstimate, contractDoc, crewScheduled, materialsOrdered, anyInvoice, paidInvoice,
    missingProductionPhotos(tx, input.tenantId, input.jobId),
  ]);

  return {
    inspection: insp || photo,
    estimate: est,
    approval: acc || contract,
    production: crew || mats,
    closeoutPhotos: missPhotos.length === 0,
    invoice: inv,
    invoicePaid: paid,
  };
}
```

Add to `packages/db/src/index.ts`: `export { gatherStageEvidence } from "./lifecycle/stage-evidence-db";`

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @savvy/db exec vitest run tests/stage-evidence-db.test.ts`
Expected: PASS. (If the drizzle `jobOrLead` helper's `unknown` casts fight tsc, type the columns explicitly — `or(eq(appointment.jobId, input.jobId), eq(appointment.leadId, leadId))` inline per query instead of the helper; both compile, inline is simplest.)

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/lifecycle/stage-evidence-db.ts packages/db/src/index.ts packages/db/tests/stage-evidence-db.test.ts
git commit -m "feat(pipeline): gatherStageEvidence db reader"
```

---

### Task 3: Evidence gate at the write path (`recordStageChange`)

**Files:**
- Modify: `packages/db/src/lifecycle/record-stage-change.ts`
- Modify: `packages/db/src/lifecycle/advance-stage.ts` (catch the new error)
- Modify: `packages/db/src/index.ts` (export error classes)
- Test: `packages/db/tests/stage-evidence-gate.test.ts`

**Interfaces:**
- Consumes: `gatherStageEvidence` (Task 2), `deriveContiguousStage`/`missingEvidenceFor` (Task 1).
- Produces: `class StageEvidenceError extends Error { missing: string | null }`; `class BackwardNeedsReasonError extends Error`; `recordStageChange` gains `reason?: string`.

- [ ] **Step 1: Write the failing test (red-path per gate)**

Create `packages/db/tests/stage-evidence-gate.test.ts`:

```ts
import { afterAll, expect, it } from "vitest";
import { withTenant } from "../src/tenant.js";
import { adminDb, adminPool, eq, recordStageChange, StageEvidenceError, BackwardNeedsReasonError } from "../src/index.js";
import { tenant, job, estimate, document, jobStageEvent } from "../src/schema/index.js";
import { makeTenant, makeJobWithProperty } from "./helpers.js";

const tids: string[] = [];
afterAll(async () => { for (const t of tids) await adminDb.delete(tenant).where(eq(tenant.id, t)).catch(() => {}); await adminPool.end(); });

async function jobAt(stage: string) {
  const { tenantId } = await makeTenant(); tids.push(tenantId);
  const { jobId, propertyId } = await makeJobWithProperty(tenantId);
  await adminDb.update(job).set({ stage: stage as never }).where(eq(job.id, jobId));
  return { tenantId, jobId, propertyId };
}

it("forward to inspected without inspection evidence is REJECTED", async () => {
  const { tenantId, jobId } = await jobAt("lead");
  await expect(withTenant(tenantId, (tx) => recordStageChange(tx, { tenantId, jobId, toStage: "inspected" })))
    .rejects.toBeInstanceOf(StageEvidenceError);
});

it("forward to estimate without an estimate is REJECTED even with inspection", async () => {
  const { tenantId, jobId, propertyId } = await jobAt("inspected");
  await adminDb.insert(document).values({ tenantId, jobId, propertyId, kind: "photo", r2Key: "k" }); // satisfies inspected
  await expect(withTenant(tenantId, (tx) => recordStageChange(tx, { tenantId, jobId, toStage: "estimate" })))
    .rejects.toBeInstanceOf(StageEvidenceError);
});

it("forward passes when the contiguous chain is present", async () => {
  const { tenantId, jobId, propertyId } = await jobAt("inspected");
  await adminDb.insert(document).values({ tenantId, jobId, propertyId, kind: "photo", r2Key: "k" });
  await adminDb.insert(estimate).values({ tenantId, jobId, propertyId, status: "draft", lineItems: [] });
  const r = await withTenant(tenantId, (tx) => recordStageChange(tx, { tenantId, jobId, toStage: "estimate" }));
  expect(r.fromStage).toBe("inspected");
});

it("backward transition without a reason is REJECTED; with a reason it records the note", async () => {
  const { tenantId, jobId, propertyId } = await jobAt("estimate");
  await expect(withTenant(tenantId, (tx) => recordStageChange(tx, { tenantId, jobId, toStage: "lead" })))
    .rejects.toBeInstanceOf(BackwardNeedsReasonError);
  await withTenant(tenantId, (tx) => recordStageChange(tx, { tenantId, jobId, toStage: "lead", reason: "manual correction" }));
  const [ev] = await adminDb.select().from(jobStageEvent).where(eq(jobStageEvent.jobId, jobId)).orderBy(jobStageEvent.enteredAt);
  expect(ev!.note).toBe("manual correction");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @savvy/db exec vitest run tests/stage-evidence-gate.test.ts`
Expected: FAIL — errors not exported / no gate.

- [ ] **Step 3: Implement**

In `packages/db/src/lifecycle/record-stage-change.ts`: add imports + error classes, then the gate. Add to the top imports:

```ts
import { JOB_STAGE, deriveContiguousStage, missingEvidenceFor } from "@savvy/core";
import { gatherStageEvidence } from "./stage-evidence-db";
```

Add the error classes near `IncompletePhotosError`:

```ts
export class StageEvidenceError extends Error {
  missing: string | null;
  constructor(missing: string | null) {
    super(missing ? `stage requires evidence: ${missing}` : "stage requires evidence");
    this.name = "StageEvidenceError";
    this.missing = missing;
  }
}
export class BackwardNeedsReasonError extends Error {
  constructor(public readonly fromStage: string, public readonly toStage: string) {
    super(`backward transition ${fromStage}→${toStage} requires a reason`);
    this.name = "BackwardNeedsReasonError";
  }
}
```

Add `reason?: string` to the `opts` param type. Move the current-stage read to the TOP of the function (before the existing gates) and add the evidence/reason gate. Replace the existing `complete`-gate block start so the function begins:

```ts
export async function recordStageChange(
  tx: Tx,
  opts: { tenantId: string; jobId: string; toStage: JobStage; byUserId?: string | null; byAgent?: Agent | null; now?: Date; reason?: string },
): Promise<{ activated: number; fromStage: JobStage | null }> {
  const now = opts.now ?? new Date();
  const [current] = await tx.select({ stage: job.stage }).from(job).where(eq(job.id, opts.jobId));
  const fromStage = (current?.stage ?? null) as JobStage | null;

  // Evidence gate — a job's stage is a consequence of evidence. `lost` is exempt (terminal).
  if (opts.toStage !== "lost" && fromStage) {
    const toIdx = JOB_STAGE.indexOf(opts.toStage);
    const fromIdx = JOB_STAGE.indexOf(fromStage);
    if (toIdx > fromIdx) {
      const ev = await gatherStageEvidence(tx, { tenantId: opts.tenantId, jobId: opts.jobId });
      if (toIdx > JOB_STAGE.indexOf(deriveContiguousStage(ev))) {
        throw new StageEvidenceError(missingEvidenceFor(opts.toStage, ev));
      }
    } else if (toIdx < fromIdx) {
      if (!opts.reason) throw new BackwardNeedsReasonError(fromStage, opts.toStage);
    }
  }

  if (opts.toStage === "complete") {
    const missing = await missingProductionPhotos(tx, opts.tenantId, opts.jobId);
    if (missing.length > 0) throw new IncompletePhotosError(missing);
  }
```

Then delete the now-duplicated `const now = …` / current-stage read that lived lower down (the block that set `const now = opts.now ?? new Date();` and `const [current] = …`/`fromStage` around the original lines 60-62) — keep the rest (update, event insert, task activation, chargeback, audit). In the `jobStageEvent` insert add `note: opts.reason ?? null`:

```ts
  await tx.insert(jobStageEvent).values({
    tenantId: opts.tenantId, jobId: opts.jobId, fromStage, toStage: opts.toStage,
    enteredAt: now, byUserId: opts.byUserId ?? null, byAgent: opts.byAgent ?? null,
    note: opts.reason ?? null,
  });
```

In `packages/db/src/lifecycle/advance-stage.ts`, catch the new error alongside the existing ones:

```ts
  } catch (e) {
    if (e instanceof Error && e.name === "IncompletePhotosError") return { skipped: "photo_gate" };
    if (e instanceof Error && e.name === "IncompleteDocumentsError") return { skipped: "doc_gate" };
    if (e instanceof Error && e.name === "StageEvidenceError") return { skipped: "evidence_gate" };
    throw e;
  }
```

Export the error classes from `packages/db/src/index.ts` (the line that re-exports `record-stage-change`): add `StageEvidenceError, BackwardNeedsReasonError` to the `export { recordStageChange, IncompletePhotosError, IncompleteDocumentsError } from "./lifecycle/record-stage-change";`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @savvy/db exec vitest run tests/stage-evidence-gate.test.ts tests/advance-stage-forward.test.ts tests/stage-gate.test.ts`
Expected: PASS (new gate + no regression in forward/photo/doc gates).

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/lifecycle/record-stage-change.ts packages/db/src/lifecycle/advance-stage.ts packages/db/src/index.ts packages/db/tests/stage-evidence-gate.test.ts
git commit -m "feat(pipeline): evidence gate + backward-reason at the stage write path"
```

---

### Task 4: Fix `convertLeadToJob` (land at derived stage + manual-job guard)

**Files:**
- Modify: `packages/db/src/lifecycle/appointments.ts` (`convertLeadToJob`)
- Modify: `packages/db/src/index.ts` (export `ManualJobEvidenceError`)
- Test: `packages/db/src/lifecycle/convert-lead-to-job.test.ts` (extend)

**Interfaces:**
- Consumes: `gatherStageEvidence` (Task 2), `deriveContiguousStage` (Task 1), `recordStageChange` (Task 3).
- Produces: `convertLeadToJob` gains `reason?: string`; new `class ManualJobEvidenceError extends Error`.

- [ ] **Step 1: Write the failing test**

Add to `packages/db/src/lifecycle/convert-lead-to-job.test.ts`:

```ts
import { ManualJobEvidenceError, document as documentTbl } from "../index.js";

it("does NOT jump to inspected without evidence — a bare manual job lands at lead", async () => {
  const tid = await mkTenant("ctj-derive-lead");
  const leadId = await mkLead(tid, "standard");
  const { jobId } = await convertLeadToJob({ tenantId: tid, leadId, manualJob: true, reason: "insurance emergency" });
  const [j] = await adminDb.select({ stage: job.stage }).from(job).where(eq(job.id, jobId));
  expect(j!.stage).toBe("lead");
});

it("manualJob without a contract doc AND without a reason is rejected", async () => {
  const tid = await mkTenant("ctj-manual-guard");
  const leadId = await mkLead(tid, "standard");
  await expect(convertLeadToJob({ tenantId: tid, leadId, manualJob: true })).rejects.toBeInstanceOf(ManualJobEvidenceError);
});

it("a funnel job (accepted estimate + inspection) lands at approved, not inspected", async () => {
  const tid = await mkTenant("ctj-derive-approved");
  const leadId = await mkLead(tid, "standard");
  // inspection evidence (photo) + accepted estimate on the lead
  const [l] = await adminDb.select({ propertyId: lead.propertyId }).from(lead).where(eq(lead.id, leadId));
  await adminDb.insert(documentTbl).values({ tenantId: tid, leadId, propertyId: l!.propertyId, kind: "photo", r2Key: "k" });
  await adminDb.insert(estimate).values({ tenantId: tid, leadId, propertyId: l!.propertyId, status: "accepted", lineItems: [] });
  const { jobId } = await convertLeadToJob({ tenantId: tid, leadId });
  const [j] = await adminDb.select({ stage: job.stage }).from(job).where(eq(job.id, jobId));
  expect(j!.stage).toBe("approved");
});
```

Ensure `lead`, `estimate`, `job`, `eq`, `adminDb` are imported in that test file (it already imports `job`, `adminDb`, `eq`; add `lead`, `estimate`).

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @savvy/db exec vitest run src/lifecycle/convert-lead-to-job.test.ts`
Expected: FAIL — job lands at `inspected` (old behavior); `ManualJobEvidenceError` not exported.

- [ ] **Step 3: Implement**

In `packages/db/src/lifecycle/appointments.ts`:

Add the error class near the other error classes:

```ts
export class ManualJobEvidenceError extends Error {
  constructor() {
    super("manualJob requires a contract document on the lead or an explicit reason");
    this.name = "ManualJobEvidenceError";
  }
}
```

Add `document` to the schema imports if not present (it is — used by `stampCerts`). Add `reason?: string` to the `convertLeadToJob` args type.

In the create path, before inserting the job, enforce the manual-job guard (after the accepted-estimate check block):

```ts
    if (!accepted && !args.manualJob) {
      throw new Error("cannot create job: lead has no accepted estimate (use manualJob for out-of-funnel jobs)");
    }
    if (args.manualJob && !accepted) {
      const [contract] = await tx.select({ id: document.id }).from(document)
        .where(and(eq(document.leadId, l.id), eq(document.kind, "contract")));
      if (!contract && !args.reason) throw new ManualJobEvidenceError();
    }
```

Replace the unconditional advance line:

```ts
    await recordStageChange(tx, { tenantId: args.tenantId, jobId: newJob!.id, toStage: "inspected", byAgent: "orchestrator" });
```

with an evidence-derived landing:

```ts
    // Stage is a consequence of evidence: land the job where its evidence supports, not a
    // blanket 'inspected'. Funnel (accepted estimate + inspection) → approved; a bare
    // manual/canvass job (no inspection) → stays 'lead'.
    const ev = await gatherStageEvidence(tx, { tenantId: args.tenantId, jobId: newJob!.id });
    const derived = deriveContiguousStage(ev);
    if (derived !== "lead") {
      await recordStageChange(tx, { tenantId: args.tenantId, jobId: newJob!.id, toStage: derived, byAgent: "orchestrator", reason: args.reason ?? "evidence-derived on convert" });
    }
```

Add imports at the top of `appointments.ts`: `deriveContiguousStage` from `@savvy/core` (extend the existing `@savvy/core` import) and `gatherStageEvidence` from `./stage-evidence-db`.

Export `ManualJobEvidenceError` from `packages/db/src/index.ts` (the appointments re-export line, next to `RescissionHoldError`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @savvy/db exec vitest run src/lifecycle/convert-lead-to-job.test.ts src/lifecycle/convert-carryover.test.ts` and `pnpm --filter @savvy/db exec vitest run tests/canvass-conversion.test.ts`
Expected: PASS. Note `canvass-conversion.test.ts` expects a WON job at `lead` (canvass has a contract but no inspection → derived `lead`); confirm it still asserts `lead` (the canvass test seeds no inspection, so the job lands at `lead` — update that test's stage assertion if it asserted otherwise).

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/lifecycle/appointments.ts packages/db/src/index.ts packages/db/src/lifecycle/convert-lead-to-job.test.ts
git commit -m "feat(pipeline): convert lands job at evidence-derived stage + manual-job guard"
```

---

### Task 5: Re-derive script

**Files:**
- Create: `packages/db/src/scripts/rederive-job-stages.ts`
- Test: `packages/db/tests/rederive-job-stages.test.ts`

**Interfaces:**
- Consumes: `gatherStageEvidence` (Task 2), `deriveContiguousStage` (Task 1).
- Produces: `rederiveJobStages(opts: { dryRun: boolean }): Promise<{ scanned: number; changes: { jobId: string; from: string; to: string }[] }>` (exported from the script for testing; a `main()` wraps it for CLI).

- [ ] **Step 1: Write the failing test**

Create `packages/db/tests/rederive-job-stages.test.ts`:

```ts
import { afterAll, expect, it } from "vitest";
import { adminDb, adminPool, eq } from "../src/index.js";
import { tenant, job } from "../src/schema/index.js";
import { rederiveJobStages } from "../src/scripts/rederive-job-stages.js";
import { makeTenant, makeJobWithProperty } from "./helpers.js";

const tids: string[] = [];
afterAll(async () => { for (const t of tids) await adminDb.delete(tenant).where(eq(tenant.id, t)).catch(() => {}); await adminPool.end(); });

it("regresses an over-declared job (inspected, no evidence) to lead; idempotent", async () => {
  const { tenantId } = await makeTenant(); tids.push(tenantId);
  const { jobId } = await makeJobWithProperty(tenantId);
  await adminDb.update(job).set({ stage: "inspected" }).where(eq(job.id, jobId)); // Josh: declared, no evidence

  const dry = await rederiveJobStages({ dryRun: true });
  expect(dry.changes.find((c) => c.jobId === jobId)).toMatchObject({ from: "inspected", to: "lead" });
  const [before] = await adminDb.select({ stage: job.stage }).from(job).where(eq(job.id, jobId));
  expect(before!.stage).toBe("inspected"); // dry-run wrote nothing

  await rederiveJobStages({ dryRun: false });
  const [after] = await adminDb.select({ stage: job.stage }).from(job).where(eq(job.id, jobId));
  expect(after!.stage).toBe("lead");

  const again = await rederiveJobStages({ dryRun: false });
  expect(again.changes.find((c) => c.jobId === jobId)).toBeUndefined(); // idempotent
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @savvy/db exec vitest run tests/rederive-job-stages.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `packages/db/src/scripts/rederive-job-stages.ts`:

```ts
/**
 * Re-derive every job's stage from its evidence (contiguous model). Regresses over-declared
 * jobs (e.g. a job left at 'inspected' with no inspection) and promotes fully-evidenced ones.
 * Idempotent. Writes a corrective job_stage_event (note) per change. Data-only, no schema.
 *
 * Usage (local):  pnpm --filter @savvy/db exec tsx src/scripts/rederive-job-stages.ts [--dry-run]
 * Usage (prod):   DATABASE_ADMIN_URL="<prod-admin-url>" pnpm --filter @savvy/db exec tsx src/scripts/rederive-job-stages.ts --dry-run
 */
import { eq } from "drizzle-orm";
import { adminDb, adminPool } from "../admin-client";
import { withTenant } from "../tenant";
import { job, jobStageEvent } from "../schema/index";
import { deriveContiguousStage } from "@savvy/core";
import { gatherStageEvidence } from "../lifecycle/stage-evidence-db";

export async function rederiveJobStages(opts: { dryRun: boolean }): Promise<{ scanned: number; changes: { jobId: string; tenantId: string; from: string; to: string }[] }> {
  const jobs = await adminDb.select({ id: job.id, tenantId: job.tenantId, stage: job.stage }).from(job);
  const changes: { jobId: string; tenantId: string; from: string; to: string }[] = [];
  for (const j of jobs) {
    const derived = await withTenant(j.tenantId, (tx) => gatherStageEvidence(tx, { tenantId: j.tenantId, jobId: j.id }).then(deriveContiguousStage));
    if (derived === j.stage) continue;
    changes.push({ jobId: j.id, tenantId: j.tenantId, from: j.stage, to: derived });
    if (!opts.dryRun) {
      await withTenant(j.tenantId, async (tx) => {
        await tx.update(job).set({ stage: derived, stageEnteredAt: new Date() }).where(eq(job.id, j.id));
        await tx.insert(jobStageEvent).values({ tenantId: j.tenantId, jobId: j.id, fromStage: j.stage, toStage: derived, byAgent: "orchestrator", note: "re-derive: evidence-supported stage" });
      });
    }
  }
  return { scanned: jobs.length, changes };
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const { scanned, changes } = await rederiveJobStages({ dryRun });
  console.log(`scanned ${scanned} job(s); ${changes.length} would change`);
  const regressions = changes.filter((c) => c.from !== "lead");
  for (const c of changes) console.log(`  job ${c.jobId} (tenant ${c.tenantId}) ${c.from} -> ${c.to}`);
  console.log(`(${regressions.length} regressions/other, ${changes.length - regressions.length} promotions from lead)`);
  console.log(dryRun ? "dry-run: no changes written" : "changes applied");
  await adminPool.end();
}

// Run main() only as a CLI, not when imported by a test.
if (process.argv[1] && process.argv[1].includes("rederive-job-stages")) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
```

> Note: the re-derive UPDATEs `job.stage` directly (admin) rather than via `recordStageChange`, so it is not itself gated (it IS the authority here) and won't trip the backward-reason gate. It records the corrective `job_stage_event` with a note instead.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @savvy/db exec vitest run tests/rederive-job-stages.test.ts`
Expected: PASS (regress + dry-run-writes-nothing + idempotent).

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/scripts/rederive-job-stages.ts packages/db/tests/rederive-job-stages.test.ts
git commit -m "feat(pipeline): idempotent re-derive-job-stages script"
```

---

### Task 6: Exception vector `job.stage_evidence`

**Files:**
- Modify: `packages/core/src/verification/checks.ts` (invariant)
- Modify: `packages/core/src/exception-queue.ts` (`stage_evidence` vector)
- Modify: `apps/web/src/lib/exception-queries.ts` (feed the vector)
- Test: `packages/db/tests/stage-evidence-invariant.test.ts` + extend `packages/core/src/exception-queue.test.ts`

**Interfaces:**
- Produces: `evidenceChecks["job.stage_evidence"]`; `ExceptionKind` gains `"stage_evidence"`; `StageEvidenceGapInput` type + `stageEvidenceGaps?` field on `ExceptionQueueInput`.

- [ ] **Step 1: Write the failing tests**

Create `packages/db/tests/stage-evidence-invariant.test.ts`:

```ts
import { afterAll, expect, it } from "vitest";
import { evidenceChecks, type EvidenceCtx } from "@savvy/core";
import { adminDb, adminPool, eq } from "../src/index.js";
import { tenant, job, document } from "../src/schema/index.js";
import { makeTenant, makeJobWithProperty } from "./helpers.js";

const WINDOW = { start: new Date(Date.now() - 86_400_000), end: new Date(Date.now() + 86_400_000) };
const tids: string[] = [];
afterAll(async () => { for (const t of tids) await adminDb.delete(tenant).where(eq(tenant.id, t)).catch(() => {}); await adminPool.end(); });
const run = (tenantId: string) => evidenceChecks["job.stage_evidence"]!({ tenantId, db: adminPool, params: {}, window: WINDOW } as EvidenceCtx);

it("passes when a job's current stage has its own evidence", async () => {
  const { tenantId } = await makeTenant(); tids.push(tenantId);
  const { jobId, propertyId } = await makeJobWithProperty(tenantId);
  await adminDb.insert(document).values({ tenantId, jobId, propertyId, kind: "photo", r2Key: "k" });
  await adminDb.update(job).set({ stage: "inspected" }).where(eq(job.id, jobId));
  const r = await run(tenantId);
  expect(r.status).toBe("pass");
});

it("fails for a job declared past its evidence (inspected, no inspection) — RED PATH", async () => {
  const { tenantId } = await makeTenant(); tids.push(tenantId);
  const { jobId } = await makeJobWithProperty(tenantId);
  await adminDb.update(job).set({ stage: "inspected" }).where(eq(job.id, jobId));
  const r = await run(tenantId);
  expect(r.status).toBe("fail");
  expect(r.refs.length).toBeGreaterThanOrEqual(1);
});
```

Add to `packages/core/src/exception-queue.test.ts` (a pure builder test):

```ts
it("stage_evidence gaps become amber exception items", () => {
  const q = buildExceptionQueue({
    atRiskJobs: [], overdueInvoices: [], missedAppointments: [], overdueTasks: [],
    materialDeliveries: [], taskNeedsApprovals: [], weatherAtRisks: [],
    stageEvidenceGaps: [{ jobId: "j1", customerName: "Josh", stage: "inspected", missing: "inspection", occurredAt: new Date() }],
  });
  const item = q.items.find((i) => i.kind === "stage_evidence");
  expect(item).toBeTruthy();
  expect(item!.severity).toBe("medium");
  expect(item!.detail).toContain("inspection");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @savvy/db exec vitest run tests/stage-evidence-invariant.test.ts` and `pnpm --filter @savvy/core exec vitest run src/exception-queue.test.ts`
Expected: FAIL — check undefined / `stageEvidenceGaps` unknown.

- [ ] **Step 3: Implement**

In `packages/core/src/verification/checks.ts`, add near `exceptions.roof_type` (unbound — do NOT touch `CHECK_BINDINGS`):

```ts
  // A job's stage must be backed by that stage's own evidence. Flags any job declared past
  // what its evidence supports (e.g. 'inspected' with no completed inspection appt and no
  // photo) — catches write-path bypasses. Unbound, like exceptions.roof_type.
  "job.stage_evidence": invariant(
    "job.stage_evidence",
    `select j.id
       from job j
      where j.tenant_id = $1
        and (
          (j.stage = 'inspected' and not (
             exists (select 1 from appointment a where a.tenant_id = j.tenant_id and (a.job_id = j.id or a.lead_id = j.lead_id) and a.type = 'inspection' and a.status = 'done')
             or exists (select 1 from document d where d.tenant_id = j.tenant_id and (d.job_id = j.id or d.lead_id = j.lead_id) and d.kind = 'photo')))
          or (j.stage = 'estimate' and not exists (select 1 from estimate e where e.tenant_id = j.tenant_id and (e.job_id = j.id or e.lead_id = j.lead_id)))
          or (j.stage = 'approved' and not (
             exists (select 1 from estimate e where e.tenant_id = j.tenant_id and (e.job_id = j.id or e.lead_id = j.lead_id) and e.status = 'accepted')
             or exists (select 1 from document d where d.tenant_id = j.tenant_id and (d.job_id = j.id or d.lead_id = j.lead_id) and d.kind = 'contract')))
          or (j.stage = 'production' and not (
             exists (select 1 from appointment a where a.tenant_id = j.tenant_id and a.job_id = j.id and a.type = 'crew' and a.status = 'scheduled')
             or exists (select 1 from material_order m where m.tenant_id = j.tenant_id and m.job_id = j.id and m.status in ('ordered','delivered'))))
          or (j.stage = 'billing' and not exists (select 1 from invoice i where i.tenant_id = j.tenant_id and i.job_id = j.id))
        )`,
    { toRef: (r) => ({ type: "job", ref: String(r.id) }) },
  ),
```

In `packages/core/src/exception-queue.ts`:
- Add `"stage_evidence"` to the `ExceptionKind` union and the `KINDS` array.
- Add the input type: `export type StageEvidenceGapInput = { jobId: string; customerName: string | null; stage: string; missing: string; occurredAt: Date | null };`
- Add `stageEvidenceGaps?: StageEvidenceGapInput[];` to `ExceptionQueueInput`.
- In `buildExceptionQueue`, add a loop (near the roof-type one):

```ts
  for (const g of input.stageEvidenceGaps ?? []) {
    items.push({
      kind: "stage_evidence",
      severity: "medium",
      title: g.customerName ?? "—",
      detail: `Stage '${g.stage}' lacks evidence: ${g.missing}`,
      href: `/jobs/${g.jobId}`,
      occurredAt: g.occurredAt,
    });
  }
```

In `apps/web/src/lib/exception-queries.ts`: add a query for jobs whose current stage lacks own-evidence (reuse the same predicate as the invariant, or select jobs + compute via a lightweight query), map to `StageEvidenceGapInput[]`, and pass `stageEvidenceGaps` into the `buildExceptionQueue({...})` call at the end. Minimal query: select `job.id, job.stage, customer.name` for jobs where the invariant predicate holds; `missing` = `STAGE_EVIDENCE_LABEL[stage]`. Import `STAGE_EVIDENCE_LABEL` from `@savvy/core`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @savvy/db exec vitest run tests/stage-evidence-invariant.test.ts`, `pnpm --filter @savvy/core exec vitest run src/exception-queue.test.ts src/verification`, and `pnpm --filter @savvy/db exec vitest run tests/master-task-list.test.ts`
Expected: PASS (invariant green/red; queue vector; bound-set unchanged since the check is unbound).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/verification/checks.ts packages/core/src/exception-queue.ts apps/web/src/lib/exception-queries.ts packages/db/tests/stage-evidence-invariant.test.ts packages/core/src/exception-queue.test.ts
git commit -m "feat(pipeline): job.stage_evidence invariant + amber exception vector"
```

---

### Task 7: Board write path + waiting-on line

**Files:**
- Modify: `apps/web/src/lib/job-actions.ts` (`moveJobToStage`)
- Modify: `packages/core/src/pipeline-board.ts` (`deriveWaitingOn`)
- Modify: `apps/web/src/lib/pipeline-queries.ts` (feed missing-evidence)
- Test: `packages/core/src/pipeline-board.test.ts` (extend)

**Interfaces:**
- Consumes: `StageEvidenceError`/`BackwardNeedsReasonError` (Task 3), `missingEvidenceFor`/`gatherStageEvidence` (Tasks 1/2).
- Produces: `moveJobToStage` returns `{ error: "needs_evidence"; missing: string | null }` / `{ error: "needs_reason" }`; `WaitingOnInput` gains `missingEvidence?: string | null`.

- [ ] **Step 1: Write the failing test (deriveWaitingOn)**

Add to `packages/core/src/pipeline-board.test.ts`:

```ts
it("names the next stage's missing evidence when there is no pending task", () => {
  const w = deriveWaitingOn({ nextTask: null, column: "lead", missingEvidence: "inspection" });
  expect(w.label).toBe("needs inspection");
  expect(w.isHuman).toBe(true);
});
it("falls back to the column label when nothing is missing", () => {
  const w = deriveWaitingOn({ nextTask: null, column: "lead", missingEvidence: null });
  expect(w.label).toBe("enrich & qualify");
});
it("a pending task still wins over missing-evidence", () => {
  const w = deriveWaitingOn({ nextTask: { title: "call HO", automationLevel: "manual", ownerAgent: "comms" }, column: "lead", missingEvidence: "inspection" });
  expect(w.label).toBe("call HO");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @savvy/core exec vitest run src/pipeline-board.test.ts`
Expected: FAIL — `missingEvidence` unknown / label mismatch.

- [ ] **Step 3: Implement**

In `packages/core/src/pipeline-board.ts`, extend `WaitingOnInput` and `deriveWaitingOn`:

```ts
export type WaitingOnInput = { nextTask: WaitingOnTask | null; column: PipelineColumn; missingEvidence?: string | null };
```
```ts
export function deriveWaitingOn(input: WaitingOnInput): WaitingOn {
  if (input.nextTask) {
    return { label: input.nextTask.title, ownerAgent: input.nextTask.ownerAgent, isHuman: input.nextTask.automationLevel !== "full" };
  }
  if (input.missingEvidence) {
    return { label: `needs ${input.missingEvidence}`, ownerAgent: null, isHuman: true };
  }
  return { label: COLUMN_FALLBACK[input.column], ownerAgent: null, isHuman: false };
}
```

In `apps/web/src/lib/job-actions.ts`, handle the new errors in `moveJobToStage` (import `StageEvidenceError`, `BackwardNeedsReasonError`; add a `reason?` param for backward drags), and return typed errors:

```ts
export async function moveJobToStage(
  jobId: string, toStage: JobStage, reason?: string,
): Promise<{ ok: true } | { error: "missing_photos" | "missing_docs"; missing: string[] } | { error: "needs_evidence"; missing: string | null } | { error: "needs_reason" }> {
  const tenantId = await getTenantId();
  try {
    await withTenant(tenantId, (tx) => recordStageChange(tx, { tenantId, jobId, toStage, reason }));
  } catch (e) {
    if (e instanceof IncompletePhotosError) return { error: "missing_photos", missing: e.missing };
    if (e instanceof IncompleteDocumentsError) return { error: "missing_docs", missing: e.missing };
    if (e instanceof StageEvidenceError) return { error: "needs_evidence", missing: e.missing };
    if (e instanceof BackwardNeedsReasonError) return { error: "needs_reason" };
    throw e;
  }
  revalidatePath("/jobs");
  revalidatePath("/pipeline");
  return { ok: true };
}
```

In `apps/web/src/lib/pipeline-queries.ts`: after loading `board` jobs and `nextByJob`, gather per-job evidence for jobs and pass the next stage's missing label into `deriveWaitingOn`. Add a batched read: for each job with a column, compute `nextStage` (the JOB_STAGE entry after the job's current stage) and `missingEvidenceFor(nextStage, ev)`. Use `withTenant` + `gatherStageEvidence` per board job (board is bounded) or a single raw SQL returning the 5 gate booleans per job; then:

```ts
const w = deriveWaitingOn({ nextTask, column, missingEvidence: missingByJob.get(j.id) ?? null });
```

where `missingByJob` maps jobId → `missingEvidenceFor(nextStage, ev)`. Import `gatherStageEvidence` from `@savvy/db`, `missingEvidenceFor`, `JOB_STAGE` from `@savvy/core`. Compute `nextStage = JOB_STAGE[JOB_STAGE.indexOf(job.stage) + 1] ?? job.stage`.

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm --filter @savvy/core exec vitest run src/pipeline-board.test.ts` and `pnpm -w typecheck`
Expected: PASS + clean.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/pipeline-board.ts apps/web/src/lib/job-actions.ts apps/web/src/lib/pipeline-queries.ts packages/core/src/pipeline-board.test.ts
git commit -m "feat(pipeline): board rejects evidence-less forward drags; waiting-on names the gate"
```

---

### Task 8: E2E + full verification + prod re-derive

**Files:**
- Modify: `apps/web/tests/e2e/production-gating.spec.ts` (or a new `pipeline-evidence.spec.ts`)

- [ ] **Step 1: E2E — an evidence-less forward move is rejected**

Add a spec that seeds a job at `lead` (no evidence) for the e2e tenant, calls the board move server action (or drives the pipeline UI) to `inspected`, and asserts it's rejected with the missing-evidence message; then adds a photo document and asserts the move succeeds. Follow the existing `production-gating.spec.ts` harness (tenant from `/tmp/savvy-e2e-tenant.json`, `adminDb` seeding). Keep assertions resilient.

- [ ] **Step 2: Full verification suite**

```bash
pnpm -w typecheck
pnpm -w lint
pnpm --filter @savvy/core exec vitest run src/stage-evidence.test.ts src/pipeline-board.test.ts src/exception-queue.test.ts src/verification
pnpm --filter @savvy/db exec vitest run tests/stage-evidence-db.test.ts tests/stage-evidence-gate.test.ts tests/stage-evidence-invariant.test.ts tests/rederive-job-stages.test.ts src/lifecycle/convert-lead-to-job.test.ts tests/canvass-conversion.test.ts tests/advance-stage-forward.test.ts tests/stage-gate.test.ts tests/master-task-list.test.ts
```
Expected: all green (ignore the shared-DB `health-sweep` teardown flake).

- [ ] **Step 3: Live prod re-derive (dry-run → review → apply) + verify (state in the PR)**

Against prod (correct Supabase admin URL, trimmed; assert `current_database='postgres'` first — see the prod-DB runbook), run the re-derive **dry-run**:
`DATABASE_ADMIN_URL="<prod>" pnpm --filter @savvy/db exec tsx src/scripts/rederive-job-stages.ts --dry-run`
Review the printed job-by-job diff with the owner. On approval, re-run without `--dry-run`. Then verify: query Josh Williamson's job stage (should sit at its evidence-supported column), and confirm an evidence-less forward advance is rejected. Record the outcome + the diff summary in the PR.

- [ ] **Step 4: Commit + open PR**

```bash
git add apps/web/tests/e2e
git commit -m "test(pipeline): e2e evidence-gated stage move"
```
Open the PR against `main` summarizing the gate, the Josh fix, the re-derive, the exception vector, and the prod re-derive result.

---

## Self-Review

**Spec coverage:**
- §1 gates in one module (recordStageChange) → Task 3; per-gate red-path tests → Task 3. ✓
- §2 manual-job guard (contract OR reason) + land at earliest evidence stage → Task 4. ✓
- §3 re-derive existing jobs (Josh drops back), idempotent, dry-run, prod run → Tasks 5, 8. ✓
- §4 `job.stage_evidence` exception vector (amber) → Task 6. ✓
- §5 evidence check bound? (unbound, deliberate) + waiting-on names the missing artifact → Tasks 6, 7. ✓
- Josh bug closed (convert no longer jumps to inspected) → Task 4. ✓
- Contiguous model / inspection=done-appt-or-photo / reject-forward-drag / own-stage vector / re-derive both-directions → Tasks 1, 3, 6, 5. ✓
- No migration; keep #108 triggers (they call advanceJobStageForward which now also skips on `evidence_gate`) → Tasks 2/3. ✓
- Live prod verification → Task 8 Step 3. ✓

**Placeholder scan:** No TBD/TODO; every code step has complete code. The pipeline-queries batched-evidence read (Task 7 Step 3) gives a concrete approach (per-job `gatherStageEvidence` or one raw SQL) with the exact `deriveWaitingOn` wiring — acceptable latitude, not a placeholder.

**Type consistency:** `StageEvidence`/`deriveContiguousStage`/`missingEvidenceFor`/`stageEvidenceSatisfied`/`STAGE_EVIDENCE_LABEL` (Task 1) consumed by name in Tasks 2, 3, 4, 5, 6, 7. `gatherStageEvidence(tx, {tenantId, jobId})` identical across Tasks 2–5, 7. `StageEvidenceError.missing`/`BackwardNeedsReasonError` (Task 3) used in Tasks 4, 7. `recordStageChange(…, reason?)` consistent across Tasks 3–5, 7. Invariant key `job.stage_evidence` + `ExceptionKind "stage_evidence"` consistent across Task 6. `deriveWaitingOn` `missingEvidence` field consistent across Task 7. ✓
