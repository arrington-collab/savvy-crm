# G — Thin claim tracking (data model + lifecycle) — Design

**Date:** 2026-06-29
**Slice:** Jobs build, slice G (PR-1: backend foundation). G-2 (cockpit UI panel + task wiring + adjuster scheduling) is a follow-up.

## Problem

Insurance jobs (`job.type='insurance'`) have no place to record the claim's administrative facts
(claim #, carrier, adjuster, ACV/RCV, deductible, status). The insurance entities are commented-out
stubs reserved for the deferred SuppIQ/Phase-9 add-on.

## Goal

A **thin, NON-SuppIQ** claim record per job — just the administrative tracking facts — that keeps the
Phase-9 seams intact and explicitly does **NOT** build supplement intelligence, KB, code lookup, or
carrier-rebuttal letters (that stays SuppIQ). This PR ships the **data model + lifecycle + tests**; the
cockpit UI + lifecycle-task wiring + adjuster scheduling are G-2.

## Approach

A new `claim` table (one per job), mirroring the DATA-MODEL.md claim seam (`claim.jobId -> job`),
minus the `carrier` FK (Phase 9 owns the `carrier` table — a `carrierName` text keeps it standalone;
Phase 9 can add `carrier_id` later as a column add). Tenant-isolated via `tenantIsolation()` RLS like
every other table.

### Core (`packages/core/src/enums.ts`, append)
```ts
export const CLAIM_STATUS = ["filed","adjuster_scheduled","approved","partial","denied","closed"] as const;
export type ClaimStatus = (typeof CLAIM_STATUS)[number];
```

### DB
- `packages/db/src/schema/enums.ts`: `export const claimStatusEnum = pgEnum("claim_status", CLAIM_STATUS);`
- `packages/db/src/schema/insurance.ts` (replace the `export {}` stub with the real table; keep the
  Phase-9 carrier/supplement comment):
```ts
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
  uniqueIndex("claim_job_uniq").on(t.jobId),       // one claim per job
  index("claim_tenant_status_idx").on(t.tenantId, t.status),
  tenantIsolation(),
]);
```
  (Ensure `insurance.ts` is exported from `packages/db/src/schema/index.ts` — it's already re-exported
  via the schema barrel; confirm `claim` is then exported from `@savvy/db`.)
- `packages/db/src/lifecycle/claim.ts`:
  - `upsertClaim(input: { tenantId; jobId; claimNumber?; carrierName?; adjusterName?; adjusterPhone?; status?; acvCents?; rcvCents?; deductibleCents?; filedAt? }) → ClaimRow` — insert-or-update the job's claim (`onConflictDoUpdate` on the `jobId` unique index), `withTenant`.
  - `getClaimForJob(tenantId, jobId) → ClaimRow | null`, `withTenant`.
  - Export both from `@savvy/db`.

## Testing
- **DB** (`packages/db/tests/claim.test.ts`): `upsertClaim` creates then updates the same job's claim
  (one row, fields updated); `getClaimForJob` returns it / null; **cross-tenant RLS** (a second tenant
  can't read tenant-A's claim — mirror the established isolation test).
- Migration is a **new table** → the generated `0030_*.sql` must `CREATE TABLE "claim"` AND the RLS
  `CREATE POLICY ... TO savvy_app` from `tenantIsolation()`. Inspect both are present; commit meta.
- **Docs:** `docs/jobs-pipeline.md` — a "Claim tracking (G)" section.

## Out of scope (G-2 / SuppIQ)
- **No supplement AI / KB / code lookup / carrier letters** — that is the deferred SuppIQ/Phase-9 product.
- **No cockpit UI** to view/edit the claim (G-2).
- **No wiring of the 20 `Insurance Claim Management` lifecycle tasks / adjuster scheduling** (G-2).
- **No `carrier` table / `carrier_id` FK** — `carrierName` text suffices; Phase 9 owns `carrier`.
