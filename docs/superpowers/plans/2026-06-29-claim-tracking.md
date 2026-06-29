# Thin Claim Tracking (G, PR-1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A thin, NON-SuppIQ `claim` record per insurance job (claim #, carrier name, adjuster, ACV/RCV, deductible, status) + lifecycle to upsert/read it. Backend foundation; UI + task wiring are G-2.

**Architecture:** New `claim` table (one per job, `tenantIsolation()` RLS) + `CLAIM_STATUS` core enum + `upsertClaim`/`getClaimForJob` lifecycle. No supplement AI/KB/letters (SuppIQ/Phase-9). No `carrier` FK (Phase 9 owns it).

## Global Constraints
- **`.js` rule:** db `.test.ts` USE `.js`; core/db SOURCE NO `.js`.
- **Migration (new TABLE — higher risk):** after `pnpm db:generate` the file is `0030_*.sql`. It MUST contain `CREATE TABLE "claim" (...)` AND the RLS `ALTER TABLE "claim" ENABLE ROW LEVEL SECURITY;` + `CREATE POLICY ... TO savvy_app` lines from `tenantIsolation()` (compare to a prior new-table migration). NO drops of other tables. Commit the `.sql` AND meta (`_journal.json` entry idx 30 + `0030_snapshot.json`) — `git add packages/db/drizzle`. If db:generate emits anything unexpected, STOP and report.
- Migration grants: after migrate, the `savvy_app` role needs table grants — the repo's `db:migrate` applies `rls-grants.sql`; if the test hits a permission error on `claim`, run `pnpm --filter @savvy/db db:migrate` (which re-applies grants) — same as prior new-table slices.
- **Tenant isolation:** lifecycle via `withTenant`; the table carries `tenant_id` + `tenantIsolation()`.
- Focused tests: db → `pnpm --filter @savvy/db exec vitest run tests/claim.test.ts` (docker `savvy_db`; `pnpm db:up && pnpm --filter @savvy/db db:migrate` if `ECONNREFUSED`).
- Final gate: `pnpm test && pnpm typecheck && pnpm lint` green.

## File Structure
| File | Change |
|---|---|
| `packages/core/src/enums.ts` | append `CLAIM_STATUS` + `ClaimStatus` | Modify |
| `packages/db/src/schema/enums.ts` | `claimStatusEnum` | Modify |
| `packages/db/src/schema/insurance.ts` | `claim` table (replace stub) | Modify |
| `packages/db/drizzle/*` | migration + meta | Create |
| `packages/db/src/lifecycle/claim.ts` | `upsertClaim` + `getClaimForJob` | Create |
| `packages/db/src/index.ts` | export them | Modify |
| `packages/db/tests/claim.test.ts` | db tests | Create |
| `docs/jobs-pipeline.md` | Claim tracking section | Modify |

---

## Task 1: Core — CLAIM_STATUS enum (haiku)

**Files:** Modify `packages/core/src/enums.ts`.

- [ ] **Step 1: Append to `packages/core/src/enums.ts`** (at END, with the other `export const … as const` enums):
```ts
export const CLAIM_STATUS = ["filed", "adjuster_scheduled", "approved", "partial", "denied", "closed"] as const;
export type ClaimStatus = (typeof CLAIM_STATUS)[number];
```

- [ ] **Step 2: Verify it compiles** — `pnpm --filter @savvy/core exec vitest run` (existing tests still pass; no new test needed for a const enum — it's exercised by the db schema + tests). Then `pnpm --filter @savvy/core typecheck` or `pnpm typecheck`.

- [ ] **Step 3: Commit** — `git add packages/core/src/enums.ts && git commit -m "feat(core): CLAIM_STATUS enum"`

---

## Task 2: DB — claim table + migration + lifecycle (sonnet)

**Files:** Modify `packages/db/src/schema/enums.ts`, `packages/db/src/schema/insurance.ts`, `packages/db/src/index.ts`; Create migration + `packages/db/src/lifecycle/claim.ts` + `packages/db/tests/claim.test.ts`.

**Interfaces:** Consumes `CLAIM_STATUS` (Task 1). Produces `claim` table, `upsertClaim`, `getClaimForJob`.

- [ ] **Step 1: Add the enum + table**

`packages/db/src/schema/enums.ts` — add (import `CLAIM_STATUS` from `@savvy/core` alongside the other enum imports):
```ts
export const claimStatusEnum = pgEnum("claim_status", CLAIM_STATUS);
```

`packages/db/src/schema/insurance.ts` — replace the `export {}` body with (keep the leading Phase-9 comment about carrier/supplement being SuppIQ-owned):
```ts
import { pgTable, uuid, text, integer, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { idCol, createdAt, tenantIsolation } from "./_rls";
import { tenant } from "./tenancy";
import { job } from "./jobs";
import { claimStatusEnum } from "./enums";

// Thin claim tracking (slice G). The SuppIQ supplement intelligence (carrier/
// supplement tables, KB, letters) stays the deferred Phase-9 add-on; this is
// just the administrative claim record per insurance job.
export const claim = pgTable("claim", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  jobId: uuid("job_id").notNull().references(() => job.id),
  claimNumber: text("claim_number"),
  carrierName: text("carrier_name"),
  adjusterName: text("adjuster_name"),
  adjusterPhone: text("adjuster_phone"),
  status: claimStatusEnum("status").notNull().default("filed"),
  acvCents: integer("acv_cents"),
  rcvCents: integer("rcv_cents"),
  deductibleCents: integer("deductible_cents"),
  filedAt: timestamp("filed_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex("claim_job_uniq").on(t.jobId),
  index("claim_tenant_status_idx").on(t.tenantId, t.status),
  tenantIsolation(),
]);
```

- [ ] **Step 2: Generate + inspect + apply** — `pnpm db:generate`; inspect `packages/db/drizzle/0030_*.sql`: must `CREATE TABLE "claim"`, create the unique + status indexes, ENABLE RLS, and `CREATE POLICY "tenant_isolation" ON "claim" ... TO savvy_app` (compare to an existing new-table migration like `material_order`'s). NO drops. Confirm `_journal.json` (idx 30) + `0030_snapshot.json`. Then `pnpm db:up && pnpm --filter @savvy/db db:migrate`.

- [ ] **Step 3: Failing tests** — `packages/db/tests/claim.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { upsertClaim, getClaimForJob } from "../src/lifecycle/claim.js";
import { withTenant } from "../src/tenant.js";
import { claim } from "../src/schema/index.js";
import { eq } from "drizzle-orm";
import { makeTenant, makeJobWithCustomer } from "./helpers.js";

describe("claim lifecycle", () => {
  it("upserts (create then update) one claim per job", async () => {
    const { tenantId } = await makeTenant();
    const { jobId } = await makeJobWithCustomer(tenantId);
    const c1 = await upsertClaim({ tenantId, jobId, claimNumber: "CLM-1", status: "filed", acvCents: 100000 });
    expect(c1.claimNumber).toBe("CLM-1");
    const c2 = await upsertClaim({ tenantId, jobId, status: "approved", rcvCents: 250000 });
    expect(c2.id).toBe(c1.id); // same row (one per job)
    expect(c2.status).toBe("approved");
    expect(c2.rcvCents).toBe(250000);
    const rows = await withTenant(tenantId, (tx) => tx.select().from(claim).where(eq(claim.jobId, jobId)));
    expect(rows).toHaveLength(1);
    const got = await getClaimForJob(tenantId, jobId);
    expect(got?.id).toBe(c1.id);
  });

  it("getClaimForJob returns null when none", async () => {
    const { tenantId } = await makeTenant();
    const { jobId } = await makeJobWithCustomer(tenantId);
    expect(await getClaimForJob(tenantId, jobId)).toBeNull();
  });

  it("is tenant-isolated (RLS): another tenant cannot read it", async () => {
    const { tenantId: a } = await makeTenant();
    const { jobId } = await makeJobWithCustomer(a);
    await upsertClaim({ tenantId: a, jobId, claimNumber: "CLM-A" });
    const { tenantId: b } = await makeTenant();
    const seenFromB = await withTenant(b, (tx) => tx.select().from(claim).where(eq(claim.jobId, jobId)));
    expect(seenFromB).toHaveLength(0);
  });
});
```

- [ ] **Step 4: Run → fail.** `pnpm --filter @savvy/db exec vitest run tests/claim.test.ts`

- [ ] **Step 5: Implement** — `packages/db/src/lifecycle/claim.ts`:
```ts
import { and, eq } from "drizzle-orm";
import { claim } from "../schema/index";
import { withTenant } from "../tenant";
import type { ClaimStatus } from "@savvy/core";

export type ClaimRow = typeof claim.$inferSelect;

export type UpsertClaimInput = {
  tenantId: string; jobId: string;
  claimNumber?: string | null; carrierName?: string | null;
  adjusterName?: string | null; adjusterPhone?: string | null;
  status?: ClaimStatus; acvCents?: number | null; rcvCents?: number | null;
  deductibleCents?: number | null; filedAt?: Date | null;
};

/** Insert-or-update the job's single claim (one per job via the jobId unique index). */
export async function upsertClaim(input: UpsertClaimInput): Promise<ClaimRow> {
  const { tenantId, jobId, ...rest } = input;
  // Only set columns that were provided (so an update doesn't null untouched fields).
  const set: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rest)) if (v !== undefined) set[k] = v;
  return withTenant(tenantId, async (tx) => {
    const [row] = await tx.insert(claim)
      .values({ tenantId, jobId, ...set })
      .onConflictDoUpdate({ target: claim.jobId, set })
      .returning();
    return row!;
  });
}

export async function getClaimForJob(tenantId: string, jobId: string): Promise<ClaimRow | null> {
  return withTenant(tenantId, async (tx) => {
    const [row] = await tx.select().from(claim).where(and(eq(claim.tenantId, tenantId), eq(claim.jobId, jobId)));
    return row ?? null;
  });
}
```
Export from `packages/db/src/index.ts`: `export { upsertClaim, getClaimForJob, type ClaimRow } from "./lifecycle/claim";` (and confirm `claim` is exported via the schema barrel — `export * from "./schema/index"` already re-exports `insurance.ts`).

- [ ] **Step 6: Run → pass.** `pnpm --filter @savvy/db exec vitest run tests/claim.test.ts` (3 green).

- [ ] **Step 7: Commit** — `git add packages/db/src/schema/enums.ts packages/db/src/schema/insurance.ts packages/db/drizzle packages/db/src/lifecycle/claim.ts packages/db/src/index.ts packages/db/tests/claim.test.ts && git commit -m "feat(db): thin claim table + upsertClaim/getClaimForJob"`

---

## Task 3: Docs + full verification (haiku)

**Files:** Modify `docs/jobs-pipeline.md`.

- [ ] **Step 1: Docs** — add to `docs/jobs-pipeline.md`:
```markdown
### Claim tracking (G)

Insurance jobs (`job.type='insurance'`) get one thin `claim` record (claim #, carrier name, adjuster,
ACV/RCV, deductible, `claim_status`), upserted via `upsertClaim` / read via `getClaimForJob` — one claim
per job (`claim_job_uniq`), tenant-isolated. This is administrative tracking ONLY; supplement
intelligence (KB, code lookup, carrier-rebuttal letters) remains the deferred SuppIQ/Phase-9 add-on,
and the `carrier`/`supplement` tables are still its stubs. The cockpit UI + lifecycle-task wiring +
adjuster scheduling are slice G-2.
```

- [ ] **Step 2: Commit** — `git add docs/jobs-pipeline.md && git commit -m "docs: claim tracking (G)"`

- [ ] **Step 3: Full verification** — `pnpm test && pnpm typecheck && pnpm lint` → all green (≥682 tests: 679 prior + 3 claim). (If db `ECONNREFUSED`: `pnpm db:up && pnpm --filter @savvy/db db:migrate`, re-run.)

---

## Self-Review notes
- **Coverage:** core enum (T1) · db table+lifecycle (T2) · docs+verify (T3).
- **Type consistency:** `CLAIM_STATUS`/`ClaimStatus`/`claimStatusEnum`/`claim`/`upsertClaim`/`getClaimForJob`/`ClaimRow` used identically.
- **Migration:** new table WITH `tenantIsolation()` RLS policy `TO savvy_app` + meta committed (inspect the SQL).
- **Seam-compatible:** no `carrier` FK (Phase 9 owns it); `claim.jobId -> job` matches DATA-MODEL; supplement intelligence untouched.
- **upsert** sets only provided fields (no clobber of untouched columns on update).
