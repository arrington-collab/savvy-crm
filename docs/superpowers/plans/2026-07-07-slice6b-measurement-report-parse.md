# Slice 6b — Measurement-Report Parse + Source Precedence — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Parse an uploaded measurement-report PDF into a `measurement` row (`source='uploaded_report'`) that suppresses the Roofr auto-order and feeds Slice 1's estimate auto-draft, with a source-precedence selector (ordered > uploaded_report > sketch) replacing "newest wins."

**Architecture:** Adds a `source` column to `measurement` (backfilled), a pure `selectPreferredMeasurement` ranker in `@savvy/core`, and a fail-soft `parseLeadDocument` Inngest pipeline (mirroring the supplier-invoice parser: injected-deps handler + Claude-`reasoning` on PDF bytes + Zod schema). The 6a `recordLeadDocumentAction` starts emitting `lead-document/received`; the parser inserts an `uploaded_report` measurement and emits `measurement/ready`, which the existing `generateEstimateOnMeasurement` already consumes. Auto-order suppression is automatic — the existing `shouldAutoOrderMeasurement` gate already short-circuits when the property has any measurement.

**Tech Stack:** TypeScript, Drizzle/Postgres (RLS), Inngest, `@savvy/ai` gateway (LiteLLM → Claude via capability `reasoning`), Zod (`z` re-exported from `@savvy/core`), Cloudflare R2, Vitest. pnpm + Turborepo.

## Global Constraints

- **Branch:** create `slice6b-measurement-parse` off `slice6-lead-documents` (stacked; 6b builds on 6a). All work commits there.
- **Tenant isolation:** every DB op via `withTenant` (or `adminDb` for fixtures/tenant-settings reads). New queries must not bypass RLS.
- **AI via the gateway by capability** — `completeObject({ capability: "reasoning", ... })`. NEVER hard-code a model string.
- **Async/multi-step is an Inngest workflow** with fail-soft handlers (never throw out of the parse step).
- **Every task ships tests + passes `pnpm typecheck` + `pnpm lint` before commit.**
- **ESM `.js` import extensions in `@savvy/db` tests** (`from "../src/index.js"`).
- **Local dev Postgres** is up and migrated through 0063; run `pnpm db:migrate` after generating 0064. If migrate errors on drift, STOP and report (do not `db:reset` without asking — it wipes shared local data).
- **Measurement `source` values (exact):** `ordered` | `uploaded_report` | `sketch`. Free-text column (mirrors `provider`), not a pg enum.
- **Precedence (exact):** rank `ordered`(3) > `uploaded_report`(2) > `sketch`(1) > unknown/null(0); tie-break `createdAt` desc.
- **Parsed values never overwrite inspection-confirmed data** (standard precedence; 6b only inserts new measurement rows, never mutates confirmed fields).
- **Migration numbering:** next after 6a's 0063 → **0064**.

---

### Task 1: `measurement.source` column (migration 0064) + stamp source at existing insert sites

**Files:**
- Modify: `packages/db/src/schema/ops.ts` (the `measurement` table, ~lines 40-51)
- Create (generated + hand-edited): `packages/db/drizzle/0064_*.sql` + `packages/db/drizzle/meta/*`
- Modify: `packages/agents/src/functions/roofr-order.ts` (2 measurement inserts → `source: "ordered"`)
- Modify: `apps/web/src/lib/measurement-actions.ts` (DIY insert + update → `source: "sketch"`)
- Create: `packages/db/tests/measurement-source.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `measurement` table gains `source` (text, nullable). Roofr inserts stamp `"ordered"`; DIY sketch inserts stamp `"sketch"`.

- [ ] **Step 1: Write the failing test**

Create `packages/db/tests/measurement-source.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { adminDb, measurement, eq } from "../src/index.js";
import { makeTenant, makeLeadWithProperty } from "./helpers.js";

describe("measurement.source column", () => {
  it("stores an explicit source value and round-trips it", async () => {
    const { tenantId } = await makeTenant();
    const { propertyId } = await makeLeadWithProperty(tenantId);
    const [row] = await adminDb
      .insert(measurement)
      .values({ tenantId, propertyId, provider: "roofr", source: "uploaded_report", areas: {} })
      .returning();
    const [read] = await adminDb.select().from(measurement).where(eq(measurement.id, row!.id));
    expect(read!.source).toBe("uploaded_report");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @savvy/db exec vitest run tests/measurement-source.test.ts`
Expected: FAIL — `column "source" of relation "measurement" does not exist` (or a TS error on `source`).

- [ ] **Step 3: Edit the schema**

In `packages/db/src/schema/ops.ts`, add `source` to the `measurement` table right after the `provider` line:

```ts
  provider: text("provider").default("roofr"),   // "roofr" | "diy"
  source: text("source"), // ordered|uploaded_report|sketch (orthogonal to provider; 6b)
```

- [ ] **Step 4: Generate the migration and add the backfill**

Run: `pnpm db:generate`
Expected: creates `packages/db/drizzle/0064_*.sql` with a single `ALTER TABLE "measurement" ADD COLUMN "source" text;`.

Then hand-append the backfill to that generated `0064_*.sql` file (existing rows must get a source so the precedence selector can rank them):

```sql
--> statement-breakpoint
UPDATE "measurement" SET "source" = 'ordered' WHERE "provider" = 'roofr' AND "source" IS NULL;--> statement-breakpoint
UPDATE "measurement" SET "source" = 'sketch' WHERE "provider" = 'diy' AND "source" IS NULL;
```

Run: `pnpm db:migrate`
Expected: 0064 applied cleanly.

- [ ] **Step 5: Stamp source at the existing insert sites**

In `packages/agents/src/functions/roofr-order.ts`, BOTH measurement inserts (in `orderAndPersistMeasurement` ~line 34 and in the `roofrOrderMeasurement` Inngest fn ~line 78) add `source: "ordered"`:

```ts
        const [m] = await tx.insert(measurement).values({
          tenantId,
          propertyId,
          provider: "roofr",
          source: "ordered",
          reportUrl: report.reportUrl,
          areas: report.areas,
          pitch: report.areas.predominantPitch,
          costCents: report.costCents,
        }).returning();
```

In `apps/web/src/lib/measurement-actions.ts`, the DIY paths: the `.set({ ..., provider: "diy" })` update (~line 44) and the `.insert(measurement).values({ ..., provider: "diy" })` (~line 50) both add `source: "sketch"`:

```ts
// in the update:
        .set({ areas, pitch: summary.predominantPitch, provider: "diy", source: "sketch" })
// in the insert values:
        provider: "diy",
        source: "sketch",
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm --filter @savvy/db exec vitest run tests/measurement-source.test.ts`
Expected: PASS.

Regression (the insert-site edits must not break existing measurement/estimate flows):
Run: `pnpm --filter @savvy/db exec vitest run tests/draft-lead-estimate.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck**

Run: `pnpm --filter @savvy/db typecheck && pnpm --filter @savvy/agents typecheck && pnpm --filter web typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add packages/db/src/schema/ops.ts packages/db/drizzle/ packages/agents/src/functions/roofr-order.ts apps/web/src/lib/measurement-actions.ts packages/db/tests/measurement-source.test.ts
git commit -m "feat(db): measurement.source column (0064, backfilled) + stamp ordered/sketch at insert sites (slice 6b)"
```

---

### Task 2: `selectPreferredMeasurement` precedence ranker (`@savvy/core`, pure)

**Files:**
- Create: `packages/core/src/measurement-precedence.ts`
- Create: `packages/core/src/measurement-precedence.test.ts`
- Modify: `packages/core/src/index.ts` (barrel export)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type MeasurementSource = "ordered" | "uploaded_report" | "sketch"`
  - `MEASUREMENT_SOURCE_RANK: Record<string, number>` (ordered 3 / uploaded_report 2 / sketch 1)
  - `selectPreferredMeasurement<T extends { source: string | null; createdAt: Date }>(rows: T[]): T | null` — highest source rank, tie-broken by newest `createdAt`; returns null for an empty list.

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/measurement-precedence.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { selectPreferredMeasurement } from "./measurement-precedence";

const d = (ms: number) => new Date(1_700_000_000_000 + ms);

describe("selectPreferredMeasurement", () => {
  it("returns null for an empty list", () => {
    expect(selectPreferredMeasurement([])).toBeNull();
  });

  it("prefers ordered over uploaded_report over sketch", () => {
    const rows = [
      { id: "sk", source: "sketch", createdAt: d(300) },
      { id: "up", source: "uploaded_report", createdAt: d(200) },
      { id: "or", source: "ordered", createdAt: d(100) },
    ];
    expect(selectPreferredMeasurement(rows)!.id).toBe("or");
  });

  it("uploaded_report beats a newer sketch", () => {
    const rows = [
      { id: "sk", source: "sketch", createdAt: d(999) },
      { id: "up", source: "uploaded_report", createdAt: d(1) },
    ];
    expect(selectPreferredMeasurement(rows)!.id).toBe("up");
  });

  it("within the same source, newest wins", () => {
    const rows = [
      { id: "old", source: "uploaded_report", createdAt: d(100) },
      { id: "new", source: "uploaded_report", createdAt: d(500) },
    ];
    expect(selectPreferredMeasurement(rows)!.id).toBe("new");
  });

  it("ranks unknown/null source below sketch", () => {
    const rows = [
      { id: "legacy", source: null, createdAt: d(900) },
      { id: "sk", source: "sketch", createdAt: d(100) },
    ];
    expect(selectPreferredMeasurement(rows)!.id).toBe("sk");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/src/measurement-precedence.test.ts`
Expected: FAIL — cannot resolve `./measurement-precedence`.

- [ ] **Step 3: Write the implementation**

Create `packages/core/src/measurement-precedence.ts`:

```ts
/** Measurement provenance precedence (6b): ordered Roofr > uploaded report > DIY sketch. */

export type MeasurementSource = "ordered" | "uploaded_report" | "sketch";

export const MEASUREMENT_SOURCE_RANK: Record<string, number> = {
  ordered: 3,
  uploaded_report: 2,
  sketch: 1,
};

/**
 * Pick the preferred measurement: highest source rank wins; ties break to the
 * newest createdAt. Unknown/null sources rank 0 (below sketch). Returns null for []
 */
export function selectPreferredMeasurement<T extends { source: string | null; createdAt: Date }>(
  rows: T[],
): T | null {
  if (rows.length === 0) return null;
  return rows.reduce((best, cur) => {
    const bestRank = MEASUREMENT_SOURCE_RANK[best.source ?? ""] ?? 0;
    const curRank = MEASUREMENT_SOURCE_RANK[cur.source ?? ""] ?? 0;
    if (curRank > bestRank) return cur;
    if (curRank === bestRank && cur.createdAt > best.createdAt) return cur;
    return best;
  });
}
```

Append to `packages/core/src/index.ts`:

```ts
export * from "./measurement-precedence";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/core/src/measurement-precedence.test.ts`
Expected: PASS (5 passing).

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @savvy/core typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/measurement-precedence.ts packages/core/src/measurement-precedence.test.ts packages/core/src/index.ts
git commit -m "feat(core): selectPreferredMeasurement source-precedence ranker (slice 6b)"
```

---

### Task 3: Apply precedence in estimate draft + lead artifacts (+ surface source in UI)

**Files:**
- Modify: `packages/db/src/lifecycle/estimate.ts` (`draftLeadEstimateIfReady`, the measurement select ~lines 114-121)
- Modify: `packages/db/src/lifecycle/lead-artifacts.ts` (`getLeadArtifacts` measurement select + `LeadArtifacts` type)
- Modify: `apps/web/src/app/(app)/leads/[id]/LeadArtifacts.tsx` (Source label)
- Modify: `packages/db/tests/draft-lead-estimate.test.ts` (add a precedence case)
- Create: `packages/db/tests/lead-artifacts-precedence.test.ts`

**Interfaces:**
- Consumes: `selectPreferredMeasurement` from `@savvy/core` (Task 2).
- Produces: `draftLeadEstimateIfReady` and `getLeadArtifacts` select the preferred measurement (not merely newest). `LeadArtifacts.measurement` gains a `source: string | null` field.

- [ ] **Step 1: Write the failing tests**

Add this case to `packages/db/tests/draft-lead-estimate.test.ts` (inside the `describe` block; reuse the file's existing `completeInspection`, `landMeasurement`, imports — and add `measurement`/`withTenant` if not already imported at top, which they are):

```ts
  it("drafts from the ORDERED measurement even when a newer sketch exists (precedence)", async () => {
    const { tenantId } = await makeTenant();
    const { leadId, propertyId } = await makeLeadWithProperty(tenantId);
    await ensurePriceBook(tenantId);
    await completeInspection(tenantId, leadId, propertyId);
    // Older ordered measurement, then a NEWER sketch — precedence must pick ordered.
    await withTenant(tenantId, (tx) => tx.insert(measurement).values({
      tenantId, propertyId, provider: "roofr", source: "ordered",
      areas: { squares: 20, predominantPitch: "6/12", eaveLf: 100, rakeLf: 50 },
    }));
    await withTenant(tenantId, (tx) => tx.insert(measurement).values({
      tenantId, propertyId, provider: "diy", source: "sketch",
      areas: { squares: 99, predominantPitch: "4/12" },
    }));

    const res = await draftLeadEstimateIfReady({ tenantId, leadId });
    expect("estimateId" in res).toBe(true);
    const [e] = await adminDb.select().from(estimate).where(eq(estimate.id, (res as { estimateId: string }).estimateId));
    const [orderedM] = await adminDb.select().from(measurement)
      .where(and(eq(measurement.propertyId, propertyId), eq(measurement.source, "ordered")));
    expect(e!.measurementId).toBe(orderedM!.id);
  });
```

Add `and` to that test file's drizzle import if missing (`import { adminDb, appointment, measurement, estimate, eq, and } from "../src/index.js";`).

Create `packages/db/tests/lead-artifacts-precedence.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { getLeadArtifacts } from "../src/lifecycle/lead-artifacts.js";
import { withTenant } from "../src/tenant.js";
import { measurement } from "../src/index.js";
import { makeTenant, makeLeadWithProperty } from "./helpers.js";

describe("getLeadArtifacts measurement precedence", () => {
  it("returns the uploaded_report over a newer sketch, exposing source", async () => {
    const { tenantId } = await makeTenant();
    const { leadId, propertyId } = await makeLeadWithProperty(tenantId);
    await withTenant(tenantId, (tx) => tx.insert(measurement).values({
      tenantId, propertyId, provider: "diy", source: "sketch", areas: { squares: 5 },
    }));
    await withTenant(tenantId, (tx) => tx.insert(measurement).values({
      tenantId, propertyId, provider: "roofr", source: "uploaded_report", areas: { squares: 22 },
    }));

    const arts = await getLeadArtifacts({ tenantId, leadId });
    expect(arts.measurement?.source).toBe("uploaded_report");
    expect(arts.measurement?.squares).toBe(22);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @savvy/db exec vitest run tests/draft-lead-estimate.test.ts tests/lead-artifacts-precedence.test.ts`
Expected: FAIL — draft picks the newer sketch (squares 99) so `measurementId` mismatches; `arts.measurement.source` is undefined (property doesn't exist yet).

- [ ] **Step 3: Apply precedence in `draftLeadEstimateIfReady`**

In `packages/db/src/lifecycle/estimate.ts`: add `selectPreferredMeasurement` to the `@savvy/core` import, and replace the "(2) measurement landed? (newest wins)" block (the single-row `orderBy(desc(createdAt)).limit(1)` select, ~lines 114-121) with a fetch-all + precedence pick:

```ts
    // (2) measurement landed? Source precedence: ordered > uploaded_report > sketch, newest within a source.
    const measRows = await tx
      .select({ id: measurement.id, source: measurement.source, createdAt: measurement.createdAt })
      .from(measurement)
      .where(eq(measurement.propertyId, l.propertyId));
    const m = selectPreferredMeasurement(measRows);
    if (!m) return { skipped: "no_measurement" as const };
```

(The later `insertEstimateFromMeasurementTx({ ..., measurementId: m.id, ... })` call is unchanged — `m.id` still resolves.)

- [ ] **Step 4: Apply precedence + expose source in `getLeadArtifacts`**

In `packages/db/src/lifecycle/lead-artifacts.ts`: add `import { selectPreferredMeasurement } from "@savvy/core";`. Add `source: string | null;` to the `LeadArtifacts.measurement` type. Replace the newest-measurement select (~lines 34-36) and include `source` in the returned object:

```ts
    const measRows = l?.propertyId
      ? await tx.select().from(measurement).where(eq(measurement.propertyId, l.propertyId))
      : [];
    const m = selectPreferredMeasurement(measRows);
```

and in the returned `measurement` object add `source: m.source,` alongside `provider`. (Keep `provider` — the UI transition uses `source` now but `provider` stays available.)

- [ ] **Step 5: Surface the source label in the lead tile**

In `apps/web/src/app/(app)/leads/[id]/LeadArtifacts.tsx`, replace the Source `Field` (currently `value={m.provider === "diy" ? "DIY sketch" : "Roofr"}`) with a source-based label:

```tsx
            <Field label="Source" value={
              m.source === "uploaded_report" ? "Uploaded report"
              : m.source === "sketch" ? "DIY sketch"
              : m.source === "ordered" ? "Roofr"
              : (m.provider === "diy" ? "DIY sketch" : "Roofr")
            } />
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm --filter @savvy/db exec vitest run tests/draft-lead-estimate.test.ts tests/lead-artifacts-precedence.test.ts`
Expected: PASS (all cases, including the two new precedence cases).

- [ ] **Step 7: Typecheck**

Run: `pnpm --filter @savvy/db typecheck && pnpm --filter web typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add packages/db/src/lifecycle/estimate.ts packages/db/src/lifecycle/lead-artifacts.ts "apps/web/src/app/(app)/leads/[id]/LeadArtifacts.tsx" packages/db/tests/draft-lead-estimate.test.ts packages/db/tests/lead-artifacts-precedence.test.ts
git commit -m "feat: measurement source precedence in estimate draft + lead artifacts UI (slice 6b)"
```

---

### Task 4: Measurement-report parse schema (`@savvy/core`) + DB helpers

**Files:**
- Create: `packages/core/src/measurement-report-parse.ts`
- Create: `packages/core/src/measurement-report-parse.test.ts`
- Modify: `packages/core/src/index.ts` (barrel export)
- Modify: `packages/db/src/lifecycle/lead-documents.ts` (add 3 helpers)
- Modify: `packages/db/src/index.ts` (export the 3 helpers)
- Create: `packages/db/tests/lead-document-parse-helpers.test.ts`

**Interfaces:**
- Consumes: `measurementAreasSchema`, `z` from `@savvy/core`; the `document`/`measurement` schema.
- Produces:
  - `measurementReportParseSchema` (`measurementAreasSchema` fields + `confidence: number`) and `type MeasurementReportParse`
  - `MEASUREMENT_PARSE_MIN_CONFIDENCE = 0.8`
  - `getLeadDocumentForParse(tenantId, documentId): Promise<{ r2Key: string | null; kind: string; leadId: string | null; propertyId: string | null } | null>`
  - `insertUploadedMeasurement(input: { tenantId: string; propertyId: string; areas: Record<string, unknown>; pitch: string | null }): Promise<string>` (returns measurementId; sets `provider:"roofr"`, `source:"uploaded_report"`)
  - `setDocumentParseStatus(input: { tenantId: string; documentId: string; status: string; confidence?: number | null }): Promise<void>`

- [ ] **Step 1: Write the failing tests (core schema)**

Create `packages/core/src/measurement-report-parse.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { measurementReportParseSchema, MEASUREMENT_PARSE_MIN_CONFIDENCE } from "./measurement-report-parse";

describe("measurementReportParseSchema", () => {
  it("parses a full report with confidence and defaults missing areas to 0", () => {
    const out = measurementReportParseSchema.parse({
      squares: 24, predominantPitch: "8/12", eaveLf: 120, rakeLf: 60, confidence: 0.92,
    });
    expect(out.squares).toBe(24);
    expect(out.predominantPitch).toBe("8/12");
    expect(out.ridgeLf).toBe(0); // defaulted
    expect(out.confidence).toBeCloseTo(0.92);
  });

  it("rejects confidence outside 0-1", () => {
    expect(() => measurementReportParseSchema.parse({ confidence: 1.5 })).toThrow();
  });

  it("exposes a 0.8 minimum-confidence threshold", () => {
    expect(MEASUREMENT_PARSE_MIN_CONFIDENCE).toBe(0.8);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run packages/core/src/measurement-report-parse.test.ts`
Expected: FAIL — cannot resolve `./measurement-report-parse`.

- [ ] **Step 3: Write the core schema**

Create `packages/core/src/measurement-report-parse.ts`:

```ts
import { z } from "./schemas";
import { measurementAreasSchema } from "./measurement";

/**
 * Extraction schema for an uploaded measurement report (Roofr PDF or similar).
 * Reuses the exact estimate-engine area fields + a 0-1 confidence, so a parsed
 * report drops straight into `measurement.areas`.
 */
export const measurementReportParseSchema = measurementAreasSchema.extend({
  confidence: z.number().min(0).max(1),
});
export type MeasurementReportParse = z.infer<typeof measurementReportParseSchema>;

/** Below this confidence, an upload is carded ("stored, unparsed") rather than trusted. */
export const MEASUREMENT_PARSE_MIN_CONFIDENCE = 0.8;
```

Append to `packages/core/src/index.ts`:

```ts
export * from "./measurement-report-parse";
```

- [ ] **Step 4: Run core test to verify it passes**

Run: `pnpm vitest run packages/core/src/measurement-report-parse.test.ts`
Expected: PASS (3 passing).

- [ ] **Step 5: Write the failing DB-helper test**

Create `packages/db/tests/lead-document-parse-helpers.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  recordLeadDocument, getLeadDocumentForParse, insertUploadedMeasurement, setDocumentParseStatus,
} from "../src/lifecycle/lead-documents.js";
import { adminDb, document, measurement, eq } from "../src/index.js";
import { makeTenant, makeLeadWithProperty } from "./helpers.js";

describe("lead-document parse DB helpers", () => {
  it("getLeadDocumentForParse returns the doc's key, kind, lead and property", async () => {
    const { tenantId } = await makeTenant();
    const { leadId, propertyId } = await makeLeadWithProperty(tenantId);
    const rec = await recordLeadDocument({
      tenantId, leadId, uploadedByUserId: null,
      r2Key: `${tenantId}/lead/${leadId}/m.pdf`, kind: "measurement_report",
      filename: "m.pdf", mime: "application/pdf", sizeBytes: 10,
    });
    const got = await getLeadDocumentForParse(tenantId, rec!.id);
    expect(got).toMatchObject({ r2Key: `${tenantId}/lead/${leadId}/m.pdf`, kind: "measurement_report", leadId, propertyId });
  });

  it("insertUploadedMeasurement creates a uploaded_report measurement", async () => {
    const { tenantId } = await makeTenant();
    const { propertyId } = await makeLeadWithProperty(tenantId);
    const mid = await insertUploadedMeasurement({
      tenantId, propertyId, areas: { squares: 21, predominantPitch: "7/12" }, pitch: "7/12",
    });
    const [m] = await adminDb.select().from(measurement).where(eq(measurement.id, mid));
    expect(m!.source).toBe("uploaded_report");
    expect(m!.provider).toBe("roofr");
    expect((m!.areas as { squares?: number }).squares).toBe(21);
  });

  it("setDocumentParseStatus updates status + confidence", async () => {
    const { tenantId } = await makeTenant();
    const { leadId } = await makeLeadWithProperty(tenantId);
    const rec = await recordLeadDocument({
      tenantId, leadId, uploadedByUserId: null,
      r2Key: `${tenantId}/lead/${leadId}/m.pdf`, kind: "measurement_report",
      filename: "m.pdf", mime: "application/pdf", sizeBytes: 10,
    });
    await setDocumentParseStatus({ tenantId, documentId: rec!.id, status: "parsed", confidence: 0.9 });
    const [d] = await adminDb.select().from(document).where(eq(document.id, rec!.id));
    expect(d!.parseStatus).toBe("parsed");
    expect(d!.parseConfidence).toBeCloseTo(0.9);
  });
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `pnpm --filter @savvy/db exec vitest run tests/lead-document-parse-helpers.test.ts`
Expected: FAIL — helpers not exported.

- [ ] **Step 7: Add the DB helpers**

Append to `packages/db/src/lifecycle/lead-documents.ts` (the imports `document`, `measurement`, `withTenant`, `eq`, `and`, `isNull` — add `measurement` to the `../schema/ops` import; `desc` already imported):

Update the ops import line to include `measurement`:
```ts
import { document, measurement } from "../schema/ops";
```

Add the three helpers at the end of the file:
```ts
/** Load the fields the parse pipeline needs for one lead document. */
export async function getLeadDocumentForParse(
  tenantId: string,
  documentId: string,
): Promise<{ r2Key: string | null; kind: string; leadId: string | null; propertyId: string | null } | null> {
  return withTenant(tenantId, async (tx) => {
    const [d] = await tx
      .select({ r2Key: document.r2Key, kind: document.kind, leadId: document.leadId, propertyId: document.propertyId })
      .from(document)
      .where(eq(document.id, documentId));
    return d ?? null;
  });
}

/** Insert an uploaded-report measurement (provider roofr, source uploaded_report). Returns its id. */
export async function insertUploadedMeasurement(input: {
  tenantId: string;
  propertyId: string;
  areas: Record<string, unknown>;
  pitch: string | null;
}): Promise<string> {
  return withTenant(input.tenantId, async (tx) => {
    const [m] = await tx
      .insert(measurement)
      .values({
        tenantId: input.tenantId,
        propertyId: input.propertyId,
        provider: "roofr",
        source: "uploaded_report",
        areas: input.areas,
        pitch: input.pitch,
      })
      .returning({ id: measurement.id });
    return m!.id;
  });
}

/** Set a document's parse lifecycle status (+ optional 0-1 confidence). */
export async function setDocumentParseStatus(input: {
  tenantId: string;
  documentId: string;
  status: string;
  confidence?: number | null;
}): Promise<void> {
  await withTenant(input.tenantId, (tx) =>
    tx
      .update(document)
      .set({ parseStatus: input.status, parseConfidence: input.confidence ?? null })
      .where(eq(document.id, input.documentId)),
  );
}
```

Add to `packages/db/src/index.ts` (next to the existing lead-documents export line):
```ts
export { getLeadDocumentForParse, insertUploadedMeasurement, setDocumentParseStatus } from "./lifecycle/lead-documents";
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `pnpm vitest run packages/core/src/measurement-report-parse.test.ts` → PASS
Run: `pnpm --filter @savvy/db exec vitest run tests/lead-document-parse-helpers.test.ts` → PASS (3)

- [ ] **Step 9: Typecheck**

Run: `pnpm --filter @savvy/core typecheck && pnpm --filter @savvy/db typecheck`
Expected: no errors.

- [ ] **Step 10: Commit**

```bash
git add packages/core/src/measurement-report-parse.ts packages/core/src/measurement-report-parse.test.ts packages/core/src/index.ts packages/db/src/lifecycle/lead-documents.ts packages/db/src/index.ts packages/db/tests/lead-document-parse-helpers.test.ts
git commit -m "feat: measurement-report parse schema + lead-document parse DB helpers (slice 6b)"
```

---

### Task 5: Parse handler + Inngest function + event emission

**Files:**
- Create: `packages/agents/src/functions/parse-lead-document.ts`
- Modify: `packages/agents/src/index.ts` (import + export + register in `functions`)
- Modify: `apps/web/src/lib/document-actions.ts` (`recordLeadDocumentAction` emits `lead-document/received`)
- Create: `packages/agents/src/functions/parse-lead-document.test.ts` (agents tests are co-located in `src/`, not a `tests/` dir)

**Interfaces:**
- Consumes: `measurementReportParseSchema`, `MeasurementReportParse`, `MEASUREMENT_PARSE_MIN_CONFIDENCE`, `PARSEABLE_KINDS` from `@savvy/core`; `getLeadDocumentForParse`, `insertUploadedMeasurement`, `setDocumentParseStatus` from `@savvy/db`; `completeObject` from `@savvy/ai`; `r2Storage` from `@savvy/integrations`; `inngest` from the agents client.
- Produces:
  - `parseLeadDocumentHandler(input: { tenantId: string; documentId: string }, deps: ParseLeadDocumentDeps): Promise<{ status: "parsed" | "unparsed_low_confidence" | "parse_failed" | "skipped"; measurementId?: string; leadId?: string | null; propertyId?: string | null }>`
  - `parseLeadDocument` (Inngest function on `lead-document/received`, emits `measurement/ready` on parsed)

- [ ] **Step 1: Write the failing handler tests**

Create `packages/agents/src/functions/parse-lead-document.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { parseLeadDocumentHandler, type ParseLeadDocumentDeps } from "./parse-lead-document";
import type { MeasurementReportParse } from "@savvy/core";

function makeDeps(over: Partial<ParseLeadDocumentDeps> = {}): ParseLeadDocumentDeps {
  const parsed: MeasurementReportParse = {
    squares: 20, predominantPitch: "8/12", ridgeLf: 0, hipLf: 0, valleyLf: 0,
    eaveLf: 100, rakeLf: 50, stepFlashingLf: 0, penetrationCount: 0, facetCount: 0, confidence: 0.95,
  };
  return {
    loadDoc: vi.fn().mockResolvedValue({ r2Key: "t/lead/l/m.pdf", kind: "measurement_report", leadId: "l1", propertyId: "p1" }),
    fetchBytes: vi.fn().mockResolvedValue(new Uint8Array([1])),
    ai: { completeObject: vi.fn().mockResolvedValue({ object: parsed, model: "stub" }) },
    insertMeasurement: vi.fn().mockResolvedValue("m1"),
    setStatus: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
}

describe("parseLeadDocumentHandler", () => {
  it("parses a measurement_report → inserts measurement, sets parsed, returns ids", async () => {
    const deps = makeDeps();
    const res = await parseLeadDocumentHandler({ tenantId: "t1", documentId: "d1" }, deps);
    expect(res).toEqual({ status: "parsed", measurementId: "m1", leadId: "l1", propertyId: "p1" });
    expect(deps.insertMeasurement).toHaveBeenCalledOnce();
    expect(deps.setStatus).toHaveBeenCalledWith(expect.objectContaining({ status: "parsed", confidence: 0.95 }));
  });

  it("cards a low-confidence parse without inserting a measurement", async () => {
    const low: MeasurementReportParse = { squares: 1, predominantPitch: "0/12", ridgeLf: 0, hipLf: 0, valleyLf: 0, eaveLf: 0, rakeLf: 0, stepFlashingLf: 0, penetrationCount: 0, facetCount: 0, confidence: 0.4 };
    const deps = makeDeps({ ai: { completeObject: vi.fn().mockResolvedValue({ object: low, model: "stub" }) } });
    const res = await parseLeadDocumentHandler({ tenantId: "t1", documentId: "d1" }, deps);
    expect(res.status).toBe("unparsed_low_confidence");
    expect(deps.insertMeasurement).not.toHaveBeenCalled();
    expect(deps.setStatus).toHaveBeenCalledWith(expect.objectContaining({ status: "unparsed_low_confidence" }));
  });

  it("skips a non-measurement kind (insurance_estimate is 6c)", async () => {
    const deps = makeDeps({ loadDoc: vi.fn().mockResolvedValue({ r2Key: "k", kind: "insurance_estimate", leadId: "l1", propertyId: "p1" }) });
    const res = await parseLeadDocumentHandler({ tenantId: "t1", documentId: "d1" }, deps);
    expect(res.status).toBe("skipped");
    expect(deps.ai.completeObject).not.toHaveBeenCalled();
  });

  it("fail-soft: an AI/throw sets parse_failed and never throws", async () => {
    const deps = makeDeps({ ai: { completeObject: vi.fn().mockRejectedValue(new Error("boom")) } });
    const res = await parseLeadDocumentHandler({ tenantId: "t1", documentId: "d1" }, deps);
    expect(res.status).toBe("parse_failed");
    expect(deps.setStatus).toHaveBeenCalledWith(expect.objectContaining({ status: "parse_failed" }));
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @savvy/agents exec vitest run src/functions/parse-lead-document.test.ts`
Expected: FAIL — cannot resolve `./parse-lead-document`.

- [ ] **Step 3: Write the handler + Inngest function**

Create `packages/agents/src/functions/parse-lead-document.ts`:

```ts
import { getLeadDocumentForParse, insertUploadedMeasurement, setDocumentParseStatus } from "@savvy/db";
import { completeObject } from "@savvy/ai";
import { measurementReportParseSchema, MEASUREMENT_PARSE_MIN_CONFIDENCE, type MeasurementReportParse } from "@savvy/core";
import { r2Storage } from "@savvy/integrations";
import { inngest } from "../client";

const PARSE_SYSTEM =
  "You are a roofing measurement estimator. Extract a roof measurement report (Roofr, EagleView, or similar) " +
  "into structured areas. All lengths are linear feet; squares are roofing squares (100 sq ft). If a field is " +
  "missing, use 0. Confidence is your 0-1 certainty the extraction faithfully reflects the document.";

const PARSE_PROMPT =
  "Extract this roof measurement report: total squares, predominant pitch (e.g. \"8/12\"), and the linear-foot " +
  "totals for ridge, hip, valley, eave, rake, and step flashing, plus penetration count and facet count.";

export type ParseLeadDocumentDeps = {
  loadDoc: (tenantId: string, documentId: string) => Promise<{ r2Key: string | null; kind: string; leadId: string | null; propertyId: string | null } | null>;
  fetchBytes: (key: string) => Promise<Uint8Array>;
  ai: {
    completeObject: (opts: {
      capability: "reasoning";
      prompt: string;
      system?: string;
      schema: typeof measurementReportParseSchema;
      file?: { bytes: Uint8Array; mediaType: string };
    }) => Promise<{ object: MeasurementReportParse; model: string }>;
  };
  insertMeasurement: (input: { tenantId: string; propertyId: string; areas: Record<string, unknown>; pitch: string | null }) => Promise<string>;
  setStatus: (input: { tenantId: string; documentId: string; status: string; confidence?: number | null }) => Promise<void>;
};

/**
 * Parse one uploaded lead document. For `measurement_report`: load its PDF → parse
 * via the AI gateway → insert an `uploaded_report` measurement → mark the doc parsed.
 * Low confidence → card as `unparsed_low_confidence` (no measurement). Any error →
 * `parse_failed`. Non-measurement kinds (insurance_estimate is 6c) → `skipped`.
 * FAIL-SOFT: never throws.
 */
export async function parseLeadDocumentHandler(
  input: { tenantId: string; documentId: string },
  deps: ParseLeadDocumentDeps,
): Promise<{ status: "parsed" | "unparsed_low_confidence" | "parse_failed" | "skipped"; measurementId?: string; leadId?: string | null; propertyId?: string | null }> {
  const { tenantId, documentId } = input;
  try {
    const doc = await deps.loadDoc(tenantId, documentId);
    if (!doc) return { status: "parse_failed" };
    if (doc.kind !== "measurement_report") return { status: "skipped" };
    if (!doc.r2Key || !doc.propertyId) throw new Error("measurement document missing key or property");

    const bytes = await deps.fetchBytes(doc.r2Key);
    const { object: parsed } = await deps.ai.completeObject({
      capability: "reasoning",
      system: PARSE_SYSTEM,
      prompt: PARSE_PROMPT,
      schema: measurementReportParseSchema,
      file: { bytes, mediaType: "application/pdf" },
    });

    if (parsed.confidence < MEASUREMENT_PARSE_MIN_CONFIDENCE) {
      await deps.setStatus({ tenantId, documentId, status: "unparsed_low_confidence", confidence: parsed.confidence });
      return { status: "unparsed_low_confidence" };
    }

    const { confidence, ...areas } = parsed;
    const measurementId = await deps.insertMeasurement({
      tenantId, propertyId: doc.propertyId, areas, pitch: areas.predominantPitch,
    });
    await deps.setStatus({ tenantId, documentId, status: "parsed", confidence });
    return { status: "parsed", measurementId, leadId: doc.leadId, propertyId: doc.propertyId };
  } catch {
    await deps.setStatus({ tenantId, documentId, status: "parse_failed" }).catch(() => {});
    return { status: "parse_failed" };
  }
}

export const parseLeadDocument = inngest.createFunction(
  { id: "parse-lead-document", concurrency: { limit: 5, key: "event.data.tenantId" }, retries: 2 },
  { event: "lead-document/received" },
  async ({ event, step }) => {
    const { tenantId, documentId } = event.data as { tenantId: string; documentId: string; kind?: string };

    const result = await step.run("parse", () =>
      parseLeadDocumentHandler(
        { tenantId, documentId },
        {
          loadDoc: (t, d) => getLeadDocumentForParse(t, d),
          fetchBytes: async (key) => {
            // R2 isn't wired in e2e (the upload action stubs storage under TEST_MODE);
            // return a minimal PDF header so the pipeline stays exercisable — the stubbed
            // AI gateway ignores the bytes anyway.
            if (process.env.TEST_MODE === "1") return new Uint8Array([0x25, 0x50, 0x44, 0x46]);
            const { url } = await r2Storage.presignDownload({ key });
            const res = await fetch(url);
            if (!res.ok) throw new Error(`fetch ${res.status}`);
            return new Uint8Array(await res.arrayBuffer());
          },
          ai: { completeObject },
          insertMeasurement: (i) => insertUploadedMeasurement(i),
          setStatus: (i) => setDocumentParseStatus(i),
        },
      ),
    );

    // An uploaded measurement feeds the same estimate auto-draft as a Roofr order.
    if (result.status === "parsed" && result.measurementId) {
      await step.sendEvent("emit-ready", {
        name: "measurement/ready",
        data: { tenantId, measurementId: result.measurementId, propertyId: result.propertyId, leadId: result.leadId },
      });
    }
    return result;
  },
);
```

- [ ] **Step 4: Register the function**

In `packages/agents/src/index.ts`:
- Add import near the other function imports: `import { parseLeadDocument } from "./functions/parse-lead-document";`
- Add re-export near the others: `export { parseLeadDocument, parseLeadDocumentHandler } from "./functions/parse-lead-document";`
- Add `parseLeadDocument` to the `functions` array (append before the closing `]`).

- [ ] **Step 5: Emit `lead-document/received` from the upload action**

In `apps/web/src/lib/document-actions.ts`: add `import { inngest } from "@savvy/agents";` and add `PARSEABLE_KINDS` to the existing `@savvy/core` import. In `recordLeadDocumentAction`, after the successful `recordLeadDocument` and before/around the `revalidatePath`, emit the parse event for parseable kinds:

```ts
  if (!res) return { error: "not_found" };
  // Parseable uploads feed the parse pipeline (6b measurement, 6c insurance).
  if ((PARSEABLE_KINDS as readonly string[]).includes(input.kind)) {
    await inngest.send({
      name: "lead-document/received",
      data: { tenantId, documentId: res.id, leadId: input.leadId, kind: input.kind },
    }).catch(() => {});
  }
  revalidatePath(`/leads/${input.leadId}`);
  return { ok: true, id: res.id };
```

- [ ] **Step 6: Run handler tests to verify they pass**

Run: `pnpm --filter @savvy/agents exec vitest run src/functions/parse-lead-document.test.ts`
Expected: PASS (4 passing).

- [ ] **Step 7: Typecheck**

Run: `pnpm --filter @savvy/agents typecheck && pnpm --filter web typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add packages/agents/src/functions/parse-lead-document.ts packages/agents/src/functions/parse-lead-document.test.ts packages/agents/src/index.ts apps/web/src/lib/document-actions.ts
git commit -m "feat(agents): parse-lead-document (measurement report) + emit lead-document/received (slice 6b)"
```

---

### Task 6: Lock auto-order suppression (uploaded measurement ⇒ no Roofr order)

The spec's rule "an uploaded measurement suppresses the Roofr auto-order" is already satisfied by the existing `shouldAutoOrderMeasurement` gate (it returns false when the property has any measurement). This task adds a regression test that locks that guarantee against the `uploaded_report` source specifically, so a future change can't silently re-enable double-ordering.

**Files:**
- Create: `packages/agents/src/functions/auto-order-suppression.test.ts`

**Interfaces:**
- Consumes: `shouldAutoOrderMeasurement` from the local `./auto-order-measurement` (Slice-1 pure gate; unchanged).

> This is a **pure** regression lock — no DB. The other half of the guarantee ("an uploaded report creates a measurement row on the property") is already covered by Task 4's `insertUploadedMeasurement` test, and the auto-order Inngest fn's existence query keys off `measurement.propertyId`, so any measurement row (incl. `uploaded_report`) flips `hasMeasurement` true. Together they lock "uploaded measurement ⇒ no Roofr order" without a cross-package DB fixture.

- [ ] **Step 1: Write the test**

Create `packages/agents/src/functions/auto-order-suppression.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { shouldAutoOrderMeasurement } from "./auto-order-measurement";

describe("Roofr auto-order suppression (Slice 6b lock)", () => {
  const base = { enabled: true, apptType: "inspection", apptStatus: "scheduled" };

  it("orders when the property has no measurement", () => {
    expect(shouldAutoOrderMeasurement({ ...base, hasMeasurement: false })).toBe(true);
  });

  it("does NOT order once the property has a measurement (e.g. an uploaded report)", () => {
    expect(shouldAutoOrderMeasurement({ ...base, hasMeasurement: true })).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it passes**

Run: `pnpm --filter @savvy/agents exec vitest run src/functions/auto-order-suppression.test.ts`
Expected: PASS (2). (A regression lock — passes on the existing gate; fails only if someone removes the `hasMeasurement` short-circuit.)

- [ ] **Step 3: Commit**

```bash
git add packages/agents/src/functions/auto-order-suppression.test.ts
git commit -m "test: lock Roofr auto-order suppression when a measurement exists (slice 6b)"
```

---

## Definition of Done (Slice 6b)

- [ ] `measurement.source` (0064, backfilled) with `ordered`/`uploaded_report`/`sketch`; all measurement inserts stamp a source.
- [ ] `selectPreferredMeasurement` ranks ordered > uploaded_report > sketch (newest within a source); used by the estimate draft and the lead-artifacts display.
- [ ] Lead tile Measurement card shows the correct source label ("Uploaded report").
- [ ] Uploading a `measurement_report` emits `lead-document/received`; `parseLeadDocument` parses it into an `uploaded_report` measurement (fail-soft: low-confidence cards, errors → parse_failed), then emits `measurement/ready` so the estimate auto-drafts.
- [ ] An uploaded measurement suppresses the Roofr auto-order (regression-locked).
- [ ] `@savvy/core` / `@savvy/db` / `@savvy/agents` / `web` typecheck + lint clean; all new tests + existing `draft-lead-estimate`/measurement regressions green.

## Self-Review notes (coverage vs the 6b spec)

- **`measurement.source` column + `uploaded_report`**: Task 1. ✅
- **Parse measurement PDF → measurement row (source uploaded_report)**: Tasks 4 + 5. ✅
- **Suppress Roofr auto-order via existing `hasMeasurement` gate**: Task 6 (locked). ✅ (No gate change needed — inserting the measurement row is the suppression; the post-booking timing caveat is accepted per the spec.)
- **Emit `measurement/ready` → estimate auto-draft consumes identically**: Task 5 (parse emits it; `generateEstimateOnMeasurement` already handles it). ✅
- **Precedence ordered > uploaded_report > sketch, newest within a source**: Tasks 2 + 3. ✅
- **`lead-document/received` trigger** (6a didn't emit it): Task 5. ✅
- **Fail-soft carding (`unparsed_low_confidence`)**: Task 5 handler. ✅
- **Deferred to later phases:** insurance_estimate parse + claim rescope (6c — handler `skipped`s it here); evidence checks (6d). A Today exception card for `unparsed_low_confidence`/`parse_failed` docs is 6d evidence work; 6b sets the status, 6d surfaces the card.

**Not covered by an automated test (documented):** the live R2→AI round-trip and the Inngest `measurement/ready` emission are exercised only via the pure handler tests + the proven supplier-invoice wiring pattern (the Inngest fn is a thin wrapper); verify end-to-end manually with `pnpm dev` (upload a measurement PDF on a lead with a completed inspection → measurement + draft estimate appear).
