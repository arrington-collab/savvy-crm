# Slice 6c — Insurance-Estimate Parse + Claim Rescope — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Parse an uploaded insurance-estimate PDF into the claim money ledger (carrier, claim #, ACV/RCV/deductible, line items), rescoping `claim` to the lead so a claim can exist before a job — attaching to the lead's claim or creating a lead-scoped shell.

**Architecture:** Rescopes `claim` from job-only (job_id NOT NULL, UNIQUE) to lead-capable (adds lead_id/property_id, job_id nullable, partial-unique on job_id, adds line_items + parse_confidence), mirroring how Slice 1 rescoped estimate/appointment. Extends the existing `parseLeadDocument` handler (6b) with an `insurance_estimate` branch that parses via the AI gateway and calls a new `attachOrCreateLeadClaim` helper; the lead-scoped claim carries onto the job at `convertLeadToJob` (extending 6a's carryover). This also **resolves the 6b forward-seam**: `insurance_estimate` uploads now reach a terminal `parse_status` instead of sitting `pending`.

**Tech Stack:** TypeScript, Drizzle/Postgres (RLS), Inngest, `@savvy/ai` gateway (Claude via capability `reasoning`), Zod (`z` from `@savvy/core`), Cloudflare R2, Vitest. pnpm + Turborepo.

## Global Constraints

- **Branch:** create `slice6c-insurance-parse` off `slice6b-measurement-parse` (stacked; 6c builds on 6b). All work commits there.
- **Tenant isolation:** every DB op via `withTenant` (or `adminDb` for fixtures). New queries must not bypass RLS.
- **AI via the gateway by capability** — `completeObject({ capability: "reasoning", ... })`. NEVER hard-code a model string.
- **Parse handler stays fail-soft** — never throws out of the parse step (catch → parse_failed).
- **Money is integer cents** (ACV/RCV/deductible/line amounts).
- **Parsed values NEVER overwrite existing (human-confirmed) claim fields** — on attach, keep an existing non-null carrier/claim#/ACV/RCV/deductible; only line_items + parse_confidence are always (re)written by the parse.
- **Every task ships tests + passes `pnpm typecheck` + `pnpm lint` before commit.**
- **ESM `.js` import extensions in `@savvy/db` tests**; agents tests are co-located in `src/functions/` and import the module under test with a relative `./` path.
- **Local dev Postgres** is up and migrated through 0064; run `pnpm db:migrate` after generating 0065. If migrate errors on drift, STOP and report (do not `db:reset` without asking).
- **Claim status enum values:** `filed | adjuster_scheduled | approved | partial | denied | closed`. A parsed shell defaults to `filed`.
- **Migration numbering:** next after 6b's 0064 → **0065**.

---

### Task 1: Rescope `claim` to the lead (migration 0065) + fix `upsertClaim` on-conflict

**Files:**
- Modify: `packages/db/src/schema/insurance.ts` (the `claim` table)
- Create (generated + hand-edited): `packages/db/drizzle/0065_*.sql` + `packages/db/drizzle/meta/*`
- Modify: `packages/db/src/lifecycle/claim.ts` (`upsertClaim` on-conflict targetWhere)
- Create: `packages/db/tests/claim-rescope.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `claim` gains `leadId`, `propertyId` (FK, nullable), `lineItems` (jsonb, nullable), `parseConfidence` (double, nullable); `jobId` becomes nullable; the `job_id` unique becomes partial (only when `job_id IS NOT NULL`).

- [ ] **Step 1: Write the failing test**

Create `packages/db/tests/claim-rescope.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { adminDb, claim, upsertClaim, eq, and } from "../src/index.js";
import { makeTenant, makeLeadWithProperty, makeJobWithCustomer } from "./helpers.js";

describe("claim rescope (lead-scoped)", () => {
  it("stores a lead-scoped claim with a null job_id", async () => {
    const { tenantId } = await makeTenant();
    const { leadId, propertyId } = await makeLeadWithProperty(tenantId);
    const [row] = await adminDb
      .insert(claim)
      .values({ tenantId, leadId, propertyId, carrierName: "State Farm", acvCents: 1000, lineItems: [{ description: "shingles", quantity: 1, amountCents: 500 }], parseConfidence: 0.9 })
      .returning();
    const [read] = await adminDb.select().from(claim).where(eq(claim.id, row!.id));
    expect(read!.jobId).toBeNull();
    expect(read!.leadId).toBe(leadId);
    expect(read!.propertyId).toBe(propertyId);
    expect(read!.carrierName).toBe("State Farm");
    expect(read!.parseConfidence).toBeCloseTo(0.9);
  });

  it("multiple lead-scoped claims (null job_id) coexist — partial unique only bites when job_id is set", async () => {
    const { tenantId } = await makeTenant();
    const a = await makeLeadWithProperty(tenantId);
    const b = await makeLeadWithProperty(tenantId);
    await adminDb.insert(claim).values({ tenantId, leadId: a.leadId, propertyId: a.propertyId });
    await expect(
      adminDb.insert(claim).values({ tenantId, leadId: b.leadId, propertyId: b.propertyId }),
    ).resolves.toBeDefined(); // two null-job_id claims do not collide
  });

  it("upsertClaim still upserts by job_id (job-stage path unchanged)", async () => {
    const { tenantId } = await makeTenant();
    const { jobId } = await makeJobWithCustomer(tenantId);
    await upsertClaim({ tenantId, jobId, carrierName: "Allstate" });
    await upsertClaim({ tenantId, jobId, claimNumber: "C-1" }); // update, not a 2nd row
    const rows = await adminDb.select().from(claim).where(and(eq(claim.tenantId, tenantId), eq(claim.jobId, jobId)));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.carrierName).toBe("Allstate");
    expect(rows[0]!.claimNumber).toBe("C-1");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @savvy/db exec vitest run tests/claim-rescope.test.ts`
Expected: FAIL — `null value in column "job_id" violates not-null constraint` (or TS errors on `leadId`/`lineItems`/`parseConfidence`).

- [ ] **Step 3: Edit the schema**

In `packages/db/src/schema/insurance.ts`:

Update the imports (add `jsonb`, `doublePrecision`, `sql`; add `lead`, `property`):
```ts
import { pgTable, uuid, text, integer, timestamp, index, uniqueIndex, jsonb, doublePrecision } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { idCol, createdAt, tenantIsolation } from "./_rls";
import { tenant } from "./tenancy";
import { job } from "./jobs";
import { lead, property } from "./crm";
import { claimStatusEnum } from "./enums";
```

Change `jobId` to nullable and add the four new columns (place `leadId`/`propertyId` right after `jobId`, and `lineItems`/`parseConfidence` before `createdAt`):
```ts
  jobId: uuid("job_id").references(() => job.id),
  leadId: uuid("lead_id").references(() => lead.id),
  propertyId: uuid("property_id").references(() => property.id),
```
```ts
  // Slice 6c: parsed carrier line items + parse confidence (lead-stage insurance-estimate parse).
  lineItems: jsonb("line_items").$type<unknown[]>(),
  parseConfidence: doublePrecision("parse_confidence"),
  createdAt: createdAt(),
```

Change the unique index to partial:
```ts
  uniqueIndex("claim_job_uniq").on(t.jobId).where(sql`${t.jobId} is not null`),
```

- [ ] **Step 4: Generate the migration and add the backfill**

Run: `pnpm db:generate`
Expected: creates `packages/db/drizzle/0065_*.sql` that drops the old `claim_job_uniq`, adds the four columns + 2 FK constraints, `ALTER COLUMN job_id DROP NOT NULL`, and creates the partial unique index. Confirm it touches ONLY `claim` — if it shows drops/alters on other tables, STOP and report DONE_WITH_CONCERNS with the file contents.

Then hand-append the backfill to the generated `0065_*.sql` (existing job claims get their lead/property from the job):
```sql
--> statement-breakpoint
UPDATE "claim" SET "lead_id" = "job"."lead_id", "property_id" = "job"."property_id"
  FROM "job" WHERE "claim"."job_id" = "job"."id" AND "claim"."lead_id" IS NULL;
```

Run: `pnpm db:migrate`
Expected: 0065 applied cleanly.

- [ ] **Step 5: Fix `upsertClaim`'s on-conflict for the now-partial unique index**

In `packages/db/src/lifecycle/claim.ts`, `upsertClaim` uses `onConflictDoUpdate({ target: claim.jobId, set })`. A partial unique index requires the predicate on the conflict target. Add `sql` to the drizzle-orm import in that file and set `targetWhere`:
```ts
    const [row] = await tx.insert(claim)
      .values({ tenantId, jobId, ...set })
      .onConflictDoUpdate({ target: claim.jobId, targetWhere: sql`${claim.jobId} is not null`, set })
      .returning();
```
(Ensure `import { ... , sql } from "drizzle-orm";` in `claim.ts`.)

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm --filter @savvy/db exec vitest run tests/claim-rescope.test.ts`
Expected: PASS (3).

Regression (Cell 16 endorsement + depreciation read claims by job_id — must stay green):
Run: `pnpm --filter @savvy/db exec vitest run tests/endorsement-check.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck**

Run: `pnpm --filter @savvy/db typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add packages/db/src/schema/insurance.ts packages/db/drizzle/ packages/db/src/lifecycle/claim.ts packages/db/tests/claim-rescope.test.ts
git commit -m "feat(db): rescope claim to lead (0065) — lead_id/property_id, nullable job_id, partial unique, line_items (slice 6c)"
```

---

### Task 2: Insurance-estimate parse schema (`@savvy/core`, pure)

**Files:**
- Create: `packages/core/src/insurance-estimate-parse.ts`
- Create: `packages/core/src/insurance-estimate-parse.test.ts`
- Modify: `packages/core/src/index.ts` (barrel export)

**Interfaces:**
- Consumes: `z` from `./schemas`.
- Produces:
  - `insuranceEstimateParseSchema` and `type InsuranceEstimateParse`
  - `type InsuranceEstimateLine` (`{ description; quantity; unit?; unitPriceCents; amountCents }`)
  - `INSURANCE_PARSE_MIN_CONFIDENCE = 0.8`

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/insurance-estimate-parse.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { insuranceEstimateParseSchema, INSURANCE_PARSE_MIN_CONFIDENCE } from "./insurance-estimate-parse";

describe("insuranceEstimateParseSchema", () => {
  it("parses a carrier estimate with money in cents and line items", () => {
    const out = insuranceEstimateParseSchema.parse({
      carrierName: "State Farm", claimNumber: "12-3456", acvCents: 800000, rcvCents: 1000000, deductibleCents: 200000,
      lines: [{ description: "Remove & replace shingles", quantity: 25, unit: "SQ", unitPriceCents: 30000, amountCents: 750000 }],
      confidence: 0.93,
    });
    expect(out.carrierName).toBe("State Farm");
    expect(out.rcvCents).toBe(1000000);
    expect(out.lines[0]!.amountCents).toBe(750000);
  });

  it("allows null money fields and an empty line list", () => {
    const out = insuranceEstimateParseSchema.parse({
      carrierName: null, claimNumber: null, acvCents: null, rcvCents: null, deductibleCents: null, lines: [], confidence: 0.5,
    });
    expect(out.acvCents).toBeNull();
    expect(out.lines).toEqual([]);
  });

  it("rejects confidence outside 0-1 and exposes a 0.8 threshold", () => {
    expect(() => insuranceEstimateParseSchema.parse({ carrierName: null, claimNumber: null, acvCents: null, rcvCents: null, deductibleCents: null, lines: [], confidence: 2 })).toThrow();
    expect(INSURANCE_PARSE_MIN_CONFIDENCE).toBe(0.8);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run packages/core/src/insurance-estimate-parse.test.ts`
Expected: FAIL — cannot resolve `./insurance-estimate-parse`.

- [ ] **Step 3: Write the schema**

Create `packages/core/src/insurance-estimate-parse.ts`:

```ts
import { z } from "./schemas";

/** Extraction schema for an uploaded carrier insurance estimate (Xactimate-style PDF). */
export const insuranceEstimateParseSchema = z.object({
  carrierName: z.string().nullable(),
  claimNumber: z.string().nullable(),
  acvCents: z.number().int().nullable(),
  rcvCents: z.number().int().nullable(),
  deductibleCents: z.number().int().nullable(),
  lines: z.array(z.object({
    description: z.string(),
    quantity: z.number(),
    unit: z.string().optional(),
    unitPriceCents: z.number().int().nullable(),
    amountCents: z.number().int(),
  })),
  confidence: z.number().min(0).max(1),
});
export type InsuranceEstimateParse = z.infer<typeof insuranceEstimateParseSchema>;
export type InsuranceEstimateLine = InsuranceEstimateParse["lines"][number];

/** Below this confidence, an insurance upload is carded ("stored, unparsed") rather than trusted. */
export const INSURANCE_PARSE_MIN_CONFIDENCE = 0.8;
```

Append to `packages/core/src/index.ts`:
```ts
export * from "./insurance-estimate-parse";
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run packages/core/src/insurance-estimate-parse.test.ts`
Expected: PASS (3).

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @savvy/core typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/insurance-estimate-parse.ts packages/core/src/insurance-estimate-parse.test.ts packages/core/src/index.ts
git commit -m "feat(core): insurance-estimate parse schema (slice 6c)"
```

---

### Task 3: `attachOrCreateLeadClaim` DB helper

**Files:**
- Modify: `packages/db/src/lifecycle/claim.ts` (add the helper)
- Modify: `packages/db/src/index.ts` (export it)
- Create: `packages/db/tests/attach-lead-claim.test.ts`

**Interfaces:**
- Consumes: `InsuranceEstimateLine` from `@savvy/core`; the `claim` schema (Task 1 columns).
- Produces:
  - `attachOrCreateLeadClaim(input: { tenantId: string; leadId: string; propertyId: string | null; carrierName: string | null; claimNumber: string | null; acvCents: number | null; rcvCents: number | null; deductibleCents: number | null; lineItems: InsuranceEstimateLine[]; parseConfidence: number }): Promise<{ claimId: string; created: boolean }>`
  - Attaches to the lead's existing claim (updates it) if one exists, else inserts a lead-scoped shell (`jobId` null, status `filed`). On attach, existing non-null carrier/claim#/ACV/RCV/deductible are PRESERVED (parsed value only fills a null); `lineItems` + `parseConfidence` are always written.

- [ ] **Step 1: Write the failing test**

Create `packages/db/tests/attach-lead-claim.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { attachOrCreateLeadClaim, adminDb, claim, eq } from "../src/index.js";
import { makeTenant, makeLeadWithProperty } from "./helpers.js";

const parsed = {
  carrierName: "State Farm", claimNumber: "C-9", acvCents: 800000, rcvCents: 1000000, deductibleCents: 200000,
  lineItems: [{ description: "shingles", quantity: 25, amountCents: 750000 }], parseConfidence: 0.9,
};

describe("attachOrCreateLeadClaim", () => {
  it("creates a lead-scoped claim shell when the lead has none", async () => {
    const { tenantId } = await makeTenant();
    const { leadId, propertyId } = await makeLeadWithProperty(tenantId);
    const res = await attachOrCreateLeadClaim({ tenantId, leadId, propertyId, ...parsed });
    expect(res.created).toBe(true);
    const [c] = await adminDb.select().from(claim).where(eq(claim.id, res.claimId));
    expect(c!.leadId).toBe(leadId);
    expect(c!.jobId).toBeNull();
    expect(c!.status).toBe("filed");
    expect(c!.rcvCents).toBe(1000000);
    expect((c!.lineItems as unknown[]).length).toBe(1);
  });

  it("attaches to an existing lead claim WITHOUT overwriting a human-confirmed field", async () => {
    const { tenantId } = await makeTenant();
    const { leadId, propertyId } = await makeLeadWithProperty(tenantId);
    // Human already set the carrier + left acv null.
    const [existing] = await adminDb.insert(claim).values({ tenantId, leadId, propertyId, carrierName: "Allstate (confirmed)" }).returning();

    const res = await attachOrCreateLeadClaim({ tenantId, leadId, propertyId, ...parsed });
    expect(res.created).toBe(false);
    expect(res.claimId).toBe(existing!.id);
    const [c] = await adminDb.select().from(claim).where(eq(claim.id, existing!.id));
    expect(c!.carrierName).toBe("Allstate (confirmed)"); // preserved, NOT overwritten by "State Farm"
    expect(c!.acvCents).toBe(800000);                    // filled (was null)
    expect(c!.parseConfidence).toBeCloseTo(0.9);         // always written
    expect((c!.lineItems as unknown[]).length).toBe(1);  // always written
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @savvy/db exec vitest run tests/attach-lead-claim.test.ts`
Expected: FAIL — `attachOrCreateLeadClaim is not a function`.

- [ ] **Step 3: Add the helper**

In `packages/db/src/lifecycle/claim.ts`, add the import for the line type and the helper (uses the existing `withTenant`, `claim`, `and`, `eq`; add `desc`, `isNull` to the drizzle-orm import if missing):

```ts
import type { InsuranceEstimateLine } from "@savvy/core";
```

```ts
/**
 * Attach a parsed carrier estimate to the lead's claim, or create a lead-scoped shell
 * (jobId null). Parsed money/carrier fields only FILL a null (never overwrite a
 * human-confirmed value); lineItems + parseConfidence are always written.
 */
export async function attachOrCreateLeadClaim(input: {
  tenantId: string;
  leadId: string;
  propertyId: string | null;
  carrierName: string | null;
  claimNumber: string | null;
  acvCents: number | null;
  rcvCents: number | null;
  deductibleCents: number | null;
  lineItems: InsuranceEstimateLine[];
  parseConfidence: number;
}): Promise<{ claimId: string; created: boolean }> {
  return withTenant(input.tenantId, async (tx) => {
    const [existing] = await tx
      .select()
      .from(claim)
      .where(and(eq(claim.tenantId, input.tenantId), eq(claim.leadId, input.leadId)))
      .orderBy(desc(claim.createdAt))
      .limit(1);

    if (existing) {
      await tx
        .update(claim)
        .set({
          carrierName: existing.carrierName ?? input.carrierName,
          claimNumber: existing.claimNumber ?? input.claimNumber,
          acvCents: existing.acvCents ?? input.acvCents,
          rcvCents: existing.rcvCents ?? input.rcvCents,
          deductibleCents: existing.deductibleCents ?? input.deductibleCents,
          lineItems: input.lineItems,
          parseConfidence: input.parseConfidence,
        })
        .where(eq(claim.id, existing.id));
      return { claimId: existing.id, created: false };
    }

    const [row] = await tx
      .insert(claim)
      .values({
        tenantId: input.tenantId,
        leadId: input.leadId,
        propertyId: input.propertyId,
        carrierName: input.carrierName,
        claimNumber: input.claimNumber,
        acvCents: input.acvCents,
        rcvCents: input.rcvCents,
        deductibleCents: input.deductibleCents,
        lineItems: input.lineItems,
        parseConfidence: input.parseConfidence,
      })
      .returning({ id: claim.id });
    return { claimId: row!.id, created: true };
  });
}
```

Add to `packages/db/src/index.ts` (next to the existing `upsertClaim` export from `./lifecycle/claim`):
```ts
export { attachOrCreateLeadClaim } from "./lifecycle/claim";
```
(If `upsertClaim`/`getClaimForJob` are already exported from `./lifecycle/claim` in one statement, add `attachOrCreateLeadClaim` to that same export list instead of a second line.)

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @savvy/db exec vitest run tests/attach-lead-claim.test.ts`
Expected: PASS (2).

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @savvy/db typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/lifecycle/claim.ts packages/db/src/index.ts packages/db/tests/attach-lead-claim.test.ts
git commit -m "feat(db): attachOrCreateLeadClaim — lead-scoped claim upsert with confirmed-field guard (slice 6c)"
```

---

### Task 4: Insurance branch in `parseLeadDocument` (handler + Inngest wiring)

Extends the 6b handler to dispatch by kind. Adds the `insurance_estimate` branch (parse → `attachOrCreateLeadClaim` → setStatus). This **resolves the 6b seam**: `insurance_estimate` uploads now reach a terminal `parse_status` instead of `skipped`-without-status. The measurement branch is unchanged.

**Files:**
- Modify: `packages/agents/src/functions/parse-lead-document.ts`
- Modify: `packages/agents/src/functions/parse-lead-document.test.ts` (add insurance cases)

**Interfaces:**
- Consumes: `insuranceEstimateParseSchema`, `INSURANCE_PARSE_MIN_CONFIDENCE`, `type InsuranceEstimateParse` from `@savvy/core`; `attachOrCreateLeadClaim` from `@savvy/db`.
- Produces: `ParseLeadDocumentDeps` gains `attachClaim: (input: { tenantId: string; leadId: string; propertyId: string | null; carrierName: string | null; claimNumber: string | null; acvCents: number | null; rcvCents: number | null; deductibleCents: number | null; lineItems: InsuranceEstimateParse["lines"]; parseConfidence: number }) => Promise<{ claimId: string; created: boolean }>`. Handler return type gains `claimId?: string`. Insurance parse returns `{ status: "parsed", claimId, leadId }` (no `measurementId`, so no `measurement/ready` emit).

- [ ] **Step 1: Add the failing insurance handler tests**

In `packages/agents/src/functions/parse-lead-document.test.ts`, extend `makeDeps` to include an `attachClaim` mock and add insurance cases. Add to the existing `makeDeps` return object:
```ts
    attachClaim: vi.fn().mockResolvedValue({ claimId: "c1", created: true }),
```
And add these test cases inside the `describe`:
```ts
  it("parses an insurance_estimate → attaches/creates a claim, sets parsed, returns claimId", async () => {
    const parsed = { carrierName: "State Farm", claimNumber: "C-9", acvCents: 800000, rcvCents: 1000000, deductibleCents: 200000, lines: [{ description: "shingles", quantity: 25, amountCents: 750000 }], confidence: 0.95 };
    const deps = makeDeps({
      loadDoc: vi.fn().mockResolvedValue({ r2Key: "k", kind: "insurance_estimate", leadId: "l1", propertyId: "p1" }),
      ai: { completeObject: vi.fn().mockResolvedValue({ object: parsed, model: "stub" }) },
    });
    const res = await parseLeadDocumentHandler({ tenantId: "t1", documentId: "d1" }, deps);
    expect(res).toEqual({ status: "parsed", claimId: "c1", leadId: "l1" });
    expect(deps.attachClaim).toHaveBeenCalledWith(expect.objectContaining({ leadId: "l1", rcvCents: 1000000, parseConfidence: 0.95 }));
    expect(deps.insertMeasurement).not.toHaveBeenCalled();
  });

  it("cards a low-confidence insurance parse without creating a claim", async () => {
    const parsed = { carrierName: null, claimNumber: null, acvCents: null, rcvCents: null, deductibleCents: null, lines: [], confidence: 0.3 };
    const deps = makeDeps({
      loadDoc: vi.fn().mockResolvedValue({ r2Key: "k", kind: "insurance_estimate", leadId: "l1", propertyId: "p1" }),
      ai: { completeObject: vi.fn().mockResolvedValue({ object: parsed, model: "stub" }) },
    });
    const res = await parseLeadDocumentHandler({ tenantId: "t1", documentId: "d1" }, deps);
    expect(res.status).toBe("unparsed_low_confidence");
    expect(deps.attachClaim).not.toHaveBeenCalled();
    expect(deps.setStatus).toHaveBeenCalledWith(expect.objectContaining({ status: "unparsed_low_confidence" }));
  });
```
Update the `ParseLeadDocumentDeps` type reference in the test's `makeDeps` signature (`Partial<ParseLeadDocumentDeps>`) — it already uses that, so once the type gains `attachClaim` the mock slots in.

- [ ] **Step 2: Run to verify the new cases fail**

Run: `pnpm --filter @savvy/agents exec vitest run src/functions/parse-lead-document.test.ts`
Expected: FAIL — insurance_estimate currently returns `{ status: "skipped" }` (no claimId), `attachClaim` never called.

- [ ] **Step 3: Extend the handler**

In `packages/agents/src/functions/parse-lead-document.ts`:

Add imports:
```ts
import { measurementReportParseSchema, MEASUREMENT_PARSE_MIN_CONFIDENCE, type MeasurementReportParse,
  insuranceEstimateParseSchema, INSURANCE_PARSE_MIN_CONFIDENCE, type InsuranceEstimateParse } from "@savvy/core";
```

Add the insurance prompt constants near the measurement ones:
```ts
const INSURANCE_SYSTEM =
  "You are a roofing insurance-claims analyst. Extract a carrier insurance estimate (Xactimate or similar) " +
  "into structured data. Report all money in integer cents. If a field is missing, use null. Confidence is " +
  "your 0-1 certainty the extraction faithfully reflects the document.";
const INSURANCE_PROMPT =
  "Extract this insurance estimate: carrier name, claim number, ACV/RCV/deductible in cents, and every line " +
  "item with its description, quantity, unit (if shown), unit price in cents, and line amount in cents.";
```

Add `attachClaim` to `ParseLeadDocumentDeps`:
```ts
  attachClaim: (input: { tenantId: string; leadId: string; propertyId: string | null; carrierName: string | null; claimNumber: string | null; acvCents: number | null; rcvCents: number | null; deductibleCents: number | null; lineItems: InsuranceEstimateParse["lines"]; parseConfidence: number }) => Promise<{ claimId: string; created: boolean }>;
```

Change the handler return type to add `claimId?`:
```ts
): Promise<{ status: "parsed" | "unparsed_low_confidence" | "parse_failed" | "skipped"; measurementId?: string; claimId?: string; leadId?: string | null; propertyId?: string | null }> {
```

Restructure the try body to dispatch by kind. Replace the current lines from `if (doc.kind !== "measurement_report") return { status: "skipped" };` down to the measurement `return { status: "parsed", measurementId, ... }` with:
```ts
    if (!doc.r2Key) throw new Error("lead document missing storage key");
    const bytes = await deps.fetchBytes(doc.r2Key);

    if (doc.kind === "measurement_report") {
      if (!doc.propertyId) throw new Error("measurement document missing property");
      const { object: parsed } = await deps.ai.completeObject<MeasurementReportParse>({
        capability: "reasoning", system: PARSE_SYSTEM, prompt: PARSE_PROMPT,
        schema: measurementReportParseSchema as unknown as Parameters<typeof deps.ai.completeObject<MeasurementReportParse>>[0]["schema"],
        file: { bytes, mediaType: "application/pdf" },
      });
      if (parsed.confidence < MEASUREMENT_PARSE_MIN_CONFIDENCE) {
        await deps.setStatus({ tenantId, documentId, status: "unparsed_low_confidence", confidence: parsed.confidence });
        return { status: "unparsed_low_confidence" };
      }
      const { confidence, ...areas } = parsed;
      const measurementId = await deps.insertMeasurement({ tenantId, propertyId: doc.propertyId, areas, pitch: areas.predominantPitch });
      await deps.setStatus({ tenantId, documentId, status: "parsed", confidence });
      return { status: "parsed", measurementId, leadId: doc.leadId, propertyId: doc.propertyId };
    }

    if (doc.kind === "insurance_estimate") {
      if (!doc.leadId) throw new Error("insurance document missing lead");
      const { object: parsed } = await deps.ai.completeObject<InsuranceEstimateParse>({
        capability: "reasoning", system: INSURANCE_SYSTEM, prompt: INSURANCE_PROMPT,
        schema: insuranceEstimateParseSchema as unknown as Parameters<typeof deps.ai.completeObject<InsuranceEstimateParse>>[0]["schema"],
        file: { bytes, mediaType: "application/pdf" },
      });
      if (parsed.confidence < INSURANCE_PARSE_MIN_CONFIDENCE) {
        await deps.setStatus({ tenantId, documentId, status: "unparsed_low_confidence", confidence: parsed.confidence });
        return { status: "unparsed_low_confidence" };
      }
      const { claimId } = await deps.attachClaim({
        tenantId, leadId: doc.leadId, propertyId: doc.propertyId,
        carrierName: parsed.carrierName, claimNumber: parsed.claimNumber,
        acvCents: parsed.acvCents, rcvCents: parsed.rcvCents, deductibleCents: parsed.deductibleCents,
        lineItems: parsed.lines, parseConfidence: parsed.confidence,
      });
      await deps.setStatus({ tenantId, documentId, status: "parsed", confidence: parsed.confidence });
      return { status: "parsed", claimId, leadId: doc.leadId };
    }

    return { status: "skipped" };
```
(Keep the `catch` block unchanged — it already sets `parse_failed` fail-soft. The old measurement-only PARSE_SYSTEM/PARSE_PROMPT consts stay as-is and are reused by the measurement branch.)

- [ ] **Step 4: Wire the real `attachClaim` dep in the Inngest function**

In the same file, in the `parseLeadDocument` Inngest function's deps object (alongside `insertMeasurement`, `setStatus`), add:
```ts
          attachClaim: (i) => attachOrCreateLeadClaim(i),
```
And add `attachOrCreateLeadClaim` to the `@savvy/db` import at the top:
```ts
import { getLeadDocumentForParse, insertUploadedMeasurement, setDocumentParseStatus, attachOrCreateLeadClaim } from "@savvy/db";
```
(The `measurement/ready` emit block is unchanged — it only fires on `status === "parsed" && result.measurementId`, so an insurance parse (no measurementId) correctly emits nothing.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @savvy/agents exec vitest run src/functions/parse-lead-document.test.ts`
Expected: PASS (all cases — the original 4 measurement cases + the 2 new insurance cases).

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @savvy/agents typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/agents/src/functions/parse-lead-document.ts packages/agents/src/functions/parse-lead-document.test.ts
git commit -m "feat(agents): parse insurance_estimate into the lead claim (resolves 6b pending seam) (slice 6c)"
```

---

### Task 5: Carry the lead's claim onto the job at conversion

**Files:**
- Modify: `packages/db/src/lifecycle/appointments.ts` (the `stampCerts` helper in `convertLeadToJob`)
- Create: `packages/db/tests/claim-carryover.test.ts`

**Interfaces:**
- Consumes: `attachOrCreateLeadClaim` (Task 3) or a direct insert for the test fixture; `convertLeadToJob` (existing).
- Produces: `convertLeadToJob` now also stamps `job_id` onto the lead's lead-scoped claim (`job_id IS NULL` guard → idempotent).

- [ ] **Step 1: Write the failing test**

Create `packages/db/tests/claim-carryover.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { attachOrCreateLeadClaim } from "../src/lifecycle/claim.js";
import { convertLeadToJob } from "../src/lifecycle/appointments.js";
import { adminDb, claim, eq } from "../src/index.js";
import { makeTenant, makeLeadWithProperty } from "./helpers.js";

describe("convertLeadToJob — claim carryover", () => {
  it("stamps job_id onto the lead's claim at conversion", async () => {
    const { tenantId } = await makeTenant();
    const { leadId, propertyId } = await makeLeadWithProperty(tenantId);
    const c = await attachOrCreateLeadClaim({
      tenantId, leadId, propertyId, carrierName: "State Farm", claimNumber: "C-1",
      acvCents: 1000, rcvCents: 2000, deductibleCents: 500, lineItems: [], parseConfidence: 0.9,
    });

    const { jobId } = await convertLeadToJob({ tenantId, leadId, manualJob: true });

    const [row] = await adminDb.select().from(claim).where(eq(claim.id, c.claimId));
    expect(row!.jobId).toBe(jobId);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @savvy/db exec vitest run tests/claim-carryover.test.ts`
Expected: FAIL — `row.jobId` is `null` (claim carryover not yet wired).

- [ ] **Step 3: Extend `stampCerts`**

In `packages/db/src/lifecycle/appointments.ts`, add `claim` to the imports (it currently imports `document` from `../schema/ops`; add `claim` from `../schema/insurance`):
```ts
import { claim } from "../schema/insurance";
```
Inside the `stampCerts` helper (after the two existing `document` updates), add the claim stamp:
```ts
      // Slice 6c: carry the lead's lead-scoped claim onto the job. Idempotent via the
      // jobId IS NULL guard; the partial-unique on (job_id) is safe (a fresh job has no claim).
      await tx
        .update(claim)
        .set({ jobId })
        .where(and(eq(claim.leadId, l!.id), isNull(claim.jobId)));
```
(`and`, `eq`, `isNull` are already imported in this file.)

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @savvy/db exec vitest run tests/claim-carryover.test.ts`
Expected: PASS (1).

- [ ] **Step 5: Regression**

Run: `pnpm --filter @savvy/db exec vitest run tests/appointments.test.ts tests/lead-document-carryover.test.ts`
Expected: PASS (the stampCerts change must not break document carryover or conversion).

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @savvy/db typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/db/src/lifecycle/appointments.ts packages/db/tests/claim-carryover.test.ts
git commit -m "feat(db): carry the lead's claim onto the job at conversion (slice 6c)"
```

---

## Definition of Done (Slice 6c)

- [ ] `claim` rescoped to lead (0065): lead_id/property_id, nullable job_id, partial unique, line_items + parse_confidence; existing job claims backfilled; `upsertClaim` still upserts by job_id.
- [ ] `insuranceEstimateParseSchema` + `INSURANCE_PARSE_MIN_CONFIDENCE`.
- [ ] `attachOrCreateLeadClaim` attaches to / creates a lead claim, preserving human-confirmed fields, always writing line_items + confidence.
- [ ] `parseLeadDocument` parses `insurance_estimate` into the lead claim (fail-soft: low-confidence cards, errors → parse_failed) — and `insurance_estimate` no longer sits `pending` (6b seam resolved).
- [ ] The lead's claim carries onto the job at `convertLeadToJob`.
- [ ] `@savvy/core`/`@savvy/db`/`@savvy/agents` typecheck + lint clean; all new tests + `endorsement-check`/`appointments`/`lead-document-carryover` regressions green.

## Self-Review notes (coverage vs the 6c spec)

- **Rescope `claim` to lead (lead_id/property_id, nullable job_id, partial unique)**: Task 1. ✅
- **`claim.line_items` jsonb**: Task 1 (column) + Task 2 (line type) + Task 3 (written). ✅
- **Parse carrier/claim#/ACV/RCV/deductible + line items**: Tasks 2 + 4. ✅
- **Attach to existing claim or create lead-scoped shell**: Task 3. ✅
- **Parsed values never overwrite inspection-confirmed data**: Task 3 (per-field `existing ?? parsed` guard). ✅
- **Carryover to job at conversion**: Task 5. ✅
- **Resolve the 6b `insurance_estimate` pending seam**: Task 4 (terminal status set). ✅
- **Deferred to later phases:** the scope-vs-inspection comparison + supplement drafting that consume `claim.line_items` (SuppIQ add-on); 6d evidence checks (`lead.doc_parse` now covers insurance uploads too, since they reach a terminal status; `estimate.lead_stage`).

**Not covered by an automated test (documented):** the live R2→AI round-trip for insurance parsing is exercised only via the pure handler tests + the proven Inngest wiring (shared with the measurement path); verify manually with `pnpm dev` (upload a carrier estimate PDF on a lead → the doc shows "Parsed" and a lead-scoped claim carries ACV/RCV/deductible + line items).
