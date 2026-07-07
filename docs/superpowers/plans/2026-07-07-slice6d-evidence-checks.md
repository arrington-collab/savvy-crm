# Slice 6d — Evidence Checks (lead.doc_parse + estimate.lead_stage) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two evidence invariants — `lead.doc_parse` (every typed lead document reaches a terminal parse status within 1h) and `estimate.lead_stage` (every lead-scoped estimate cites the measurement source it was priced from) — and bind them into the health-sweep registry.

**Architecture:** Stamp `measurement_source` onto the estimate at draft time (a pricing-inputs citation), then add two SQL `invariant()` checks to the `@savvy/core` evidence registry and bind them to their 1:1 master task ids in `CHECK_BINDINGS`. Both follow the existing `lead.score` pattern (zero violation rows = pass, any rows = fail); no new evaluation machinery — the nightly per-tenant health sweep already runs every bound check.

**Tech Stack:** TypeScript, Drizzle/Postgres (RLS), the existing evidence/verification system (`invariant()` builder, `evidenceChecks` registry, `CHECK_BINDINGS`, health sweep), Vitest. pnpm + Turborepo.

## Global Constraints

- **Branch:** create `slice6d-evidence-checks` off `slice6c-insurance-parse` (stacked; 6d builds on 6a/6b/6c). All work commits there.
- **Tenant isolation:** invariants are `$1 = tenantId` scoped; every DB op via `withTenant`/`adminDb` (fixtures). No cross-tenant leakage.
- **Invariant semantics (exact):** `invariant(name, sqlText, { toRef })` — the SQL selects VIOLATION rows; zero rows → pass, any rows → fail. `$1` is the tenant id. Model on `lead.score` (uses `now() - interval '1 hour'`, no window params).
- **`lead.doc_parse` rule:** a document with `kind IN ('insurance_estimate','measurement_report')` and `created_at < now() - interval '1 hour'` and `parse_status = 'pending'` is a violation. `parse_failed` and `unparsed_low_confidence` are valid *carded terminal* states → NOT violations (only stuck-`pending` fails).
- **`estimate.lead_stage` rule:** a lead-scoped estimate (`lead_id IS NOT NULL`) with `measurement_id IS NOT NULL` but `measurement_source IS NULL` is a violation (it doesn't cite its pricing measurement source).
- **Binding:** `CHECK_BINDINGS` maps `taskId → check_key` (1:1). Bind `lead.doc_parse → 49` ("Measurement report review & import") and `estimate.lead_stage → 52` ("Xactimate estimate creation"). Adding to `CHECK_BINDINGS` REQUIRES updating the bound-set assertion in `packages/db/tests/master-task-list.test.ts` (it hard-codes the exact bound id array) — and every bound key MUST exist in `evidenceChecks` (the no-orphan test).
- **Every task ships tests + passes `pnpm typecheck` + `pnpm lint` before commit.**
- **ESM `.js` import extensions in `@savvy/db` tests.**
- **Local dev Postgres** is up and migrated through 0066; run `pnpm db:migrate` after generating 0067. If migrate errors on drift, STOP and report (do not `db:reset` without asking).
- **Migration numbering:** next after 6c's 0066 → **0067**.

---

### Task 1: `estimate.measurement_source` column (migration 0067) + stamp at draft

**Files:**
- Modify: `packages/db/src/schema/finance.ts` (the `estimate` table)
- Create (generated + hand-edited): `packages/db/drizzle/0067_*.sql` + `packages/db/drizzle/meta/*`
- Modify: `packages/db/src/lifecycle/estimate.ts` (`insertEstimateFromMeasurementTx` stamp)
- Create: `packages/db/tests/estimate-measurement-source.test.ts`

**Interfaces:**
- Consumes: `measurement.source` (6b column); `draftLeadEstimateIfReady` (existing).
- Produces: `estimate` gains `measurementSource` (text, nullable), stamped from the priced measurement's `source` at draft time; existing lead estimates backfilled.

- [ ] **Step 1: Write the failing test**

Create `packages/db/tests/estimate-measurement-source.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { draftLeadEstimateIfReady } from "../src/lifecycle/estimate.js";
import { ensurePriceBook } from "../src/lifecycle/price-book.js";
import { withTenant } from "../src/tenant.js";
import { adminDb, appointment, measurement, estimate, eq } from "../src/index.js";
import { makeTenant, makeLeadWithProperty } from "./helpers.js";

describe("estimate cites its measurement source", () => {
  it("stamps measurement_source from the priced measurement at draft time", async () => {
    const { tenantId } = await makeTenant();
    const { leadId, propertyId } = await makeLeadWithProperty(tenantId);
    await ensurePriceBook(tenantId);
    await adminDb.insert(appointment).values({
      tenantId, leadId, propertyId, type: "inspection", status: "done",
      startsAt: new Date(Date.now() - 7200_000), endsAt: new Date(Date.now() - 3600_000),
    });
    await withTenant(tenantId, (tx) => tx.insert(measurement).values({
      tenantId, propertyId, provider: "roofr", source: "uploaded_report",
      areas: { squares: 20, predominantPitch: "8/12", eaveLf: 100, rakeLf: 50 },
    }));

    const res = await draftLeadEstimateIfReady({ tenantId, leadId });
    expect("estimateId" in res).toBe(true);
    const [e] = await adminDb.select().from(estimate).where(eq(estimate.id, (res as { estimateId: string }).estimateId));
    expect(e!.measurementSource).toBe("uploaded_report");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @savvy/db exec vitest run tests/estimate-measurement-source.test.ts`
Expected: FAIL — `column "measurement_source" of relation "estimate" does not exist` (or a TS error on `measurementSource`).

- [ ] **Step 3: Edit the schema**

In `packages/db/src/schema/finance.ts`, add `measurementSource` to the `estimate` table right after `pitchTierApplied`:

```ts
  pitchTierApplied: text("pitch_tier_applied"),
  // Slice 6d: the measurement source (ordered|uploaded_report|sketch) this estimate was
  // priced from — a pricing-inputs citation stamped at draft (estimate.lead_stage evidence).
  measurementSource: text("measurement_source"),
```

- [ ] **Step 4: Stamp it at draft time**

In `packages/db/src/lifecycle/estimate.ts`, `insertEstimateFromMeasurementTx` already loads `[m] = ...from(measurement)...`. Add `measurementSource` to the `estimate` insert `.values({...})` (place it after `pitchTierApplied`):

```ts
      wastePctUsed,
      pitchTierApplied,
      measurementSource: m.source ?? null,
```

- [ ] **Step 5: Generate the migration and add the backfill**

Run: `pnpm db:generate`
Expected: creates `packages/db/drizzle/0067_*.sql` with `ALTER TABLE "estimate" ADD COLUMN "measurement_source" text;`. Confirm it touches only `estimate`.

Hand-append the backfill (existing lead estimates cite their measurement's source):
```sql
--> statement-breakpoint
UPDATE "estimate" SET "measurement_source" = "measurement"."source"
  FROM "measurement" WHERE "estimate"."measurement_id" = "measurement"."id" AND "estimate"."measurement_source" IS NULL;
```

Run: `pnpm db:migrate`
Expected: 0067 applied cleanly.

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm --filter @savvy/db exec vitest run tests/estimate-measurement-source.test.ts`
Expected: PASS.

Regression (the estimate draft path must stay green):
Run: `pnpm --filter @savvy/db exec vitest run tests/draft-lead-estimate.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck**

Run: `pnpm --filter @savvy/db typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add packages/db/src/schema/finance.ts packages/db/drizzle/ packages/db/src/lifecycle/estimate.ts packages/db/tests/estimate-measurement-source.test.ts
git commit -m "feat(db): estimate.measurement_source (0067) stamped at draft + backfilled (slice 6d)"
```

---

### Task 2: `lead.doc_parse` + `estimate.lead_stage` invariants

**Files:**
- Modify: `packages/core/src/verification/checks.ts` (add two entries to `evidenceChecks`)
- Create: `packages/db/tests/lead-doc-evidence.test.ts`

**Interfaces:**
- Consumes: the `invariant` builder (existing); `document.parse_status` (6a); `estimate.measurement_source` (Task 1).
- Produces: `evidenceChecks["lead.doc_parse"]` and `evidenceChecks["estimate.lead_stage"]`.

- [ ] **Step 1: Write the failing test**

Create `packages/db/tests/lead-doc-evidence.test.ts` (mirrors the clean/bad harness in `verification-checks.test.ts`):

```ts
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { evidenceChecks } from "@savvy/core";
import type { EvidenceCtx } from "@savvy/core";
import { adminDb, adminPool } from "../src/admin-client.js";
import { tenant, customer, property, lead, document, estimate, measurement } from "../src/schema/index.js";

let cleanId: string;
let badId: string;
const WINDOW = { start: new Date(Date.now() - 86_400_000), end: new Date(Date.now() + 86_400_000) };
const HOURS = (n: number) => new Date(Date.now() - n * 3_600_000);
const run = (checkKey: string, tenantId: string) => {
  const ctx: EvidenceCtx = { tenantId, db: adminPool, params: {}, window: WINDOW };
  return evidenceChecks[checkKey]!(ctx);
};

async function mkLead(tid: string) {
  const [c] = await adminDb.insert(customer).values({ tenantId: tid, name: "c" }).returning();
  const [p] = await adminDb.insert(property).values({ tenantId: tid, customerId: c!.id, address: `a-${crypto.randomUUID()}` }).returning();
  const [l] = await adminDb.insert(lead).values({ tenantId: tid, customerId: c!.id, propertyId: p!.id, source: "test", status: "new" }).returning();
  return { customerId: c!.id, propertyId: p!.id, leadId: l!.id };
}

beforeAll(async () => {
  const [a] = await adminDb.insert(tenant).values({ name: "DP-clean", publicKey: `dp-clean-${Date.now()}`, clerkOrgId: `org_dp_clean_${Date.now()}` }).returning();
  const [b] = await adminDb.insert(tenant).values({ name: "DP-bad", publicKey: `dp-bad-${Date.now()}`, clerkOrgId: `org_dp_bad_${Date.now()}` }).returning();
  cleanId = a!.id; badId = b!.id;

  // --- lead.doc_parse ---
  // CLEAN: an old typed doc that reached a terminal state (parsed), plus a recent still-pending one (<1h, OK).
  const cl = await mkLead(cleanId);
  await adminDb.insert(document).values([
    { tenantId: cleanId, leadId: cl.leadId, propertyId: cl.propertyId, kind: "measurement_report", parseStatus: "parsed", createdAt: HOURS(2) },
    { tenantId: cleanId, leadId: cl.leadId, propertyId: cl.propertyId, kind: "insurance_estimate", parseStatus: "unparsed_low_confidence", createdAt: HOURS(3) },
    { tenantId: cleanId, leadId: cl.leadId, propertyId: cl.propertyId, kind: "insurance_estimate", parseStatus: "pending", createdAt: new Date() },
  ]);
  // BAD: an old (>1h) typed doc stuck in pending.
  const bl = await mkLead(badId);
  await adminDb.insert(document).values({ tenantId: badId, leadId: bl.leadId, propertyId: bl.propertyId, kind: "insurance_estimate", parseStatus: "pending", createdAt: HOURS(2) });

  // --- estimate.lead_stage ---
  // CLEAN: a lead estimate that cites its measurement source.
  const cl2 = await mkLead(cleanId);
  const [cm] = await adminDb.insert(measurement).values({ tenantId: cleanId, propertyId: cl2.propertyId, provider: "roofr", source: "ordered", areas: {} }).returning();
  await adminDb.insert(estimate).values({ tenantId: cleanId, leadId: cl2.leadId, propertyId: cl2.propertyId, measurementId: cm!.id, measurementSource: "ordered" });
  // BAD: a lead estimate with a measurement but NO cited source.
  const bl2 = await mkLead(badId);
  const [bm] = await adminDb.insert(measurement).values({ tenantId: badId, propertyId: bl2.propertyId, provider: "roofr", source: "ordered", areas: {} }).returning();
  await adminDb.insert(estimate).values({ tenantId: badId, leadId: bl2.leadId, propertyId: bl2.propertyId, measurementId: bm!.id, measurementSource: null });
});

afterAll(async () => {
  for (const tid of [cleanId, badId]) {
    await adminDb.delete(estimate).where(eq(estimate.tenantId, tid));
    await adminDb.delete(document).where(eq(document.tenantId, tid));
    await adminDb.delete(measurement).where(eq(measurement.tenantId, tid));
    await adminDb.delete(lead).where(eq(lead.tenantId, tid));
    await adminDb.delete(property).where(eq(property.tenantId, tid));
    await adminDb.delete(customer).where(eq(customer.tenantId, tid));
    await adminDb.delete(tenant).where(eq(tenant.id, tid));
  }
  await adminPool.end();
});

describe("lead-doc evidence invariants (real DB, green + red)", () => {
  for (const key of ["lead.doc_parse", "estimate.lead_stage"]) {
    it(`${key}: passes on the clean tenant`, async () => {
      const r = await run(key, cleanId);
      expect(r.status).toBe("pass");
      expect(r.refs).toEqual([]);
    });
    it(`${key}: fails and cites refs on the violating tenant`, async () => {
      const r = await run(key, badId);
      expect(r.status).toBe("fail");
      expect(r.refs.length).toBeGreaterThanOrEqual(1);
    });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @savvy/db exec vitest run tests/lead-doc-evidence.test.ts`
Expected: FAIL — `evidenceChecks["lead.doc_parse"]` is undefined (cannot read `!(ctx)` of undefined).

- [ ] **Step 3: Add the two invariants**

In `packages/core/src/verification/checks.ts`, add two entries to the `evidenceChecks` object (place them after `lead.score`, following the same `invariant(...)` style):

```ts
  // Every typed lead document reaches a terminal parse state within 1h. `pending` past
  // 1h is a stall; `parse_failed`/`unparsed_low_confidence` are valid *carded* states.
  "lead.doc_parse": invariant(
    "lead.doc_parse",
    `select id
       from document
      where tenant_id = $1
        and kind in ('insurance_estimate', 'measurement_report')
        and created_at < now() - interval '1 hour'
        and parse_status = 'pending'`,
    { toRef: (r) => ({ type: "document", ref: String(r.id) }) },
  ),

  // Every lead-stage estimate cites the measurement source it was priced from
  // (ordered|uploaded_report|sketch). A drafted estimate stamps it; a null here means
  // the pricing-inputs citation is missing.
  "estimate.lead_stage": invariant(
    "estimate.lead_stage",
    `select id
       from estimate
      where tenant_id = $1
        and lead_id is not null
        and measurement_id is not null
        and measurement_source is null`,
    { toRef: (r) => ({ type: "estimate", ref: String(r.id) }) },
  ),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @savvy/db exec vitest run tests/lead-doc-evidence.test.ts`
Expected: PASS (4 — both checks pass-on-clean and fail-on-bad).

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @savvy/core typecheck && pnpm --filter @savvy/db typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/verification/checks.ts packages/db/tests/lead-doc-evidence.test.ts
git commit -m "feat(core): lead.doc_parse + estimate.lead_stage evidence invariants (slice 6d)"
```

---

### Task 3: Bind the checks into the registry

**Files:**
- Modify: `packages/db/seeds/master-task-list.ts` (`CHECK_BINDINGS`)
- Modify: `packages/db/tests/master-task-list.test.ts` (the bound-set assertion)

**Interfaces:**
- Consumes: `evidenceChecks["lead.doc_parse"]`, `evidenceChecks["estimate.lead_stage"]` (Task 2).
- Produces: `CHECK_BINDINGS` binds `49 → "lead.doc_parse"` and `52 → "estimate.lead_stage"`; the health sweep now evaluates both.

- [ ] **Step 1: Add the bindings**

In `packages/db/seeds/master-task-list.ts`, add two entries to `CHECK_BINDINGS` (keep the object key-sorted-ish alongside the neighbors):

```ts
  44: "compliance.contract_template", // Contract / authorization signing — SB38 template-version invariant (cell 17b)
  49: "lead.doc_parse", // Measurement report review & import — typed lead doc parsed-or-carded < 1h (slice 6d)
  52: "estimate.lead_stage", // Xactimate estimate creation — lead estimate cites its measurement source (slice 6d)
  76: "claim.endorsement_no_idle", // Mortgage company endorsement tracking — 5-business-day no-idle (cell 16)
```

- [ ] **Step 2: Update the bound-set assertion**

In `packages/db/tests/master-task-list.test.ts`, the test "binds evidence check_keys to their 1:1 master task ids" hard-codes the exact bound id array. Update it to include `49` and `52` (kept sorted):

```ts
    expect(bound).toEqual([18, 19, 24, 32, 44, 49, 52, 76, 133, 139, 141, 150, 151, 213, 214]);
```

- [ ] **Step 3: Run tests to verify they pass**

Run: `pnpm --filter @savvy/db exec vitest run tests/master-task-list.test.ts`
Expected: PASS — the bound-set assertion matches, and the "every bound check_key resolves to a real evidence check (no orphan bindings)" test passes because Task 2 added both checks to `evidenceChecks`.

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @savvy/db typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/db/seeds/master-task-list.ts packages/db/tests/master-task-list.test.ts
git commit -m "feat(db): bind lead.doc_parse (task 49) + estimate.lead_stage (task 52) into the health-sweep registry (slice 6d)"
```

---

## Definition of Done (Slice 6d)

- [ ] `estimate.measurement_source` (0067) stamped at draft from the priced measurement's source; existing lead estimates backfilled.
- [ ] `lead.doc_parse` invariant: a typed lead document older than 1h still `pending` is a violation; `parse_failed`/`unparsed_low_confidence` are valid carded states (pass).
- [ ] `estimate.lead_stage` invariant: a lead-scoped estimate with a measurement but no cited `measurement_source` is a violation.
- [ ] Both checks bound in `CHECK_BINDINGS` (49, 52); the master-task-list bound-set + no-orphan tests pass; the health sweep evaluates both.
- [ ] `@savvy/core`/`@savvy/db` typecheck + lint clean; all new tests + `draft-lead-estimate`/`master-task-list` regressions green.

## Self-Review notes (coverage vs the 6d spec)

- **`lead.doc_parse` — typed uploads reach parsed-or-carded < 1h (bound)**: Tasks 2 + 3. ✅ (Because 6c made `insurance_estimate` reach a terminal status, this won't false-positive on insurance uploads.)
- **`estimate.lead_stage` — estimates cite their measurement source in the pricing-inputs snapshot (bound)**: Tasks 1 (stamp) + 2 (invariant) + 3 (bind). ✅
- **Parsed values never overwrite inspection-confirmed data**: unchanged — 6d only reads/adds a citation column, never mutates confirmed measurement/claim fields. ✅
- **Deferred / out of scope (YAGNI):** `sla_hours` on the registry rows (the 1h threshold is enforced inside the invariant SQL; the exception-aging escalation `sla_hours` is a separate, unrequested mechanism). The scope-vs-inspection comparison + supplement drafting (SuppIQ add-on) that consume `claim.line_items`. Surfacing a Today exception card for `lead.doc_parse` violations (the sweep already records `verification_run` refs; a dedicated card is future operator-console work).

**Not covered by an automated test (documented):** the end-to-end health-sweep run that evaluates the newly-bound checks per tenant is exercised only indirectly (the checks are unit-tested green/red via the `run()` harness, and the binding is tested via `master-task-list.test`); the sweep wiring itself is unchanged and already covered by `health-sweep.test.ts`.
