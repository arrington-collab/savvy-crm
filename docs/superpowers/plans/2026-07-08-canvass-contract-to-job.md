# Canvass Signed Contract → JOB Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A signed canvass contract creates a lead-scoped contract document and idempotently converts the lead to a WON job, with production/material held until the statutory rescission window passes.

**Architecture:** Extend the existing durable `canvass/contract.signed` workflow: lead-scope the stored contract doc, then `convertLeadToJob({ manualJob: true })` and stamp a rescission hold + rep name on the job. A pure `@savvy/core` module computes the release instant; two db gates (crew booking, material order) block while held; an evidence invariant surfaces any stored-but-unconverted contract as break-glass.

**Tech Stack:** Next.js App Router, Drizzle/Postgres (RLS via `withTenant`), Inngest, Zod, Vitest, Playwright.

## Global Constraints

- **Tenant isolation on every query** — through `withTenant` (RLS).
- **Durable/idempotent** — `store-document` commits before `convert-to-job`; `convertLeadToJob` is idempotent on `job.lead_id` (replay → one job).
- **No license gate on conversion** — only scheduling is gated. The 17b template gate stays inside `storeCanvassContract` (fail-closed before storage).
- **Rescission days** — `tenant.settings.rescissionDays[state]` ?? `{ CO: 10, AZ: 3 }` ?? fallback `3`. Release = **00:00 in the tenant timezone** (`tenant.timezone` column, default `America/Phoenix`) on `(signing civil date + N calendar days)`.
- **Rep attribution** — denormalized `job.canvass_rep_name` from `contract.rep` (no FK).
- **Migration only after checking the journal** — journal is at idx **0067** in this worktree; the new migration is **0068**.
- TypeScript strict, no `any`; explicit return types on exports; async/await; Tailwind + design-system CSS vars.
- Test commands: `pnpm --filter @savvy/core exec vitest run <file>`, `pnpm --filter @savvy/db exec vitest run <file>`, `pnpm --filter @savvy/agents exec vitest run <file>`, `pnpm -w typecheck`, `pnpm -w lint`. Ignore the shared-Postgres `health-sweep.test.ts` teardown FK flake.

---

### Task 1: Rescission core (`@savvy/core`)

**Files:**
- Create: `packages/core/src/rescission.ts`
- Modify: `packages/core/src/index.ts` (barrel)
- Test: `packages/core/src/rescission.test.ts`

**Interfaces:**
- Produces:
  - `rescissionDaysFor(state: string | null, config?: Record<string, number>): number`
  - `rescissionReleaseAt(input: { state: string | null; signedAt: Date; timezone: string; config?: Record<string, number> }): Date`
  - `isRescissionHeld(holdUntil: Date | null, now: Date): boolean`
  - `RESCISSION_DAYS_DEFAULT: Record<string, number>` = `{ CO: 10, AZ: 3 }`; `RESCISSION_DAYS_FALLBACK = 3`

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/rescission.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { rescissionDaysFor, rescissionReleaseAt, isRescissionHeld } from "./rescission";

describe("rescissionDaysFor", () => {
  it("statutory defaults + fallback + tenant override", () => {
    expect(rescissionDaysFor("CO")).toBe(10);
    expect(rescissionDaysFor("AZ")).toBe(3);
    expect(rescissionDaysFor("TX")).toBe(3);   // fallback
    expect(rescissionDaysFor(null)).toBe(3);    // fallback
    expect(rescissionDaysFor("AZ", { AZ: 5 })).toBe(5); // override wins
  });
});

describe("rescissionReleaseAt (00:00 in tenant tz on signingDate + N days)", () => {
  const tz = "America/Phoenix"; // UTC-7, no DST
  it("AZ 3 days from a Phoenix-afternoon signing", () => {
    const signedAt = new Date("2026-07-04T21:00:00.000Z"); // 2026-07-04 14:00 Phoenix
    expect(rescissionReleaseAt({ state: "AZ", signedAt, timezone: tz }).toISOString()).toBe("2026-07-07T07:00:00.000Z");
  });
  it("CO 10 days", () => {
    const signedAt = new Date("2026-07-04T21:00:00.000Z");
    expect(rescissionReleaseAt({ state: "CO", signedAt, timezone: tz }).toISOString()).toBe("2026-07-14T07:00:00.000Z");
  });
  it("tenant override changes N", () => {
    const signedAt = new Date("2026-07-04T21:00:00.000Z");
    expect(rescissionReleaseAt({ state: "AZ", signedAt, timezone: tz, config: { AZ: 1 } }).toISOString()).toBe("2026-07-05T07:00:00.000Z");
  });
});

describe("isRescissionHeld (auto-release)", () => {
  const hold = new Date("2026-07-07T07:00:00.000Z");
  it("null hold → never held", () => expect(isRescissionHeld(null, new Date())).toBe(false));
  it("now before hold → held", () => expect(isRescissionHeld(hold, new Date("2026-07-06T00:00:00Z"))).toBe(true));
  it("now at/after hold → released", () => {
    expect(isRescissionHeld(hold, hold)).toBe(false);
    expect(isRescissionHeld(hold, new Date("2026-07-08T00:00:00Z"))).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @savvy/core exec vitest run src/rescission.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `packages/core/src/rescission.ts`:

```ts
import { instantAtLocalTimeOnDate, instantAtLocalHourOnDayOf } from "./tz";

export const RESCISSION_DAYS_DEFAULT: Record<string, number> = { CO: 10, AZ: 3 };
export const RESCISSION_DAYS_FALLBACK = 3;

/** Rescission cooling-off days for a jurisdiction: tenant override ?? statutory default ?? fallback. */
export function rescissionDaysFor(state: string | null, config?: Record<string, number>): number {
  const key = (state ?? "").trim().toUpperCase();
  if (config && key in config) return config[key]!;
  if (key in RESCISSION_DAYS_DEFAULT) return RESCISSION_DAYS_DEFAULT[key]!;
  return RESCISSION_DAYS_FALLBACK;
}

function civilDateInTZ(instant: Date, tz: string): string {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(instant);
  const g = (t: string) => p.find((x) => x.type === t)!.value;
  return `${g("year")}-${g("month")}-${g("day")}`;
}

function addCalendarDays(civil: string, n: number): string {
  const [y, m, d] = civil.split("-").map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

/** The UTC instant of 00:00 tenant-local time on (signing civil date + N rescission days). */
export function rescissionReleaseAt(input: { state: string | null; signedAt: Date; timezone: string; config?: Record<string, number> }): Date {
  const days = rescissionDaysFor(input.state, input.config);
  const targetCivil = addCalendarDays(civilDateInTZ(input.signedAt, input.timezone), days);
  // An instant on the target civil day (preserving signedAt's time-of-day), then snapped to local midnight.
  const onTargetDay = instantAtLocalTimeOnDate(targetCivil, input.signedAt, input.timezone);
  return instantAtLocalHourOnDayOf(onTargetDay, input.timezone, 0);
}

/** True while now is strictly before the hold instant; false when hold is null or elapsed (auto-release). */
export function isRescissionHeld(holdUntil: Date | null, now: Date): boolean {
  return holdUntil != null && now.getTime() < holdUntil.getTime();
}
```

Add to `packages/core/src/index.ts`: `export * from "./rescission";`

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @savvy/core exec vitest run src/rescission.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core
git commit -m "feat(canvass): rescission release-at + held predicate (core)"
```

---

### Task 2: Job schema columns + migration 0068

**Files:**
- Modify: `packages/db/src/schema/jobs.ts` (add two columns to the `job` table)
- Generate: `packages/db/drizzle/0068_*.sql` (+ snapshot + journal)
- Test: `packages/db/tests/job-rescission-columns.test.ts` (new)

**Interfaces:**
- Produces: `job.rescissionHoldUntil` (`timestamp with time zone`, nullable), `job.canvassRepName` (`text`, nullable).

- [ ] **Step 1: Add the columns**

In `packages/db/src/schema/jobs.ts`, inside the `job = pgTable("job", { … })` column object (near `stageEnteredAt`), add:

```ts
  // Canvass door-sale: production/material are held until this instant (statutory rescission
  // window, computed from signedAt in tenant tz). Null = no hold. Auto-releases passively.
  rescissionHoldUntil: timestamp("rescission_hold_until", { withTimezone: true }),
  // Denormalized canvass rep name (canvass_rep is not a Clerk user) for commission attribution.
  canvassRepName: text("canvass_rep_name"),
```

Ensure `timestamp` and `text` are in the `drizzle-orm/pg-core` import at the top of the file (add if missing).

- [ ] **Step 2: Generate the migration and verify the journal advances**

Run: `pnpm --filter @savvy/db db:generate`
Then: `git status packages/db/drizzle` and `tail -6 packages/db/drizzle/meta/_journal.json`
Expected: a new `0068_*.sql` + `0068_snapshot.json`, journal idx **68**. The SQL should be two `ALTER TABLE "job" ADD COLUMN` statements. If the journal shows anything other than a single new 0068 entry, STOP and reconcile (do not hand-edit the journal).

- [ ] **Step 3: Apply the migration to the local DB**

Run: `pnpm --filter @savvy/db db:migrate`
Expected: applies 0068 (additive columns; safe on the shared local Postgres).

- [ ] **Step 4: Write + run the columns test**

Create `packages/db/tests/job-rescission-columns.test.ts`:

```ts
import { afterAll, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { adminDb, adminPool } from "../src/admin-client.js";
import { tenant, customer, property, job } from "../src/schema/index.js";

let tid: string;
afterAll(async () => {
  if (tid) {
    await adminDb.delete(job).where(eq(job.tenantId, tid));
    await adminDb.delete(property).where(eq(property.tenantId, tid));
    await adminDb.delete(customer).where(eq(customer.tenantId, tid));
    await adminDb.delete(tenant).where(eq(tenant.id, tid));
  }
  await adminPool.end();
});

it("job carries rescission_hold_until + canvass_rep_name", async () => {
  const [t] = await adminDb.insert(tenant).values({ name: "RC", publicKey: `rc-${Date.now()}`, clerkOrgId: `org_rc_${Date.now()}` }).returning();
  tid = t!.id;
  const [c] = await adminDb.insert(customer).values({ tenantId: tid, name: "c" }).returning();
  const [p] = await adminDb.insert(property).values({ tenantId: tid, customerId: c!.id, address: `a-${crypto.randomUUID()}` }).returning();
  const hold = new Date("2026-07-07T07:00:00.000Z");
  const [j] = await adminDb.insert(job).values({ tenantId: tid, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "lead", rescissionHoldUntil: hold, canvassRepName: "Marcus R." }).returning();
  expect(j!.rescissionHoldUntil?.toISOString()).toBe(hold.toISOString());
  expect(j!.canvassRepName).toBe("Marcus R.");
});
```

Run: `pnpm --filter @savvy/db exec vitest run tests/job-rescission-columns.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/schema/jobs.ts packages/db/drizzle packages/db/tests/job-rescission-columns.test.ts
git commit -m "feat(canvass): job.rescission_hold_until + canvass_rep_name (migration 0068)"
```

---

### Task 3: Scheduling gate — `RescissionHoldError` + crew-booking block

**Files:**
- Modify: `packages/db/src/lifecycle/appointments.ts` (error class + gate in `bookAppointment`)
- Modify: `packages/db/src/index.ts` (export `RescissionHoldError` if errors are barrel-exported; match how `LicenseRequiredError` is exported)
- Test: `packages/db/tests/appointments-rescission.test.ts` (new)

**Interfaces:**
- Consumes: `isRescissionHeld` (Task 1).
- Produces: `class RescissionHoldError extends Error { releaseAt: Date }`; `bookAppointment` throws it when booking `type === "crew"` for a job whose `rescissionHoldUntil` is in the future.

- [ ] **Step 1: Write the failing test**

Create `packages/db/tests/appointments-rescission.test.ts` (mirror `appointments-license.test.ts` fixtures; seed an active AZ license so the license gate passes):

```ts
import { beforeAll, afterAll, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { bookAppointment, RescissionHoldError } from "../src/index.js";
import { adminDb, adminPool } from "../src/admin-client.js";
import { tenant, customer, property, job, license } from "../src/schema/index.js";

let tid: string, heldJob: string, freeJob: string;
const future = new Date(Date.now() + 3 * 86_400_000);
const past = new Date(Date.now() - 86_400_000);

beforeAll(async () => {
  const [t] = await adminDb.insert(tenant).values({ name: "RH", publicKey: `rh-${Date.now()}`, clerkOrgId: `org_rh_${Date.now()}` }).returning();
  tid = t!.id;
  await adminDb.insert(license).values({ tenantId: tid, state: "AZ", city: null, authority: "ROC", licenseNumber: `L-${tid}`, status: "active", expiresAt: null });
  const [c] = await adminDb.insert(customer).values({ tenantId: tid, name: "c" }).returning();
  const [p] = await adminDb.insert(property).values({ tenantId: tid, customerId: c!.id, address: `a-${crypto.randomUUID()}`, state: "AZ" }).returning();
  const [h] = await adminDb.insert(job).values({ tenantId: tid, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "lead", rescissionHoldUntil: future }).returning();
  const [f] = await adminDb.insert(job).values({ tenantId: tid, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "lead", rescissionHoldUntil: past }).returning();
  heldJob = h!.id; freeJob = f!.id;
});
afterAll(async () => {
  await adminDb.delete(job).where(eq(job.tenantId, tid));
  await adminDb.delete(license).where(eq(license.tenantId, tid));
  await adminDb.delete(property).where(eq(property.tenantId, tid));
  await adminDb.delete(customer).where(eq(customer.tenantId, tid));
  await adminDb.delete(tenant).where(eq(tenant.id, tid));
  await adminPool.end();
});

const slot = () => ({ startsAt: new Date(Date.now() + 7 * 86_400_000), endsAt: new Date(Date.now() + 7 * 86_400_000 + 3_600_000) });

it("crew booking is BLOCKED while the job is under a rescission hold (RED PATH #3)", async () => {
  await expect(bookAppointment({ tenantId: tid, jobId: heldJob, type: "crew", assigneeUserId: null, ...slot() }))
    .rejects.toBeInstanceOf(RescissionHoldError);
});
it("non-crew (inspection) booking is allowed during the hold", async () => {
  const r = await bookAppointment({ tenantId: tid, jobId: heldJob, type: "inspection", assigneeUserId: null, ...slot() });
  expect(r.id).toBeTruthy();
});
it("crew booking is allowed once the hold has elapsed (auto-release)", async () => {
  const r = await bookAppointment({ tenantId: tid, jobId: freeJob, type: "crew", assigneeUserId: null, ...slot() });
  expect(r.id).toBeTruthy();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @savvy/db exec vitest run tests/appointments-rescission.test.ts`
Expected: FAIL — `RescissionHoldError` not exported / crew booking not blocked.

- [ ] **Step 3: Implement**

In `packages/db/src/lifecycle/appointments.ts`, near the `LicenseRequiredError` class, add + import `isRescissionHeld`:

```ts
import { isRescissionHeld } from "@savvy/core";

export class RescissionHoldError extends Error {
  releaseAt: Date;
  constructor(releaseAt: Date) {
    super(`job is under a rescission hold until ${releaseAt.toISOString()}`);
    this.name = "RescissionHoldError";
    this.releaseAt = releaseAt;
  }
}
```

In `bookAppointment`, extend the job lookup to also read the hold, and gate crew bookings. Replace the existing job-resolve block:

```ts
      let propertyId = input.propertyId ?? null;
      if (!propertyId && input.jobId) {
        const [jrow] = await tx.select({ propertyId: job.propertyId }).from(job).where(eq(job.id, input.jobId));
        if (!jrow) throw new Error(`bookAppointment: job ${input.jobId} not found`);
        propertyId = jrow.propertyId;
      }
```

with:

```ts
      let propertyId = input.propertyId ?? null;
      if (input.jobId) {
        const [jrow] = await tx.select({ propertyId: job.propertyId, rescissionHoldUntil: job.rescissionHoldUntil }).from(job).where(eq(job.id, input.jobId));
        if (!jrow) throw new Error(`bookAppointment: job ${input.jobId} not found`);
        if (!propertyId) propertyId = jrow.propertyId;
        // Production/crew work is held during the statutory rescission window; other
        // appointment types (inspection/cm/adjuster) are unaffected.
        if (input.type === "crew" && isRescissionHeld(jrow.rescissionHoldUntil, new Date())) {
          throw new RescissionHoldError(jrow.rescissionHoldUntil!);
        }
      }
```

Ensure `RescissionHoldError` is exported from the db barrel the same way `LicenseRequiredError` is (check `packages/db/src/index.ts`; add if lifecycle errors are re-exported there).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @savvy/db exec vitest run tests/appointments-rescission.test.ts`
Expected: PASS (3 cases). Also run `pnpm --filter @savvy/db exec vitest run tests/appointments-license.test.ts` to confirm no regression.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/lifecycle/appointments.ts packages/db/src/index.ts packages/db/tests/appointments-rescission.test.ts
git commit -m "feat(canvass): block crew scheduling during rescission hold"
```

---

### Task 4: Material-order gate (defer while held)

**Files:**
- Modify: `packages/db/src/lifecycle/material-order.ts` (throw `RescissionHoldError` when the job is held)
- Modify: `packages/agents/src/functions/material-order.ts` (catch → deferred, fail-soft)
- Test: `packages/db/tests/material-order-rescission.test.ts` (new)

**Interfaces:**
- Consumes: `isRescissionHeld` (Task 1), `RescissionHoldError` (Task 3).
- Produces: `createMaterialOrderFromEstimate` throws `RescissionHoldError` when its estimate's job has an active hold (no order row inserted).

- [ ] **Step 1: Write the failing test**

Create `packages/db/tests/material-order-rescission.test.ts`:

```ts
import { beforeAll, afterAll, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { createMaterialOrderFromEstimate, RescissionHoldError } from "../src/index.js";
import { adminDb, adminPool } from "../src/admin-client.js";
import { tenant, customer, property, job, estimate, materialOrder } from "../src/schema/index.js";

let tid: string, heldEst: string, freeEst: string, heldJob: string, freeJob: string;
const future = new Date(Date.now() + 3 * 86_400_000);
const past = new Date(Date.now() - 86_400_000);

beforeAll(async () => {
  const [t] = await adminDb.insert(tenant).values({ name: "MO", publicKey: `mo-${Date.now()}`, clerkOrgId: `org_mo_${Date.now()}` }).returning();
  tid = t!.id;
  const [c] = await adminDb.insert(customer).values({ tenantId: tid, name: "c" }).returning();
  const [p] = await adminDb.insert(property).values({ tenantId: tid, customerId: c!.id, address: `a-${crypto.randomUUID()}` }).returning();
  const [h] = await adminDb.insert(job).values({ tenantId: tid, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "production", rescissionHoldUntil: future }).returning();
  const [f] = await adminDb.insert(job).values({ tenantId: tid, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "production", rescissionHoldUntil: past }).returning();
  heldJob = h!.id; freeJob = f!.id;
  const [he] = await adminDb.insert(estimate).values({ tenantId: tid, jobId: heldJob, propertyId: p!.id, status: "accepted", lineItems: [] }).returning();
  const [fe] = await adminDb.insert(estimate).values({ tenantId: tid, jobId: freeJob, propertyId: p!.id, status: "accepted", lineItems: [] }).returning();
  heldEst = he!.id; freeEst = fe!.id;
});
afterAll(async () => {
  await adminDb.delete(materialOrder).where(eq(materialOrder.tenantId, tid));
  await adminDb.delete(estimate).where(eq(estimate.tenantId, tid));
  await adminDb.delete(job).where(eq(job.tenantId, tid));
  await adminDb.delete(property).where(eq(property.tenantId, tid));
  await adminDb.delete(customer).where(eq(customer.tenantId, tid));
  await adminDb.delete(tenant).where(eq(tenant.id, tid));
  await adminPool.end();
});

it("material order is BLOCKED while the job is held; no row inserted (RED PATH #3)", async () => {
  await expect(createMaterialOrderFromEstimate({ tenantId: tid, estimateId: heldEst })).rejects.toBeInstanceOf(RescissionHoldError);
  const rows = await adminDb.select().from(materialOrder).where(and(eq(materialOrder.tenantId, tid), eq(materialOrder.jobId, heldJob)));
  expect(rows).toHaveLength(0);
});
it("material order proceeds once the hold has elapsed", async () => {
  const r = await createMaterialOrderFromEstimate({ tenantId: tid, estimateId: freeEst });
  expect(r?.jobId).toBe(freeJob);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @savvy/db exec vitest run tests/material-order-rescission.test.ts`
Expected: FAIL — order created for held job (no gate yet).

- [ ] **Step 3: Implement**

In `packages/db/src/lifecycle/material-order.ts`, import the guard + error and gate after resolving `jobId`:

```ts
import { isRescissionHeld } from "@savvy/core";
import { RescissionHoldError } from "./appointments";
```

Immediately after `const jobId = est.jobId;` (before the existing-order select), add:

```ts
    // Hold material ordering during the statutory rescission window (canvass door sales).
    const [j] = await tx.select({ hold: job.rescissionHoldUntil }).from(job).where(eq(job.id, jobId));
    if (isRescissionHeld(j?.hold ?? null, new Date())) {
      throw new RescissionHoldError(j!.hold!);
    }
```

Ensure `job` is imported in `material-order.ts` (add to the schema import if missing).

In `packages/agents/src/functions/material-order.ts`, catch the hold so the workflow is fail-soft (a held order is deferred, not a hard failure):

```ts
import { createMaterialOrderFromEstimate, RescissionHoldError } from "@savvy/db";
import { inngest } from "../client";

export const createMaterialOrderOnAccepted = inngest.createFunction(
  { id: "create-material-order-on-accepted", concurrency: { limit: 5 } },
  { event: "estimate/accepted" },
  async ({ event, step }) =>
    step.run("create-material-order", async () => {
      try {
        return await createMaterialOrderFromEstimate({ tenantId: event.data.tenantId, estimateId: event.data.estimateId });
      } catch (e) {
        // Rescission hold: defer ordering until the window elapses (re-fired on the next
        // acceptance / manual re-trigger). Not a failure.
        if (e instanceof RescissionHoldError) return { deferred: true, releaseAt: e.releaseAt.toISOString() };
        throw e;
      }
    }),
);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @savvy/db exec vitest run tests/material-order-rescission.test.ts` and `pnpm -w typecheck`
Expected: PASS + typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/lifecycle/material-order.ts packages/agents/src/functions/material-order.ts packages/db/tests/material-order-rescission.test.ts
git commit -m "feat(canvass): defer material ordering during rescission hold"
```

---

### Task 5: Lead-scope the contract document

**Files:**
- Modify: `packages/agents/src/functions/canvass-contract.ts` (`storeCanvassContract` insert)
- Test: `packages/agents/src/functions/canvass-contract.test.ts` (add an assertion; file exists)

**Interfaces:**
- Produces: the stored contract `document` row carries `leadId` + `propertyId` (in addition to `customerId`).

- [ ] **Step 1: Write the failing test**

In `packages/agents/src/functions/canvass-contract.test.ts`, add a case (reuse the file's existing tenant/lead fixture + fake storage). After `storeCanvassContract(...)`, assert the stored doc has `leadId`:

```ts
it("stores the contract document lead-scoped (carries onto the job)", async () => {
  // reuse this file's existing setup helper for tenant + lead + fake storage
  const { tenantId, leadId } = await setupLeadFixture(); // existing helper in this file
  await storeCanvassContract({ tenantId, leadId, contract: sampleContract() }, { storage: makeFakeStorage() });
  const [doc] = await adminDb.select().from(document).where(and(eq(document.tenantId, tenantId), eq(document.kind, "contract")));
  expect(doc!.leadId).toBe(leadId);
  expect(doc!.propertyId).toBeTruthy();
  expect(doc!.customerId).toBeTruthy();
});
```

If the test file lacks `setupLeadFixture`/`sampleContract` helpers, use whatever fixture pattern the existing tests in that file already use (they construct a tenant + lead + `CanvassContract`); the assertion on `doc.leadId` is the point. Ensure `adminDb, document, and, eq` and `makeFakeStorage` are imported as the file already does.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @savvy/agents exec vitest run src/functions/canvass-contract.test.ts`
Expected: FAIL — `doc.leadId` is null.

- [ ] **Step 3: Implement**

In `packages/agents/src/functions/canvass-contract.ts`, the `document` insert in `storeCanvassContract` — add `leadId` and `propertyId`:

```ts
    tx.insert(document).values({
      tenantId,
      leadId,
      propertyId: l.propertyId ?? null,
      customerId: l.customerId,
      kind: "contract",
      label: contract.document,
      r2Key,
      filename: `${contract.kind}-contract-${contract.signedAt.slice(0, 10)}.json`,
      mime: "application/json",
      sizeBytes: bytes.byteLength,
      source: "savvy",
      contractTemplateId: contractTemplateId ?? undefined,
    }),
```

(`l` already selects `customerId, propertyId` at the top of `storeCanvassContract`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @savvy/agents exec vitest run src/functions/canvass-contract.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agents/src/functions/canvass-contract.ts
git commit -m "feat(canvass): lead-scope the stored contract document"
```

---

### Task 6: Convert canvass contract → job (+ rescission metadata)

**Files:**
- Create: `packages/db/src/lifecycle/canvass-conversion.ts`
- Modify: `packages/db/src/index.ts` (barrel)
- Modify: `packages/agents/src/functions/canvass-contract.ts` (add the `convert-to-job` step)
- Test: `packages/db/tests/canvass-conversion.test.ts` (new)

**Interfaces:**
- Consumes: `convertLeadToJob` (existing), `rescissionReleaseAt` (Task 1), `job` schema (Task 2).
- Produces: `convertCanvassContractToJob(input: { tenantId: string; leadId: string; contract: CanvassContract }): Promise<{ jobId: string }>` — converts (manualJob), then stamps `rescissionHoldUntil` + `canvassRepName` on the job. Idempotent.

- [ ] **Step 1: Write the failing test**

Create `packages/db/tests/canvass-conversion.test.ts`:

```ts
import { beforeAll, afterAll, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { convertCanvassContractToJob } from "../src/index.js";
import { adminDb, adminPool } from "../src/admin-client.js";
import { tenant, customer, property, lead, job } from "../src/schema/index.js";

let tid: string, leadId: string;
const contract = {
  kind: "retail", document: "Roofing Agreement", fields: {}, scopeItems: [],
  rep: "Marcus R.", signedAt: "2026-07-04T21:00:00.000Z",
  signaturePng: "data:image/png;base64,AAAA", integrityHash: "b".repeat(64),
} as unknown as import("@savvy/core").CanvassContract;

beforeAll(async () => {
  const [t] = await adminDb.insert(tenant).values({ name: "CC", publicKey: `cc-${Date.now()}`, clerkOrgId: `org_cc_${Date.now()}`, timezone: "America/Phoenix" }).returning();
  tid = t!.id;
  const [c] = await adminDb.insert(customer).values({ tenantId: tid, name: "c" }).returning();
  const [p] = await adminDb.insert(property).values({ tenantId: tid, customerId: c!.id, address: `a-${crypto.randomUUID()}`, state: "AZ" }).returning();
  const [l] = await adminDb.insert(lead).values({ tenantId: tid, customerId: c!.id, propertyId: p!.id, source: "door-knocking", status: "new" }).returning();
  leadId = l!.id;
});
afterAll(async () => {
  await adminDb.delete(job).where(eq(job.tenantId, tid));
  await adminDb.delete(lead).where(eq(lead.tenantId, tid));
  await adminDb.delete(property).where(eq(property.tenantId, tid));
  await adminDb.delete(customer).where(eq(customer.tenantId, tid));
  await adminDb.delete(tenant).where(eq(tenant.id, tid));
  await adminPool.end();
});

it("converts to a WON job with rescission hold + rep name; replay makes ONE job (RED PATH #1)", async () => {
  const first = await convertCanvassContractToJob({ tenantId: tid, leadId, contract });
  const second = await convertCanvassContractToJob({ tenantId: tid, leadId, contract }); // replay
  expect(second.jobId).toBe(first.jobId);
  const jobs = await adminDb.select().from(job).where(eq(job.leadId, leadId));
  expect(jobs).toHaveLength(1);
  const [l] = await adminDb.select().from(lead).where(eq(lead.id, leadId));
  expect(l!.status).toBe("won");
  const j = jobs[0]!;
  expect(j.canvassRepName).toBe("Marcus R.");
  // AZ = 3 days; signed 2026-07-04 14:00 Phoenix → release 2026-07-07 00:00 Phoenix = 07:00Z
  expect(j.rescissionHoldUntil?.toISOString()).toBe("2026-07-07T07:00:00.000Z");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @savvy/db exec vitest run tests/canvass-conversion.test.ts`
Expected: FAIL — `convertCanvassContractToJob` not exported.

- [ ] **Step 3: Implement**

Create `packages/db/src/lifecycle/canvass-conversion.ts`:

```ts
import { eq } from "drizzle-orm";
import { withTenant } from "../tenant";
import { job } from "../schema/jobs";
import { property } from "../schema/crm";
import { tenant } from "../schema/tenancy";
import { rescissionReleaseAt } from "@savvy/core";
import type { CanvassContract } from "@savvy/core";
import { convertLeadToJob } from "./appointments";

/**
 * Convert a signed canvass contract's lead into a job (manualJob — a signed contract is the
 * authorization; no accepted estimate exists on a door sale), then stamp the statutory
 * rescission hold + denormalized rep name on the job. Idempotent: convertLeadToJob keys off
 * job.lead_id (replay returns the same job); the metadata set is a plain overwrite.
 */
export async function convertCanvassContractToJob(input: {
  tenantId: string;
  leadId: string;
  contract: CanvassContract;
}): Promise<{ jobId: string }> {
  const { jobId } = await convertLeadToJob({ tenantId: input.tenantId, leadId: input.leadId, manualJob: true });

  await withTenant(input.tenantId, async (tx) => {
    const [j] = await tx.select({ propertyId: job.propertyId }).from(job).where(eq(job.id, jobId));
    const state = j?.propertyId
      ? (await tx.select({ state: property.state }).from(property).where(eq(property.id, j.propertyId)))[0]?.state ?? null
      : null;
    const [t] = await tx.select({ timezone: tenant.timezone, settings: tenant.settings }).from(tenant).where(eq(tenant.id, input.tenantId));
    const config = ((t?.settings as { rescissionDays?: Record<string, number> } | undefined)?.rescissionDays) ?? undefined;
    const holdUntil = rescissionReleaseAt({
      state,
      signedAt: new Date(input.contract.signedAt),
      timezone: t?.timezone ?? "America/Phoenix",
      config,
    });
    await tx.update(job).set({ rescissionHoldUntil: holdUntil, canvassRepName: input.contract.rep }).where(eq(job.id, jobId));
  });

  return { jobId };
}
```

Add to `packages/db/src/index.ts`: `export { convertCanvassContractToJob } from "./lifecycle/canvass-conversion";`

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @savvy/db exec vitest run tests/canvass-conversion.test.ts`
Expected: PASS (replay → one job, won, hold + rep set).

- [ ] **Step 5: Wire the workflow + commit**

In `packages/agents/src/functions/canvass-contract.ts`, import and add a `convert-to-job` step in `canvassContractSigned`, AFTER `store-document` and regardless of `stored.stored` (idempotent; self-heals a crash between store and convert):

```ts
import { convertCanvassContractToJob } from "@savvy/db";
```
```ts
    // A signed canvass contract IS the authorization — convert the lead to a job.
    // Runs even on a replay/already-stored path so a crash between store and convert self-heals.
    await step.run("convert-to-job", () =>
      convertCanvassContractToJob({ tenantId: event.data.tenantId, leadId: event.data.leadId, contract: event.data.contract }),
    );
```

Run: `pnpm -w typecheck`
Expected: clean.

```bash
git add packages/db/src/lifecycle/canvass-conversion.ts packages/db/src/index.ts packages/agents/src/functions/canvass-contract.ts packages/db/tests/canvass-conversion.test.ts
git commit -m "feat(canvass): auto-convert signed contract to WON job with rescission hold"
```

---

### Task 7: Evidence invariant `canvass.contract_to_job`

**Files:**
- Modify: `packages/core/src/verification/checks.ts` (invariant)
- Modify: `packages/core/src/verification/break-glass-keys.ts` (add the key)
- Test: `packages/db/tests/canvass-contract-evidence.test.ts` (new)

**Interfaces:**
- Produces: `evidenceChecks["canvass.contract_to_job"]`.

- [ ] **Step 1: Write the failing test**

Create `packages/db/tests/canvass-contract-evidence.test.ts` (mirror `lead-doc-evidence.test.ts`: a clean tenant with a converted+won contract, a bad tenant with a stored contract doc >15m old and no won job):

```ts
import { beforeAll, afterAll, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { evidenceChecks } from "@savvy/core";
import type { EvidenceCtx } from "@savvy/core";
import { adminDb, adminPool } from "../src/admin-client.js";
import { tenant, customer, property, lead, document, job } from "../src/schema/index.js";

let cleanId: string, badId: string;
const WINDOW = { start: new Date(Date.now() - 86_400_000), end: new Date(Date.now() + 86_400_000) };
const MIN = (n: number) => new Date(Date.now() - n * 60_000);
const run = (tenantId: string) => evidenceChecks["canvass.contract_to_job"]!({ tenantId, db: adminPool, params: {}, window: WINDOW } as EvidenceCtx);

async function mkLead(tid: string) {
  const [c] = await adminDb.insert(customer).values({ tenantId: tid, name: "c" }).returning();
  const [p] = await adminDb.insert(property).values({ tenantId: tid, customerId: c!.id, address: `a-${crypto.randomUUID()}` }).returning();
  const [l] = await adminDb.insert(lead).values({ tenantId: tid, customerId: c!.id, propertyId: p!.id, source: "door-knocking", status: "new" }).returning();
  return { customerId: c!.id, propertyId: p!.id, leadId: l!.id };
}

beforeAll(async () => {
  const [a] = await adminDb.insert(tenant).values({ name: "CE-clean", publicKey: `cec-${Date.now()}`, clerkOrgId: `org_cec_${Date.now()}` }).returning();
  const [b] = await adminDb.insert(tenant).values({ name: "CE-bad", publicKey: `ceb-${Date.now()}`, clerkOrgId: `org_ceb_${Date.now()}` }).returning();
  cleanId = a!.id; badId = b!.id;

  // CLEAN: a canvass contract whose lead is won + has a job.
  const cl = await mkLead(cleanId);
  await adminDb.update(lead).set({ status: "won" }).where(eq(lead.id, cl.leadId));
  await adminDb.insert(job).values({ tenantId: cleanId, customerId: cl.customerId, propertyId: cl.propertyId, leadId: cl.leadId, type: "retail", stage: "lead" });
  await adminDb.insert(document).values({ tenantId: cleanId, leadId: cl.leadId, propertyId: cl.propertyId, customerId: cl.customerId, kind: "contract", r2Key: `${cleanId}/canvass/contract-abc.json`, createdAt: MIN(30) });

  // BAD: a stored canvass contract >15m old, lead not won, no job.
  const bl = await mkLead(badId);
  await adminDb.insert(document).values({ tenantId: badId, leadId: bl.leadId, propertyId: bl.propertyId, customerId: bl.customerId, kind: "contract", r2Key: `${badId}/canvass/contract-def.json`, createdAt: MIN(30) });
});
afterAll(async () => {
  for (const tid of [cleanId, badId]) {
    await adminDb.delete(document).where(eq(document.tenantId, tid));
    await adminDb.delete(job).where(eq(job.tenantId, tid));
    await adminDb.delete(lead).where(eq(lead.tenantId, tid));
    await adminDb.delete(property).where(eq(property.tenantId, tid));
    await adminDb.delete(customer).where(eq(customer.tenantId, tid));
    await adminDb.delete(tenant).where(eq(tenant.id, tid));
  }
  await adminPool.end();
});

it("passes on the clean tenant (contract → won job)", async () => {
  const r = await run(cleanId);
  expect(r.status).toBe("pass");
});
it("fails on the bad tenant (stored contract, no won job) — RED PATH #2", async () => {
  const r = await run(badId);
  expect(r.status).toBe("fail");
  expect(r.refs.length).toBeGreaterThanOrEqual(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @savvy/db exec vitest run tests/canvass-contract-evidence.test.ts`
Expected: FAIL — `evidenceChecks["canvass.contract_to_job"]` is undefined.

- [ ] **Step 3: Implement**

In `packages/core/src/verification/checks.ts`, add to the `evidenceChecks` map (near the other lead/contract invariants):

```ts
  // Every stored canvass contract becomes a WON job within 15 minutes of signing. A stored
  // contract doc (kind='contract', canvass r2Key) older than 15m whose lead is not won or has
  // no job is lost revenue — surfaced here (and paged via break-glass).
  "canvass.contract_to_job": invariant(
    "canvass.contract_to_job",
    `select d.id
       from document d
       join lead l on l.id = d.lead_id and l.tenant_id = d.tenant_id
      where d.tenant_id = $1
        and d.kind = 'contract'
        and d.r2_key like '%/canvass/contract-%'
        and d.created_at < now() - interval '15 minutes'
        and (
          l.status <> 'won'
          or not exists (select 1 from job j where j.lead_id = l.id and j.tenant_id = l.tenant_id)
        )`,
    { toRef: (r) => ({ type: "document", ref: String(r.id) }) },
  ),
```

In `packages/core/src/verification/break-glass-keys.ts`, add the key to the set:

```ts
export const BREAK_GLASS_ON_FAIL_CHECK_KEYS: ReadonlySet<string> = new Set([
  "comms.deliverability",
  "canvass.contract_to_job",
]);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @savvy/db exec vitest run tests/canvass-contract-evidence.test.ts`
Expected: PASS (green + red).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/verification/checks.ts packages/core/src/verification/break-glass-keys.ts packages/db/tests/canvass-contract-evidence.test.ts
git commit -m "feat(canvass): canvass.contract_to_job evidence invariant + break-glass"
```

---

### Task 8: Bind the invariant to a task (scoreboard)

**Files:**
- Modify: `packages/db/seeds/master-task-list.ts` (`CHECK_BINDINGS`)
- Modify: `packages/db/tests/master-task-list.test.ts` (bound-set array + per-id assertion)

**Interfaces:**
- Consumes: `evidenceChecks["canvass.contract_to_job"]` (Task 7).

- [ ] **Step 1: Update the bound-set test first (red)**

In `packages/db/tests/master-task-list.test.ts`, add `6` to the expected bound-id array (keep it sorted):

```ts
    expect(bound).toEqual([6, 18, 19, 24, 28, 32, 44, 49, 52, 76, 133, 139, 141, 150, 151, 213, 214]);
```

And add a per-id assertion near the existing `byId(18)`/`byId(28)` ones:

```ts
    expect(byId(6).checkKey).toBe("canvass.contract_to_job");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @savvy/db exec vitest run tests/master-task-list.test.ts`
Expected: FAIL — task 6 has a null checkKey / bound-set mismatch.

- [ ] **Step 3: Implement**

In `packages/db/seeds/master-task-list.ts`, add to `CHECK_BINDINGS`:

```ts
  6: "canvass.contract_to_job",
```

(Task 6 = "Door-to-door canvassing route generation" — the canvass automation task; this invariant proves the canvass path produces jobs.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @savvy/db exec vitest run tests/master-task-list.test.ts`
Expected: PASS (bound-set + no-orphan-bindings both green).

- [ ] **Step 5: Commit**

```bash
git add packages/db/seeds/master-task-list.ts packages/db/tests/master-task-list.test.ts
git commit -m "feat(canvass): bind canvass.contract_to_job to the canvass task"
```

---

### Task 9: Rescission hold banner on the job page

**Files:**
- Modify: `apps/web/src/app/(app)/jobs/[id]/page.tsx` (select `rescissionHoldUntil`; render a banner)

No jsdom test infra in `apps/web` — verification is typecheck + lint here and the e2e in Task 10.

- [ ] **Step 1: Select the hold + render a banner**

In `apps/web/src/app/(app)/jobs/[id]/page.tsx`, add `rescissionHoldUntil: job.rescissionHoldUntil` to the job row `select`, and render a banner near the top of the job view (only while the hold is in the future). Use the existing design-system classes:

```tsx
{jobRow.rescissionHoldUntil && new Date(jobRow.rescissionHoldUntil) > new Date() && (
  <div className="rounded-md border p-3 text-sm" style={{ borderColor: "var(--border)", background: "var(--surface-muted)" }} data-testid="rescission-hold-banner">
    <span className="font-medium">Production held</span> — rescission window. Materials &amp; crew scheduling release{" "}
    {new Date(jobRow.rescissionHoldUntil).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}.
  </div>
)}
```

Match `jobRow`/variable names to whatever the page already uses for the job record; if the job select is inside a `withTenant` block, add the column there and thread it out with the rest of the job fields.

- [ ] **Step 2: Typecheck + lint**

Run: `pnpm -w typecheck && pnpm -w lint`
Expected: PASS (0 errors).

- [ ] **Step 3: Commit**

```bash
git add "apps/web/src/app/(app)/jobs/[id]/page.tsx"
git commit -m "feat(canvass): rescission hold banner on the job page"
```

---

### Task 10: E2E + full verification + prod check

**Files:**
- Modify: `apps/web/tests/e2e/canvass.spec.ts` if it exists, else create `apps/web/tests/e2e/canvass-contract-to-job.spec.ts`

- [ ] **Step 1: E2E — signed contract POST → lead won + job + hold**

Following the e2e harness (`tests/e2e/create-tenant.ts` writes `/tmp/savvy-e2e-tenant.json`; `TEST_MODE=1` stubs storage + a rep session may be required). Write a spec that POSTs to `/api/canvass/contract` with the tenant `key` + a rep bearer token + a `contract` payload for a **test lead** (fake phone/name), waits for the Inngest workflow (dev inngest), then asserts via `adminDb`: the lead is `won`, exactly one `job` exists for the lead with `rescissionHoldUntil` set and `canvassRepName` populated, and a `document` (kind `contract`) carries `jobId`. If minting a rep session in e2e is impractical, drive the workflow via the db path instead: seed a lead, call `convertCanvassContractToJob`, and assert the same post-state (keep the assertion, adapt the trigger). Keep assertions resilient to Inngest async.

- [ ] **Step 2: Full verification suite**

```bash
pnpm -w typecheck
pnpm -w lint
pnpm --filter @savvy/core exec vitest run src/rescission.test.ts src/verification/checks.test.ts
pnpm --filter @savvy/db exec vitest run tests/job-rescission-columns.test.ts tests/appointments-rescission.test.ts tests/material-order-rescission.test.ts tests/canvass-conversion.test.ts tests/canvass-contract-evidence.test.ts tests/master-task-list.test.ts
pnpm --filter @savvy/agents exec vitest run src/functions/canvass-contract.test.ts src/functions/material-order.test.ts
```
Expected: all green (ignore the shared-DB `health-sweep.test.ts` teardown flake).

- [ ] **Step 3: Live prod verification (state in the PR)**

Sign a **TEST** contract via the canvass field app against a **test lead** (never a real customer number). Confirm: lead → `won`; a job exists with the contract document viewable on it; the job card shows the rescission hold with its release date. Record the outcome in the PR body. (If prod deploy / rep session is gated, state what was verified locally via the e2e + which step needs Brett's authenticated pass.)

- [ ] **Step 4: Commit + open PR**

```bash
git add apps/web/tests/e2e
git commit -m "test(canvass): e2e contract → won job + rescission hold"
```
Open the PR against `main` summarizing the end-to-end flow, the three red-path tests, migration 0068, and the verification result.

---

## Self-Review

**Spec coverage:**
- §1 lead-scope contract doc → Task 5. ✓
- §2 auto-convert (manualJob, won, carryover, rep, idempotent) → Task 6 (+ existing `convertLeadToJob`). ✓
- §3 ordering + fail-soft (store commits first; convert retries; invariant = exception) → Task 6 step ordering + Task 7 invariant. ✓
- §4 rescission hold: config/release (Task 1), migration (Task 2), crew gate (Task 3), material gate (Task 4), set-on-job (Task 6), banner (Task 9), auto-release (Tasks 1/3/4 predicate). ✓
- §5 evidence + bound + break-glass → Tasks 7, 8. ✓
- Red paths: #1 replay→one job (Task 6), #2 conversion-failure→exception (Task 7), #3 material/crew blocked while held (Tasks 3, 4). ✓
- Live verification → Task 10 Step 3. ✓

**Placeholder scan:** No TBD/TODO; every code step is complete. Fixture-helper reuse notes (Tasks 5, 10) point at existing patterns rather than inventing names — acceptable, with the concrete assertion given. ✓

**Type consistency:** `rescissionReleaseAt`/`isRescissionHeld`/`rescissionDaysFor` (Task 1) consumed by name in Tasks 3, 4, 6. `RescissionHoldError` defined in Task 3, imported in Task 4. `convertCanvassContractToJob` signature consistent across Tasks 6, 10. `job.rescissionHoldUntil`/`job.canvassRepName` (Task 2) used in 3, 4, 6, 9. Invariant key `canvass.contract_to_job` consistent across Tasks 7, 8. ✓
