# Cell 17a — License Matrix + Scheduling Block Invariant — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make it physically impossible to schedule an appointment in a jurisdiction where the tenant holds no active license, backed by a per-tenant `license` matrix and a pure resolver.

**Architecture:** A new tenant-scoped `license` table (migration 0054) stores per-jurisdiction licenses keyed by `(state, city?)`. A pure resolver in `@savvy/core` decides whether a jurisdiction is licensed. `bookAppointment()` resolves the appointment's property jurisdiction and throws `LicenseRequiredError` when no active license matches — enforced at the data layer so no route/agent/backfill can bypass it. A null property `state` is an explicit escape valve (not blocked).

**Tech Stack:** TypeScript, Drizzle ORM (Postgres + RLS), Vitest, pnpm/Turborepo monorepo (`@savvy/core`, `@savvy/db`).

## Global Constraints

- Design spec: `docs/superpowers/specs/2026-07-05-cell-17a-license-matrix-design.md` — authoritative.
- Tenant isolation on every table + query. `license` gets an RLS policy via the `tenantIsolation()` schema helper (auto-emits `CREATE POLICY ... USING (tenant_id = current_setting('app.tenant_id')::uuid)`).
- Migration number is **0054** (latest on origin/main is 0053). Confirm with `packages/db/drizzle/meta/_journal.json` before generating.
- Block scope: **all appointment types** (inspection, sales, install).
- Jurisdiction key: `(state, city?)`; `city` NULL = state-level license covering all cities in that state.
- **Escape valve:** property with null/blank `state` is NOT blocked.
- Status vocabulary: `active` | `pending` | `expired` | `suspended`. Active = `status === 'active' && (expires_at IS NULL || expires_at > now)`.
- No real tenant keys in any tracked file.
- Every task: TDD (red → green), commit at the end. Run `pnpm typecheck` clean before each commit that touches types.
- **Local migrate gotcha:** local `db:migrate` can fail mid-sequence on pre-existing 0045/0050 journal drift. If it does, apply the generated `0054_*.sql` directly to the local dev DB; CI/prod journals are healthy and apply cleanly.

---

### Task 1: Pure license resolver (`@savvy/core`)

No DB access — takes an already-fetched license array so it is trivially unit-testable and reusable by both the scheduling block (Task 3) and the renewal check (Task 5).

**Files:**
- Create: `packages/core/src/license.ts`
- Test: `packages/core/src/license.test.ts`
- Modify: `packages/core/src/index.ts` (add barrel export)

**Interfaces:**
- Produces:
  - `type LicenseLike = { state: string; city: string | null; status: string; expiresAt: Date | null }`
  - `type Jurisdiction = { state: string | null | undefined; city?: string | null }`
  - `isLicenseActive(license: LicenseLike, now: Date): boolean`
  - `resolveActiveLicense(licenses: LicenseLike[], jurisdiction: Jurisdiction, now: Date): LicenseLike | null`
  - `type RenewalStatus = "ok" | "expiring_soon" | "expired"`
  - `licenseRenewalStatus(license: Pick<LicenseLike, "expiresAt">, now: Date, windowDays?: number): RenewalStatus`

- [ ] **Step 1: Write the failing test** — `packages/core/src/license.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { resolveActiveLicense, licenseRenewalStatus, type LicenseLike } from "./license";

const NOW = new Date("2026-07-05T00:00:00Z");
const lic = (o: Partial<LicenseLike>): LicenseLike => ({
  state: "AZ", city: null, status: "active", expiresAt: null, ...o,
});

describe("resolveActiveLicense", () => {
  it("state-level license (city null) permits any city in that state", () => {
    const licenses = [lic({ state: "AZ", city: null })];
    expect(resolveActiveLicense(licenses, { state: "AZ", city: "Mesa" }, NOW)).not.toBeNull();
  });

  it("city-specific license permits only that city", () => {
    const licenses = [lic({ state: "CO", city: "Denver" })];
    expect(resolveActiveLicense(licenses, { state: "CO", city: "Denver" }, NOW)).not.toBeNull();
    expect(resolveActiveLicense(licenses, { state: "CO", city: "Aurora" }, NOW)).toBeNull();
  });

  it("excludes expired, suspended, and pending licenses", () => {
    const past = new Date("2026-01-01T00:00:00Z");
    expect(resolveActiveLicense([lic({ expiresAt: past })], { state: "AZ", city: "Mesa" }, NOW)).toBeNull();
    expect(resolveActiveLicense([lic({ status: "suspended" })], { state: "AZ", city: "Mesa" }, NOW)).toBeNull();
    expect(resolveActiveLicense([lic({ status: "pending" })], { state: "AZ", city: "Mesa" }, NOW)).toBeNull();
  });

  it("returns null when no license matches the state", () => {
    expect(resolveActiveLicense([lic({ state: "AZ" })], { state: "CO", city: "Denver" }, NOW)).toBeNull();
  });

  it("returns null for a blank/undefined state (caller owns escape-valve policy)", () => {
    expect(resolveActiveLicense([lic({ state: "AZ" })], { state: null, city: null }, NOW)).toBeNull();
  });

  it("is case/whitespace insensitive on state and city", () => {
    const licenses = [lic({ state: "co", city: "denver " })];
    expect(resolveActiveLicense(licenses, { state: " CO", city: "Denver" }, NOW)).not.toBeNull();
  });
});

describe("licenseRenewalStatus", () => {
  it("ok when no expiry", () => {
    expect(licenseRenewalStatus({ expiresAt: null }, NOW)).toBe("ok");
  });
  it("expired when past expiry", () => {
    expect(licenseRenewalStatus({ expiresAt: new Date("2026-07-04T00:00:00Z") }, NOW)).toBe("expired");
  });
  it("expiring_soon within 60 days", () => {
    expect(licenseRenewalStatus({ expiresAt: new Date("2026-08-01T00:00:00Z") }, NOW)).toBe("expiring_soon");
  });
  it("ok beyond 60 days", () => {
    expect(licenseRenewalStatus({ expiresAt: new Date("2026-12-01T00:00:00Z") }, NOW)).toBe("ok");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @savvy/core test license`
Expected: FAIL — `Cannot find module './license'`.

- [ ] **Step 3: Write minimal implementation** — `packages/core/src/license.ts`

```ts
// Pure license-matrix resolver for Cell 17a. No DB access — takes an already-fetched
// license array so it is trivially unit-testable and reusable from both the scheduling
// block (@savvy/db) and the renewal evidence check (@savvy/core).

export type LicenseLike = {
  state: string;
  city: string | null;
  status: string;
  expiresAt: Date | null;
};

export type Jurisdiction = { state: string | null | undefined; city?: string | null };

const norm = (s: string | null | undefined): string => (s ?? "").trim().toUpperCase();

export function isLicenseActive(license: LicenseLike, now: Date): boolean {
  if (license.status !== "active") return false;
  return license.expiresAt == null || license.expiresAt > now;
}

export function resolveActiveLicense(
  licenses: LicenseLike[],
  jurisdiction: Jurisdiction,
  now: Date,
): LicenseLike | null {
  const state = norm(jurisdiction.state);
  if (state === "") return null; // caller decides escape-valve behavior for null state
  const city = norm(jurisdiction.city);
  const active = licenses.filter((l) => isLicenseActive(l, now) && norm(l.state) === state);
  // Prefer a city-specific match; fall back to a state-level (city == null) license.
  const citySpecific = active.find((l) => l.city != null && norm(l.city) === city);
  if (citySpecific) return citySpecific;
  return active.find((l) => l.city == null) ?? null;
}

export type RenewalStatus = "ok" | "expiring_soon" | "expired";

export function licenseRenewalStatus(
  license: Pick<LicenseLike, "expiresAt">,
  now: Date,
  windowDays = 60,
): RenewalStatus {
  if (license.expiresAt == null) return "ok";
  if (license.expiresAt <= now) return "expired";
  const days = (license.expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
  return days <= windowDays ? "expiring_soon" : "ok";
}
```

- [ ] **Step 4: Add barrel export** — append to `packages/core/src/index.ts`

```ts
export * from "./license";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @savvy/core test license`
Expected: PASS (all cases).

- [ ] **Step 6: Typecheck + commit**

```bash
pnpm --filter @savvy/core typecheck
git add packages/core/src/license.ts packages/core/src/license.test.ts packages/core/src/index.ts
git commit -m "feat(core): pure license-matrix resolver (cell 17a)"
```

---

### Task 2: `license` schema + migration 0054 (`@savvy/db`)

**Files:**
- Create: `packages/db/src/schema/compliance.ts`
- Modify: `packages/db/src/schema/index.ts` (barrel export)
- Generate: `packages/db/drizzle/0054_*.sql` (+ `meta/_journal.json` update) via `db:generate`
- Test: `packages/db/src/schema/compliance.test.ts`

**Interfaces:**
- Consumes: `idCol`, `createdAt`, `updatedAt`, `tenantIsolation` from `./_rls`; `tenant` from `./tenancy`.
- Produces: `export const license` Drizzle table with columns `id, tenantId, state, city, authority, licenseNumber, status, issuedAt, expiresAt, createdAt, updatedAt`.

- [ ] **Step 1: Write the schema** — `packages/db/src/schema/compliance.ts`

```ts
import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
import { idCol, createdAt, updatedAt, tenantIsolation } from "./_rls";
import { tenant } from "./tenancy";

// Per-tenant, per-jurisdiction license matrix (Cell 17a). city NULL = state-level
// license (e.g. AZ ROC covers all AZ cities); city set = municipal registration
// (Denver, Aurora). The scheduling block invariant (bookAppointment) refuses to
// schedule in a jurisdiction with no active license row here.
export const license = pgTable("license", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  state: text("state").notNull(),
  city: text("city"),
  authority: text("authority").notNull(),
  licenseNumber: text("license_number").notNull(),
  status: text("status").notNull(), // active | pending | expired | suspended
  issuedAt: timestamp("issued_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  index("license_tenant_state_city_idx").on(t.tenantId, t.state, t.city),
  tenantIsolation(),
]);
```

- [ ] **Step 2: Add barrel export** — add to `packages/db/src/schema/index.ts` (alongside the other `export * from "./..."` lines)

```ts
export * from "./compliance";
```

- [ ] **Step 3: Generate the migration**

Run: `pnpm --filter @savvy/db db:generate`
Expected: creates `packages/db/drizzle/0054_*.sql` containing `CREATE TABLE ... "license"`, `ALTER TABLE "license" ENABLE ROW LEVEL SECURITY`, the `tenant_id` FK, the index, and `CREATE POLICY "tenant_isolation" ON "license" ...`. Confirm the number is 0054; if `db:generate` produced a different number, a migration landed since — stop and reconcile.

- [ ] **Step 4: Apply to local dev DB**

Run: `pnpm --filter @savvy/db db:migrate`
Expected: applies 0054. **If it errors on 0045/0050 journal drift** (known local gotcha), apply the new file directly instead:
`psql "$DATABASE_URL" -f packages/db/drizzle/0054_*.sql`
(Use the local dev `DATABASE_URL`; do not touch prod here.)

- [ ] **Step 5: Write the round-trip + isolation test** — `packages/db/src/schema/compliance.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { withTenant, eq } from "../client"; // match the import path other lifecycle tests use
import { license } from "../schema/compliance";

// Use the existing test tenant helpers/fixtures this repo's db tests use.
// Replace TENANT_A / TENANT_B with the standard seeded test tenant ids.
describe("license table", () => {
  it("round-trips a license row under tenant scope", async () => {
    await withTenant(TENANT_A, async (tx) => {
      await tx.insert(license).values({
        tenantId: TENANT_A, state: "AZ", city: null, authority: "AZ ROC",
        licenseNumber: "ROC-123456", status: "active",
      });
      const rows = await tx.select().from(license).where(eq(license.tenantId, TENANT_A));
      expect(rows.some((r) => r.state === "AZ" && r.city === null)).toBe(true);
    });
  });

  it("RLS hides another tenant's licenses", async () => {
    await withTenant(TENANT_B, async (tx) => {
      const rows = await tx.select().from(license).where(eq(license.state, "AZ"));
      expect(rows.find((r) => r.tenantId === TENANT_A)).toBeUndefined();
    });
  });
});
```

> Note for the implementer: open an existing `packages/db/src/**/*.test.ts` first to copy the exact test-tenant fixture (`TENANT_A`/`TENANT_B` ids and the `withTenant`/`adminDb`/`eq` import paths). Do not invent fixtures — reuse the repo's.

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm --filter @savvy/db test compliance`
Expected: PASS.

- [ ] **Step 7: Typecheck + commit**

```bash
pnpm --filter @savvy/db typecheck
git add packages/db/src/schema/compliance.ts packages/db/src/schema/index.ts \
        packages/db/drizzle/0054_*.sql packages/db/drizzle/meta/_journal.json \
        packages/db/src/schema/compliance.test.ts
git commit -m "feat(db): license matrix table + RLS (migration 0054, cell 17a)"
```

---

### Task 3: `LicenseRequiredError` + scheduling block in `bookAppointment` (the acceptance)

**Files:**
- Modify: `packages/db/src/lifecycle/appointments.ts` (add error class + block inside `bookAppointment`'s `withTenant` tx)
- Test: `packages/db/src/lifecycle/appointments-license.test.ts` (new sibling — keeps the red-path suite focused)

**Interfaces:**
- Consumes: `resolveActiveLicense` from `@savvy/core`; `license` from `../schema/compliance`; existing `job`, `property` schema tables; existing `withTenant`, `eq`, `appointment` imports in the file.
- Produces: `export class LicenseRequiredError extends Error` with `state: string` and `city: string | null` fields.

- [ ] **Step 1: Write the failing red-path test** — `packages/db/src/lifecycle/appointments-license.test.ts`

```ts
import { describe, it, expect } from "vitest";
// Reuse the exact fixture/imports from appointments.test.ts (adminDb, withTenant,
// customer, property, job, crew, tenantId helpers). Open that file and mirror setup.
import { bookAppointment, LicenseRequiredError } from "./appointments";
import { license } from "../schema/compliance";

// helper: create customer+property(state)+job, return jobId
async function makeJob(tenantId: string, state: string | null) { /* mirror appointments.test.ts setup, set property.state = state */ }

describe("bookAppointment license block (cell 17a)", () => {
  it("throws LicenseRequiredError for a CO property with no CO license", async () => {
    const jobId = await makeJob(TENANT_A, "CO");
    await expect(bookAppointment({
      tenantId: TENANT_A, jobId, type: "inspection", assigneeUserId: null,
      startsAt: new Date("2026-08-01T15:00:00Z"), endsAt: new Date("2026-08-01T16:00:00Z"),
    })).rejects.toBeInstanceOf(LicenseRequiredError);
  });

  it("succeeds once an active CO license exists", async () => {
    const jobId = await makeJob(TENANT_A, "CO");
    await withTenant(TENANT_A, async (tx) => {
      await tx.insert(license).values({
        tenantId: TENANT_A, state: "CO", city: null, authority: "CO SoS",
        licenseNumber: "CO-1", status: "active",
      });
    });
    const res = await bookAppointment({
      tenantId: TENANT_A, jobId, type: "inspection", assigneeUserId: null,
      startsAt: new Date("2026-08-02T15:00:00Z"), endsAt: new Date("2026-08-02T16:00:00Z"),
    });
    expect(res.id).toBeTruthy();
  });

  it("does NOT block a property with a null state (escape valve)", async () => {
    const jobId = await makeJob(TENANT_A, null);
    const res = await bookAppointment({
      tenantId: TENANT_A, jobId, type: "install", assigneeUserId: null,
      startsAt: new Date("2026-08-03T15:00:00Z"), endsAt: new Date("2026-08-03T16:00:00Z"),
    });
    expect(res.id).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @savvy/db test appointments-license`
Expected: FAIL — `LicenseRequiredError` is not exported / no block yet (booking succeeds where it should throw).

- [ ] **Step 3: Implement the error + block** — edit `packages/db/src/lifecycle/appointments.ts`

Add imports at the top (extend the existing `@savvy/db`-internal imports and add the core resolver):

```ts
import { resolveActiveLicense } from "@savvy/core";
import { job, property, license } from "../schema"; // add to existing schema imports
```

Add the error class near `SlotTakenError`:

```ts
export class LicenseRequiredError extends Error {
  constructor(public state: string, public city: string | null) {
    super(`no active license for ${city ? `${city}, ` : ""}${state}`);
    this.name = "LicenseRequiredError";
  }
}
```

Inside `bookAppointment`, at the **start** of the `withTenant(tenantId, async (tx) => { ... })` callback, before the `tx.insert(appointment)`:

```ts
// Cell 17a: block scheduling in a jurisdiction with no active license.
const [jrow] = await tx
  .select({ propertyId: job.propertyId })
  .from(job)
  .where(eq(job.id, input.jobId));
if (jrow) {
  const [prop] = await tx
    .select({ state: property.state, city: property.city })
    .from(property)
    .where(eq(property.id, jrow.propertyId));
  const state = (prop?.state ?? "").trim();
  if (state !== "") {
    const lics = await tx
      .select({ state: license.state, city: license.city, status: license.status, expiresAt: license.expiresAt })
      .from(license)
      .where(eq(license.tenantId, tenantId));
    if (!resolveActiveLicense(lics, { state, city: prop?.city ?? null }, new Date())) {
      throw new LicenseRequiredError(state, prop?.city ?? null);
    }
  }
}
```

> The throw is inside the existing `try` whose `catch` only rewrites exclusion violations to `SlotTakenError` and re-throws everything else — so `LicenseRequiredError` propagates unchanged.

- [ ] **Step 4: Run the red-path test to verify it passes**

Run: `pnpm --filter @savvy/db test appointments-license`
Expected: PASS (throws when unlicensed, succeeds when licensed, escape valve honored).

- [ ] **Step 5: Regression — existing appointment tests still green**

Run: `pnpm --filter @savvy/db test appointments`
Expected: PASS — existing tests create properties with null `state`, so the escape valve leaves them unblocked.

- [ ] **Step 6: Typecheck + commit**

```bash
pnpm --filter @savvy/db typecheck
git add packages/db/src/lifecycle/appointments.ts packages/db/src/lifecycle/appointments-license.test.ts
git commit -m "feat(db): block scheduling in unlicensed jurisdiction (cell 17a)"
```

---

### Task 4: Seed an active AZ license for the demo tenant

Realistic-data hygiene: the demo tenant operates in AZ, so seed a state-level AZ ROC license. Not a test fix (the escape valve covers tests) — it keeps the seeded demo app schedulable and gives Cell 20 a pattern to clone.

**Files:**
- Modify: `packages/db/src/seed.ts`

- [ ] **Step 1: Locate the demo tenant insert** in `packages/db/src/seed.ts` and note the tenant id variable (e.g. `tenantId`/`demoTenant.id`) and the `db`/`adminDb` handle the seed uses.

- [ ] **Step 2: Add the license seed** after the tenant (and before/after property seeding — order-independent since it only needs the tenant id):

```ts
// Cell 17a: seed the demo tenant's home-state license so seeded jobs are schedulable.
await db.insert(license).values({
  tenantId,                       // the demo tenant id used elsewhere in this file
  state: "AZ",
  city: null,                     // state-level: covers all AZ cities
  authority: "AZ ROC",
  licenseNumber: "ROC-DEMO-0001",
  status: "active",
  expiresAt: null,
});
```

Add the import if not already present: `import { license } from "./schema/compliance";` (or via the schema barrel the file already imports from).

- [ ] **Step 3: Run the seed against local dev DB**

Run: `pnpm --filter @savvy/db db:seed`
Expected: completes without error; a `license` row for the demo tenant exists (`select * from license;`).

- [ ] **Step 4: Commit**

```bash
git add packages/db/src/seed.ts
git commit -m "chore(db): seed demo tenant AZ ROC license (cell 17a)"
```

---

### Task 5: `production.license` renewal evidence check (60-day card)

Surfaces active licenses expiring within 60 days (or already expired) as an amber exception card on the Agents surface, via the existing evidence-check plumbing.

> **Scope guard:** this task wires a new `check_key` into `evidenceChecks` **and** the `task_registry` seed, and the handoff notes a new check binding can trip `packages/db/src/**/master-task-list.test.ts`'s bound-set assertion. If that wiring proves larger than a single tight task, **stop, ship Tasks 1–4 as the Cell 17a acceptance PR, and split Task 5 into a follow-up** — say so rather than ballooning this PR.

**Files:**
- Modify: `packages/core/src/verification/checks.ts` (register `"production.license"`)
- Modify: the `task_registry` seed (`packages/db/seeds/master-task-list.ts` or wherever `check_key`s are registered) to add the `production.license` binding
- Modify: `packages/db/src/**/master-task-list.test.ts` bound-set assertion if it enumerates expected check keys
- Test: add a case to `packages/core/src/verification/*.test.ts` (mirror an existing check test)

- [ ] **Step 1: Read** `packages/core/src/verification/checks.ts` (the `invariant(...)` builder + `windowParams`) and an existing check test to copy the exact harness.

- [ ] **Step 2: Write the failing check test** (mirror an existing verification test): seed one license expiring in 30 days and one expiring in 200 days; assert `production.license` returns only the 30-day row.

- [ ] **Step 3: Register the check** in `evidenceChecks`:

```ts
// Amber card: an active license within 60 days of expiry (or expired) needs renewal.
"production.license": invariant(
  "production.license",
  `select id, authority, expires_at
     from license
    where tenant_id = $1
      and status = 'active'
      and expires_at is not null
      and expires_at < now() + interval '60 days'`,
  { params: (ctx) => [ctx.tenantId], toRef: (r) => ({ type: "license", ref: String(r.id) }) },
),
```

- [ ] **Step 4: Register the `check_key`** in the task_registry seed and update the `master-task-list.test.ts` expected bound-set if present.

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @savvy/core test verification` and `pnpm --filter @savvy/db test master-task-list`
Expected: PASS.

- [ ] **Step 6: Typecheck + commit**

```bash
pnpm typecheck
git add packages/core/src/verification/ packages/db/seeds/ packages/db/src/
git commit -m "feat(core): production.license 60-day renewal evidence check (cell 17a)"
```

---

## Finalization (after tasks)

- [ ] Run full gates: `pnpm typecheck && pnpm lint && pnpm --filter @savvy/core test && pnpm --filter @savvy/db test`
- [ ] Update the STATUS block in `docs/superpowers/specs/first-20-cells.md` for cell 17: license matrix + scheduling block DONE (17a); SB38 templates remaining (17b).
- [ ] Open PR against `main`: `gh pr create --base main`. Body: cell 17a, task IDs, and "what proves it ran" = the red-path test in `appointments-license.test.ts`.
- [ ] `gh pr checks <n> --watch` before merge (CI runs e2e twice; `lead-capture.spec` is flaky — `gh run rerun <id> --failed` if only one e2e run trips on it).

## Self-review notes
- **Spec coverage:** license table (Task 2) ✓ · pure resolver (Task 1) ✓ · hard block all appt types (Task 3) ✓ · escape valve (Task 1 returns null on blank state + Task 3 guards before throwing) ✓ · state+city key with nullable city (Task 2 schema, Task 1 resolver) ✓ · authority column (Task 2) ✓ · 60-day renewal card (Task 5) ✓ · seed (Task 4) ✓ · red-path test = deliverable (Task 3) ✓. SB38 correctly deferred to 17b.
- **Type consistency:** `LicenseLike`/`Jurisdiction`/`resolveActiveLicense`/`licenseRenewalStatus` names identical across Tasks 1/3/5; `license` table column names (`state, city, authority, licenseNumber, status, issuedAt, expiresAt`) identical across Tasks 2/3/4/5.
- **Fixtures:** Tasks 2 & 3 tests intentionally instruct the implementer to copy the repo's real test-tenant fixtures rather than invent ids — the one place the plan defers to existing code by design.
