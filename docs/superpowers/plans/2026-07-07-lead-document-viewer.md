# Lead Document Viewer + Parse Result Panel + Re-parse — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make lead/job documents viewable on click and show what the parser extracted beside each parsed insurance-estimate / measurement-report, with a safe idempotent re-parse.

**Architecture:** A same-origin proxy route streams R2 objects (no key/PII in the browser URL). A shared `DocViewer` lightbox renders PDFs/images. A live-join db reader surfaces the populated `claim`/`measurement` next to each doc; a pure `@savvy/core` mapper turns that into a display model (unit-testable without jsdom). Re-parse re-emits the existing Inngest event and inherits the coalesce-only confirmed-field guard.

**Tech Stack:** Next.js App Router (route handlers + server actions), Drizzle/Postgres (RLS via `withTenant`), Cloudflare R2 (`@savvy/integrations` `r2Storage`), Inngest, Zod, Vitest, Playwright.

## Global Constraints

- **Tenant isolation on every query/route** — reads go through `withTenant` (RLS) or the tenant-scoped resolver; never expose cross-tenant data. (verbatim: `tenant_id = current_setting('app.tenant_id')::uuid`)
- **No public/permanent URLs; no customer PII in the browser URL** — views are same-origin, session-gated; R2 presign stays server-side, `expiresIn: 300`.
- **AI via the gateway by capability** — re-parse reuses `completeObject({ capability: "reasoning", … })`; no hard-coded model.
- **Async work is a durable Inngest workflow** — re-parse re-emits `lead-document/received`; the fail-soft handler owns retries/idempotency.
- **TypeScript strict, no `any`** (use `unknown`); explicit return types on exported functions; async/await not `.then()`; Tailwind + design-system CSS vars, no hardcoded colors.
- **Waste is NOT a measurement-report field** — the measurement panel shows squares/pitch/LF totals only; never invent a waste value.
- **Every feature ships with tests; typecheck + lint clean before commit.**
- Test commands (this repo): `pnpm --filter @savvy/db test -- --run <file>`, `pnpm --filter @savvy/core test -- --run <file>`, `pnpm --filter @savvy/agents test -- --run <file>`, `pnpm -w typecheck`, `pnpm -w lint`. Note: the shared local Postgres can throw a `health-sweep.test.ts` teardown FK flake — unrelated to these tasks.

---

### Task 1: `upsertUploadedMeasurement` (idempotent measurement write)

Re-parsing a measurement must not litter rows. Replace the insert-only helper with an upsert (update the property's newest `uploaded_report` measurement, else insert). First-parse behavior is unchanged.

**Files:**
- Modify: `packages/db/src/lifecycle/lead-documents.ts` (rename/replace `insertUploadedMeasurement`, lines 125-146)
- Modify: `packages/db/src/index.ts` (barrel export name)
- Modify: `packages/agents/src/functions/parse-lead-document.ts:1,136` (import + dep wiring)
- Test: `packages/db/tests/lead-document-parse-helpers.test.ts` (add cases; file already exists)

**Interfaces:**
- Produces: `upsertUploadedMeasurement(input: { tenantId: string; propertyId: string; areas: Record<string, unknown>; pitch: string | null }): Promise<string>` — returns the measurement id (stable across re-parses of the same property's uploaded report).

- [ ] **Step 1: Write the failing test**

Add to `packages/db/tests/lead-document-parse-helpers.test.ts` (follow the existing fixture style in that file — a helper that creates a tenant+property; reuse it):

```ts
import { upsertUploadedMeasurement } from "../src/index.js";
import { adminDb, adminPool } from "../src/admin-client.js";
import { measurement } from "../src/schema/index.js";
import { and, eq } from "drizzle-orm";

it("upsertUploadedMeasurement is idempotent: re-parse updates one row, id stable", async () => {
  const { tenantId, propertyId } = await mkTenantProperty(); // existing/local fixture helper
  const first = await upsertUploadedMeasurement({
    tenantId, propertyId, areas: { squares: 20, predominantPitch: "6/12" }, pitch: "6/12",
  });
  const second = await upsertUploadedMeasurement({
    tenantId, propertyId, areas: { squares: 24, predominantPitch: "8/12" }, pitch: "8/12",
  });
  expect(second).toBe(first); // same row updated, not a new insert
  const rows = await adminDb.select().from(measurement)
    .where(and(eq(measurement.propertyId, propertyId), eq(measurement.source, "uploaded_report")));
  expect(rows).toHaveLength(1);
  expect((rows[0]!.areas as { squares: number }).squares).toBe(24);
  expect(rows[0]!.pitch).toBe("8/12");
});
```

If `mkTenantProperty` does not already exist in that test file, add a minimal local helper mirroring `mkLead` from `lead-doc-evidence.test.ts` (create tenant → customer → property; return `{ tenantId, propertyId }`), and an `afterAll` that deletes measurement/property/customer/tenant for the created ids.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @savvy/db test -- --run lead-document-parse-helpers`
Expected: FAIL — `upsertUploadedMeasurement` is not exported.

- [ ] **Step 3: Write minimal implementation**

In `packages/db/src/lifecycle/lead-documents.ts`, replace the `insertUploadedMeasurement` function (lines 125-146) with:

```ts
/**
 * Insert-or-update the property's uploaded-report measurement (provider roofr, source
 * uploaded_report). A re-parse UPDATES the newest existing uploaded_report row rather than
 * inserting a duplicate, so the measurement id (and its downstream estimate auto-draft) is
 * stable across re-parses. Returns the measurement id.
 */
export async function upsertUploadedMeasurement(input: {
  tenantId: string;
  propertyId: string;
  areas: Record<string, unknown>;
  pitch: string | null;
}): Promise<string> {
  return withTenant(input.tenantId, async (tx) => {
    const [existing] = await tx
      .select({ id: measurement.id })
      .from(measurement)
      .where(and(eq(measurement.propertyId, input.propertyId), eq(measurement.source, "uploaded_report")))
      .orderBy(desc(measurement.createdAt))
      .limit(1);
    if (existing) {
      await tx.update(measurement)
        .set({ areas: input.areas, pitch: input.pitch, provider: "roofr" })
        .where(eq(measurement.id, existing.id));
      return existing.id;
    }
    const [m] = await tx
      .insert(measurement)
      .values({ tenantId: input.tenantId, propertyId: input.propertyId, provider: "roofr", source: "uploaded_report", areas: input.areas, pitch: input.pitch })
      .returning({ id: measurement.id });
    return m!.id;
  });
}
```

In `packages/db/src/index.ts`, change the re-export of `insertUploadedMeasurement` to `upsertUploadedMeasurement`.

In `packages/agents/src/functions/parse-lead-document.ts`: update the import on line 1 (`insertUploadedMeasurement` → `upsertUploadedMeasurement`) and the dep wiring on line 136 (`insertMeasurement: (i) => upsertUploadedMeasurement(i)`). The `ParseLeadDocumentDeps.insertMeasurement` prop name stays (it is an internal abstraction).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @savvy/db test -- --run lead-document-parse-helpers` and `pnpm --filter @savvy/agents test -- --run parse-lead-document`
Expected: PASS (both the new idempotency case and the existing parse-handler tests).

- [ ] **Step 5: Commit**

```bash
git add packages/db packages/agents
git commit -m "feat(lead-docs): upsertUploadedMeasurement for idempotent re-parse"
```

---

### Task 2: `parseSummaryView` mapper + shared types (`@savvy/core`)

A pure function turns a parse summary into a display model — unit-testable without jsdom, and the render-the-low-confidence-state red-path lives here.

**Files:**
- Create: `packages/core/src/doc-parse-summary.ts`
- Modify: `packages/core/src/index.ts` (export the new module)
- Test: `packages/core/src/doc-parse-summary.test.ts`

**Interfaces:**
- Produces:
  - `type DocParseSummary` (discriminated union, see code)
  - `type ParseView = { tone: "parsed" | "low" | "failed" | "pending"; headline: string; rows: { label: string; value: string }[]; entityLink: { kind: "claim" | "measurement"; id: string } | null }`
  - `function parseSummaryView(s: DocParseSummary): ParseView`

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/doc-parse-summary.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseSummaryView, type DocParseSummary } from "./doc-parse-summary";

describe("parseSummaryView", () => {
  it("insurance parsed → carrier/claim/money rows + claim link", () => {
    const s: DocParseSummary = {
      kind: "insurance_estimate", status: "parsed", confidence: 0.91,
      claim: { id: "c1", carrierName: "Acme", claimNumber: "CLM-9", acvCents: 100000, rcvCents: 150000, deductibleCents: 100000, lineItemCount: 12 },
    };
    const v = parseSummaryView(s);
    expect(v.tone).toBe("parsed");
    expect(v.entityLink).toEqual({ kind: "claim", id: "c1" });
    expect(v.rows).toContainEqual({ label: "Carrier", value: "Acme" });
    expect(v.rows).toContainEqual({ label: "Line items", value: "12" });
    expect(v.rows).toContainEqual({ label: "RCV", value: "$1,500" });
  });

  it("low-confidence → 'Stored, unparsed — card open', no rows, no link (RED PATH #2)", () => {
    const s: DocParseSummary = { kind: "insurance_estimate", status: "unparsed_low_confidence", confidence: 0.42, claim: null };
    const v = parseSummaryView(s);
    expect(v.tone).toBe("low");
    expect(v.headline).toBe("Stored, unparsed — card open");
    expect(v.rows).toEqual([]);
    expect(v.entityLink).toBeNull();
  });

  it("measurement parsed → squares/pitch/LF rows + measurement link; NO waste row", () => {
    const s: DocParseSummary = {
      kind: "measurement_report", status: "parsed", confidence: 0.88,
      measurement: { id: "m1", squares: 24, pitch: "8/12", ridgeLf: 40, hipLf: 10, valleyLf: 12, eaveLf: 120, rakeLf: 60, facetCount: 6, penetrationCount: 3 },
    };
    const v = parseSummaryView(s);
    expect(v.tone).toBe("parsed");
    expect(v.entityLink).toEqual({ kind: "measurement", id: "m1" });
    expect(v.rows).toContainEqual({ label: "Squares", value: "24" });
    expect(v.rows).toContainEqual({ label: "Pitch", value: "8/12" });
    expect(v.rows.some((r) => /waste/i.test(r.label))).toBe(false);
  });

  it("parse_failed and pending map to their tones with no rows", () => {
    expect(parseSummaryView({ kind: "insurance_estimate", status: "parse_failed", confidence: null, claim: null }).tone).toBe("failed");
    expect(parseSummaryView({ kind: "measurement_report", status: "pending", confidence: null, measurement: null }).tone).toBe("pending");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @savvy/core test -- --run doc-parse-summary`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `packages/core/src/doc-parse-summary.ts`:

```ts
export type ClaimSummary = {
  id: string;
  carrierName: string | null;
  claimNumber: string | null;
  acvCents: number | null;
  rcvCents: number | null;
  deductibleCents: number | null;
  lineItemCount: number;
};

export type MeasurementSummary = {
  id: string;
  squares: number | null;
  pitch: string | null;
  ridgeLf: number | null;
  hipLf: number | null;
  valleyLf: number | null;
  eaveLf: number | null;
  rakeLf: number | null;
  facetCount: number | null;
  penetrationCount: number | null;
};

export type DocParseSummary =
  | { kind: "insurance_estimate"; status: string; confidence: number | null; claim: ClaimSummary | null }
  | { kind: "measurement_report"; status: string; confidence: number | null; measurement: MeasurementSummary | null };

export type ParseView = {
  tone: "parsed" | "low" | "failed" | "pending";
  headline: string;
  rows: { label: string; value: string }[];
  entityLink: { kind: "claim" | "measurement"; id: string } | null;
};

function usd(cents: number | null): string {
  if (cents == null) return "—";
  return `$${Math.round(cents / 100).toLocaleString()}`;
}
function num(n: number | null): string {
  return n == null ? "—" : String(n);
}
function pct(c: number | null): string {
  return c == null ? "—" : `${Math.round(c * 100)}%`;
}

/** Map a live parse summary to a display model. Pure; no rows for non-`parsed` states. */
export function parseSummaryView(s: DocParseSummary): ParseView {
  if (s.status === "unparsed_low_confidence") {
    return { tone: "low", headline: "Stored, unparsed — card open", rows: [], entityLink: null };
  }
  if (s.status === "parse_failed") {
    return { tone: "failed", headline: "Parse failed — re-run to retry", rows: [], entityLink: null };
  }
  if (s.status !== "parsed") {
    return { tone: "pending", headline: "Parsing…", rows: [], entityLink: null };
  }

  if (s.kind === "insurance_estimate") {
    const c = s.claim;
    const rows: { label: string; value: string }[] = c
      ? [
          { label: "Carrier", value: c.carrierName ?? "—" },
          { label: "Claim #", value: c.claimNumber ?? "—" },
          { label: "ACV", value: usd(c.acvCents) },
          { label: "RCV", value: usd(c.rcvCents) },
          { label: "Deductible", value: usd(c.deductibleCents) },
          { label: "Line items", value: String(c.lineItemCount) },
          { label: "Confidence", value: pct(s.confidence) },
        ]
      : [];
    return { tone: "parsed", headline: "Extracted from insurance estimate", rows, entityLink: c ? { kind: "claim", id: c.id } : null };
  }

  const m = s.measurement;
  const rows: { label: string; value: string }[] = m
    ? [
        { label: "Squares", value: num(m.squares) },
        { label: "Pitch", value: m.pitch ?? "—" },
        { label: "Ridge LF", value: num(m.ridgeLf) },
        { label: "Hip LF", value: num(m.hipLf) },
        { label: "Valley LF", value: num(m.valleyLf) },
        { label: "Eave LF", value: num(m.eaveLf) },
        { label: "Rake LF", value: num(m.rakeLf) },
        { label: "Facets", value: num(m.facetCount) },
        { label: "Penetrations", value: num(m.penetrationCount) },
        { label: "Confidence", value: pct(s.confidence) },
      ]
    : [];
  return { tone: "parsed", headline: "Extracted from measurement report", rows, entityLink: m ? { kind: "measurement", id: m.id } : null };
}
```

Add to `packages/core/src/index.ts`: `export * from "./doc-parse-summary";`

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @savvy/core test -- --run doc-parse-summary`
Expected: PASS (5 assertions incl. the low-confidence red path).

- [ ] **Step 5: Commit**

```bash
git add packages/core
git commit -m "feat(lead-docs): parseSummaryView mapper + parse-summary types"
```

---

### Task 3: `getDocumentParseSummaries` (live-join db reader)

**Files:**
- Modify: `packages/db/src/lifecycle/lead-documents.ts` (new function)
- Modify: `packages/db/src/index.ts` (barrel)
- Test: `packages/db/tests/lead-document-parse-summaries.test.ts` (new)

**Interfaces:**
- Consumes: `DocParseSummary` from `@savvy/core`.
- Produces: `getDocumentParseSummaries(input: { tenantId: string; documentIds: string[] }): Promise<Record<string, DocParseSummary>>` — keyed by documentId; only parseable kinds appear.

- [ ] **Step 1: Write the failing test**

Create `packages/db/tests/lead-document-parse-summaries.test.ts`:

```ts
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDocumentParseSummaries } from "../src/index.js";
import { adminDb, adminPool } from "../src/admin-client.js";
import { tenant, customer, property, lead, document, claim, measurement } from "../src/schema/index.js";

let tenantId: string, leadId: string, propertyId: string;
let insDocId: string, measDocId: string, lowDocId: string;

beforeAll(async () => {
  const [t] = await adminDb.insert(tenant).values({ name: "PS", publicKey: `ps-${Date.now()}`, clerkOrgId: `org_ps_${Date.now()}` }).returning();
  tenantId = t!.id;
  const [c] = await adminDb.insert(customer).values({ tenantId, name: "c" }).returning();
  const [p] = await adminDb.insert(property).values({ tenantId, customerId: c!.id, address: `a-${crypto.randomUUID()}` }).returning();
  propertyId = p!.id;
  const [l] = await adminDb.insert(lead).values({ tenantId, customerId: c!.id, propertyId, source: "test", status: "new" }).returning();
  leadId = l!.id;

  const [insDoc] = await adminDb.insert(document).values({ tenantId, leadId, propertyId, kind: "insurance_estimate", parseStatus: "parsed", parseConfidence: 0.9, r2Key: "k1" }).returning();
  insDocId = insDoc!.id;
  await adminDb.insert(claim).values({ tenantId, leadId, propertyId, carrierName: "Acme", claimNumber: "CLM-1", acvCents: 100000, rcvCents: 150000, deductibleCents: 100000, lineItems: [{}, {}, {}], parseConfidence: 0.9 });

  const [measDoc] = await adminDb.insert(document).values({ tenantId, leadId, propertyId, kind: "measurement_report", parseStatus: "parsed", parseConfidence: 0.85, r2Key: "k2" }).returning();
  measDocId = measDoc!.id;
  await adminDb.insert(measurement).values({ tenantId, propertyId, provider: "roofr", source: "uploaded_report", areas: { squares: 24, predominantPitch: "8/12", ridgeLf: 40, facetCount: 6 }, pitch: "8/12" });

  const [lowDoc] = await adminDb.insert(document).values({ tenantId, leadId, propertyId, kind: "insurance_estimate", parseStatus: "unparsed_low_confidence", parseConfidence: 0.4, r2Key: "k3" }).returning();
  lowDocId = lowDoc!.id;
});

afterAll(async () => {
  await adminDb.delete(document).where(eq(document.tenantId, tenantId));
  await adminDb.delete(claim).where(eq(claim.tenantId, tenantId));
  await adminDb.delete(measurement).where(eq(measurement.tenantId, tenantId));
  await adminDb.delete(lead).where(eq(lead.tenantId, tenantId));
  await adminDb.delete(property).where(eq(property.tenantId, tenantId));
  await adminDb.delete(customer).where(eq(customer.tenantId, tenantId));
  await adminDb.delete(tenant).where(eq(tenant.id, tenantId));
  await adminPool.end();
});

describe("getDocumentParseSummaries", () => {
  it("insurance parsed → claim summary with lineItemCount", async () => {
    const map = await getDocumentParseSummaries({ tenantId, documentIds: [insDocId] });
    const s = map[insDocId]!;
    expect(s.kind).toBe("insurance_estimate");
    expect(s.status).toBe("parsed");
    if (s.kind === "insurance_estimate") {
      expect(s.claim?.carrierName).toBe("Acme");
      expect(s.claim?.lineItemCount).toBe(3);
      expect(s.claim?.rcvCents).toBe(150000);
    }
  });

  it("measurement parsed → measurement summary from areas", async () => {
    const map = await getDocumentParseSummaries({ tenantId, documentIds: [measDocId] });
    const s = map[measDocId]!;
    if (s.kind === "measurement_report") {
      expect(s.measurement?.squares).toBe(24);
      expect(s.measurement?.pitch).toBe("8/12");
      expect(s.measurement?.ridgeLf).toBe(40);
    } else { throw new Error("wrong kind"); }
  });

  it("low-confidence → status only, null entity", async () => {
    const map = await getDocumentParseSummaries({ tenantId, documentIds: [lowDocId] });
    const s = map[lowDocId]!;
    expect(s.status).toBe("unparsed_low_confidence");
    if (s.kind === "insurance_estimate") expect(s.claim).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @savvy/db test -- --run lead-document-parse-summaries`
Expected: FAIL — `getDocumentParseSummaries` not exported.

- [ ] **Step 3: Write minimal implementation**

Add to `packages/db/src/lifecycle/lead-documents.ts` (imports: add `claim` from `../schema/insurance`, and `DocParseSummary` from `@savvy/core`; `desc` is already imported):

```ts
import { claim } from "../schema/insurance";
import type { DocParseSummary } from "@savvy/core";

/**
 * Live parse summaries for the given documents (parseable kinds only), keyed by id.
 * insurance_estimate → the lead's newest claim; measurement_report → the property's
 * newest uploaded_report measurement. Status/confidence come from the document row.
 */
export async function getDocumentParseSummaries(input: {
  tenantId: string;
  documentIds: string[];
}): Promise<Record<string, DocParseSummary>> {
  if (input.documentIds.length === 0) return {};
  return withTenant(input.tenantId, async (tx) => {
    const docs = await tx
      .select({ id: document.id, kind: document.kind, leadId: document.leadId, propertyId: document.propertyId, parseStatus: document.parseStatus, parseConfidence: document.parseConfidence })
      .from(document)
      .where(inArray(document.id, input.documentIds));

    const out: Record<string, DocParseSummary> = {};
    for (const d of docs) {
      if (d.kind === "insurance_estimate") {
        let c: DocParseSummary extends { claim: infer C } ? C : never = null as never;
        if (d.parseStatus === "parsed" && d.leadId) {
          const [row] = await tx.select().from(claim).where(eq(claim.leadId, d.leadId)).orderBy(desc(claim.createdAt)).limit(1);
          if (row) {
            c = {
              id: row.id, carrierName: row.carrierName, claimNumber: row.claimNumber,
              acvCents: row.acvCents, rcvCents: row.rcvCents, deductibleCents: row.deductibleCents,
              lineItemCount: Array.isArray(row.lineItems) ? row.lineItems.length : 0,
            } as never;
          }
        }
        out[d.id] = { kind: "insurance_estimate", status: d.parseStatus, confidence: d.parseConfidence, claim: c };
      } else if (d.kind === "measurement_report") {
        let m: DocParseSummary extends { measurement: infer M } ? M : never = null as never;
        if (d.parseStatus === "parsed" && d.propertyId) {
          const [row] = await tx.select().from(measurement)
            .where(and(eq(measurement.propertyId, d.propertyId), eq(measurement.source, "uploaded_report")))
            .orderBy(desc(measurement.createdAt)).limit(1);
          if (row) {
            const a = (row.areas ?? {}) as Record<string, unknown>;
            const n = (k: string): number | null => (typeof a[k] === "number" ? (a[k] as number) : null);
            m = {
              id: row.id, squares: n("squares"), pitch: row.pitch,
              ridgeLf: n("ridgeLf"), hipLf: n("hipLf"), valleyLf: n("valleyLf"), eaveLf: n("eaveLf"), rakeLf: n("rakeLf"),
              facetCount: n("facetCount"), penetrationCount: n("penetrationCount"),
            } as never;
          }
        }
        out[d.id] = { kind: "measurement_report", status: d.parseStatus, confidence: d.parseConfidence, measurement: m };
      }
    }
    return out;
  });
}
```

> Note: the `infer`/`as never` dance keeps strict types without duplicating the union arms. If it reads awkwardly during implementation, prefer importing `ClaimSummary`/`MeasurementSummary` from `@savvy/core` and typing `c: ClaimSummary | null` / `m: MeasurementSummary | null` directly — both compile; the imported-type form is cleaner. Ensure `inArray` and `and` are imported from `drizzle-orm` in this file (add to the existing import).

Add `getDocumentParseSummaries` to the `packages/db/src/index.ts` barrel.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @savvy/db test -- --run lead-document-parse-summaries`
Expected: PASS (3 cases).

- [ ] **Step 5: Commit**

```bash
git add packages/db
git commit -m "feat(lead-docs): getDocumentParseSummaries live-join reader"
```

---

### Task 4: Extend `lead.doc_parse` evidence — no orphaned parsed docs

Per the spec, *extend* the existing invariant (not a new bound check — avoids CHECK_BINDINGS/bound-set churn): a `parsed` parseable doc with a null `r2_key` is a violation (nothing to view).

**Files:**
- Modify: `packages/core/src/verification/checks.ts` (the `lead.doc_parse` invariant, lines 128-137)
- Test: `packages/db/tests/lead-doc-evidence.test.ts` (update fixtures + add a red case)

**Interfaces:**
- Produces: no new symbol — the `lead.doc_parse` invariant now also flags `parse_status = 'parsed' AND r2_key IS NULL`.

- [ ] **Step 1: Write the failing test**

Edit `packages/db/tests/lead-doc-evidence.test.ts`:
1. Give the CLEAN parsed doc an `r2Key` so it stays clean under the new rule — line 33 becomes:
```ts
{ tenantId: cleanId, leadId: cl.leadId, propertyId: cl.propertyId, kind: "measurement_report", parseStatus: "parsed", r2Key: "clean-key", createdAt: HOURS(2) },
```
2. Add a BAD orphan doc to the `badId` fixture (after line 39):
```ts
await adminDb.insert(document).values({ tenantId: badId, leadId: bl.leadId, propertyId: bl.propertyId, kind: "measurement_report", parseStatus: "parsed", r2Key: null, createdAt: HOURS(2) });
```
3. Add an explicit orphan case in the `describe` block:
```ts
it("lead.doc_parse: flags a parsed doc with a null r2_key (orphan)", async () => {
  const r = await run("lead.doc_parse", badId);
  expect(r.status).toBe("fail");
  // both the stuck-pending doc and the orphan parsed doc are cited
  expect(r.refs.length).toBeGreaterThanOrEqual(2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @savvy/db test -- --run lead-doc-evidence`
Expected: FAIL — current SQL only flags stuck-pending; the orphan case expects ≥2 refs but gets 1, and (once the clean parsed doc's r2Key rule is active) the clean assertion would break if the SQL flagged it — confirming the invariant needs the new clause and the fixture needs the key.

- [ ] **Step 3: Write minimal implementation**

Replace the `lead.doc_parse` invariant SQL in `packages/core/src/verification/checks.ts` (lines 128-137) with a union of the stall and orphan conditions:

```ts
  // Every typed lead document reaches a terminal parse state within 1h (`pending` past 1h
  // is a stall). Additionally, a `parsed` typed doc must have a storage object — a parsed
  // row with a null r2_key is an orphan the viewer cannot resolve.
  "lead.doc_parse": invariant(
    "lead.doc_parse",
    `select id
       from document
      where tenant_id = $1
        and kind in ('insurance_estimate', 'measurement_report')
        and (
          (created_at < now() - interval '1 hour' and parse_status = 'pending')
          or (parse_status = 'parsed' and r2_key is null)
        )`,
    { toRef: (r) => ({ type: "document", ref: String(r.id) }) },
  ),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @savvy/db test -- --run lead-doc-evidence`
Expected: PASS — clean tenant still passes (parsed doc now has a key), bad tenant fails with ≥2 refs.

- [ ] **Step 5: Commit**

```bash
git add packages/core packages/db
git commit -m "feat(lead-docs): extend lead.doc_parse to flag orphaned parsed docs"
```

---

### Task 5: View resolver + same-origin proxy route

**Files:**
- Modify: `packages/db/src/lifecycle/lead-documents.ts` (`getDocumentForView`)
- Modify: `packages/db/src/index.ts` (barrel)
- Create: `apps/web/src/app/api/documents/[documentId]/view/route.ts`
- Test: `packages/db/tests/lead-document-view-resolver.test.ts` (new)

**Interfaces:**
- Produces: `getDocumentForView(tenantId: string, documentId: string): Promise<{ r2Key: string | null; mime: string | null; filename: string | null } | null>` — tenant-scoped (RLS); returns `null` for a foreign-tenant or unknown id.

- [ ] **Step 1: Write the failing test (red path #1 — cross-tenant rejected)**

Create `packages/db/tests/lead-document-view-resolver.test.ts`:

```ts
import { beforeAll, afterAll, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDocumentForView } from "../src/index.js";
import { adminDb, adminPool } from "../src/admin-client.js";
import { tenant, customer, property, lead, document } from "../src/schema/index.js";

let tenantA: string, tenantB: string, docId: string;

beforeAll(async () => {
  const [a] = await adminDb.insert(tenant).values({ name: "VA", publicKey: `va-${Date.now()}`, clerkOrgId: `org_va_${Date.now()}` }).returning();
  const [b] = await adminDb.insert(tenant).values({ name: "VB", publicKey: `vb-${Date.now()}`, clerkOrgId: `org_vb_${Date.now()}` }).returning();
  tenantA = a!.id; tenantB = b!.id;
  const [c] = await adminDb.insert(customer).values({ tenantId: tenantA, name: "c" }).returning();
  const [p] = await adminDb.insert(property).values({ tenantId: tenantA, customerId: c!.id, address: `a-${crypto.randomUUID()}` }).returning();
  const [l] = await adminDb.insert(lead).values({ tenantId: tenantA, customerId: c!.id, propertyId: p!.id, source: "t", status: "new" }).returning();
  const [d] = await adminDb.insert(document).values({ tenantId: tenantA, leadId: l!.id, propertyId: p!.id, kind: "insurance_estimate", r2Key: "tenantA/lead/x/file.pdf", mime: "application/pdf", filename: "file.pdf" }).returning();
  docId = d!.id;
});

afterAll(async () => {
  for (const t of [tenantA, tenantB]) {
    await adminDb.delete(document).where(eq(document.tenantId, t));
    await adminDb.delete(lead).where(eq(lead.tenantId, t));
    await adminDb.delete(property).where(eq(property.tenantId, t));
    await adminDb.delete(customer).where(eq(customer.tenantId, t));
    await adminDb.delete(tenant).where(eq(tenant.id, t));
  }
  await adminPool.end();
});

it("resolves own-tenant doc", async () => {
  const r = await getDocumentForView(tenantA, docId);
  expect(r?.r2Key).toBe("tenantA/lead/x/file.pdf");
  expect(r?.mime).toBe("application/pdf");
});

it("returns null for a cross-tenant doc id (RLS) — RED PATH #1", async () => {
  const r = await getDocumentForView(tenantB, docId);
  expect(r).toBeNull();
});

it("returns null for an unknown id", async () => {
  const r = await getDocumentForView(tenantA, crypto.randomUUID());
  expect(r).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @savvy/db test -- --run lead-document-view-resolver`
Expected: FAIL — `getDocumentForView` not exported.

- [ ] **Step 3: Write minimal implementation**

Add to `packages/db/src/lifecycle/lead-documents.ts`:

```ts
/** Tenant-scoped view metadata for a document (RLS blocks cross-tenant). Null if absent. */
export async function getDocumentForView(
  tenantId: string,
  documentId: string,
): Promise<{ r2Key: string | null; mime: string | null; filename: string | null } | null> {
  return withTenant(tenantId, async (tx) => {
    const [d] = await tx
      .select({ r2Key: document.r2Key, mime: document.mime, filename: document.filename })
      .from(document)
      .where(eq(document.id, documentId));
    return d ?? null;
  });
}
```

Add to the `packages/db/src/index.ts` barrel.

Create `apps/web/src/app/api/documents/[documentId]/view/route.ts`:

```ts
import { getDocumentForView } from "@savvy/db";
import { r2Storage } from "@savvy/integrations";
import { getTenantId } from "@/lib/tenant";

export const runtime = "nodejs";

// Same-origin document viewer. The browser URL carries only the doc UUID — no R2 key,
// no filename, no PII. Tenant is resolved from the session; RLS blocks cross-tenant ids
// (→ 404). The R2 object is presigned + streamed server-side; the presigned URL never
// reaches the browser.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ documentId: string }> },
): Promise<Response> {
  const { documentId } = await params;
  const url = new URL(_req.url);
  const download = url.searchParams.get("download") === "1";

  const tenantId = await getTenantId();
  const doc = await getDocumentForView(tenantId, documentId);
  if (!doc || !doc.r2Key) return new Response("Not found", { status: 404 });

  let signed: string;
  try {
    ({ url: signed } = await r2Storage.presignDownload({ key: doc.r2Key }));
  } catch {
    return new Response("Storage not configured", { status: 404 });
  }

  const upstream = await fetch(signed);
  if (!upstream.ok || !upstream.body) return new Response("Not found", { status: 404 });

  const safe = (doc.filename ?? "document").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
  const headers = new Headers();
  headers.set("Content-Type", doc.mime ?? "application/octet-stream");
  headers.set("Content-Disposition", `${download ? "attachment" : "inline"}; filename="${safe}"`);
  headers.set("Cache-Control", "private, no-store");
  const len = upstream.headers.get("content-length");
  if (len) headers.set("Content-Length", len);
  return new Response(upstream.body, { status: 200, headers });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @savvy/db test -- --run lead-document-view-resolver` and `pnpm -w typecheck`
Expected: PASS (resolver, incl. cross-tenant null) and typecheck clean (route compiles).

- [ ] **Step 5: Commit**

```bash
git add packages/db apps/web/src/app/api/documents
git commit -m "feat(lead-docs): same-origin document view route + tenant-scoped resolver"
```

---

### Task 6: `reparseDocument` action + confirmed-guard red path

**Files:**
- Modify: `apps/web/src/lib/document-actions.ts` (add `reparseDocument`)
- Test: `packages/db/tests/attach-lead-claim.test.ts` (add the re-parse-no-clobber assertion; file exists)

**Interfaces:**
- Produces: `reparseDocument(documentId: string): Promise<{ ok: true } | { error: "not_found" | "not_parseable" }>` (server action).

- [ ] **Step 1: Write the failing test (red path #3 — re-parse cannot clobber confirmed claim fields)**

Add to `packages/db/tests/attach-lead-claim.test.ts` (reuse that file's fixture helpers/imports; it already exercises `attachOrCreateLeadClaim`):

```ts
it("re-parse cannot clobber human-confirmed claim fields (RED PATH #3)", async () => {
  const { tenantId, leadId, propertyId } = await mkLeadFixture(); // existing helper in this file
  // First parse populates the claim.
  await attachOrCreateLeadClaim({ tenantId, leadId, propertyId, carrierName: "Parsed Co", claimNumber: "P-1", acvCents: 111, rcvCents: 222, deductibleCents: 100, lineItems: [{}], parseConfidence: 0.9 });
  // Human confirms/edits carrier + acv on the claim.
  await adminDb.update(claim).set({ carrierName: "Human Co", acvCents: 999 }).where(eq(claim.leadId, leadId));
  // Re-parse with DIFFERENT extracted values.
  await attachOrCreateLeadClaim({ tenantId, leadId, propertyId, carrierName: "Parsed Again", claimNumber: "P-2", acvCents: 555, rcvCents: 777, deductibleCents: 50, lineItems: [{}, {}, {}], parseConfidence: 0.95 });
  const [row] = await adminDb.select().from(claim).where(eq(claim.leadId, leadId));
  expect(row!.carrierName).toBe("Human Co"); // confirmed value preserved
  expect(row!.acvCents).toBe(999);           // confirmed value preserved
  expect(Array.isArray(row!.lineItems) ? row!.lineItems.length : 0).toBe(3); // lineItems refreshed
  expect(row!.parseConfidence).toBe(0.95);   // confidence refreshed
});
```

If `mkLeadFixture` isn't the exact helper name in that file, use whatever tenant+lead+property helper it already defines; the assertion is the point.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @savvy/db test -- --run attach-lead-claim`
Expected: The assertion PASSES against the existing coalesce guard (it documents/locks the behavior). If it unexpectedly fails, the guard regressed — stop and investigate before adding the action. (This is a guard-lock test; the action in Step 3 relies on it.)

- [ ] **Step 3: Write the action**

Add to `apps/web/src/lib/document-actions.ts` (imports already include `withTenant`, `document`, `eq`, `getCurrentUser`, `inngest`, `PARSEABLE_KINDS`, `revalidatePath` — add any missing):

```ts
/**
 * Re-run the parse pipeline for one parseable document. Sets the doc back to `pending`
 * (instant "Parsing…" feedback), then re-emits `lead-document/received`. Idempotent: the
 * fail-soft handler coalesce-guards confirmed claim fields and upserts the measurement.
 */
export async function reparseDocument(
  documentId: string,
): Promise<{ ok: true } | { error: "not_found" | "not_parseable" }> {
  const { tenantId } = await getCurrentUser();
  const doc = await withTenant(tenantId, async (tx) => {
    const [d] = await tx
      .select({ id: document.id, kind: document.kind, leadId: document.leadId })
      .from(document)
      .where(eq(document.id, documentId));
    return d;
  });
  if (!doc) return { error: "not_found" };
  if (!(PARSEABLE_KINDS as readonly string[]).includes(doc.kind)) return { error: "not_parseable" };

  await withTenant(tenantId, (tx) =>
    tx.update(document).set({ parseStatus: "pending", parseConfidence: null }).where(eq(document.id, documentId)),
  );
  await inngest.send({
    name: "lead-document/received",
    data: { tenantId, documentId, leadId: doc.leadId, kind: doc.kind },
  }).catch(() => {});
  if (doc.leadId) revalidatePath(`/leads/${doc.leadId}`);
  return { ok: true };
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm --filter @savvy/db test -- --run attach-lead-claim` and `pnpm -w typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/db apps/web/src/lib/document-actions.ts
git commit -m "feat(lead-docs): reparseDocument action + confirmed-field guard lock"
```

---

### Task 7: `DocViewer` shared lightbox component

No jsdom test infra in `apps/web` — this component's verification is typecheck + lint here and Playwright e2e in Task 10.

**Files:**
- Create: `apps/web/src/components/DocViewer.tsx`

**Interfaces:**
- Produces:
  - `type ViewerDoc = { id: string; filename: string | null; mime: string | null; uploaderName?: string | null; createdAt: string | Date }`
  - `function DocViewer({ doc, onClose }: { doc: ViewerDoc | null; onClose: () => void }): JSX.Element | null`

- [ ] **Step 1: Create the component**

Create `apps/web/src/components/DocViewer.tsx`:

```tsx
"use client";
import { useEffect } from "react";

export interface ViewerDoc {
  id: string;
  filename: string | null;
  mime: string | null;
  uploaderName?: string | null;
  createdAt: string | Date;
}

function fmt(d: string | Date): string {
  return new Date(d).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/**
 * Modal document viewer. PDFs render in a same-origin iframe, images inline, anything else
 * offers a download. The view URL is our proxy route (/api/documents/{id}/view) — no R2
 * key or PII in the browser. Header shows filename · uploader · date.
 */
export function DocViewer({ doc, onClose }: { doc: ViewerDoc | null; onClose: () => void }): React.JSX.Element | null {
  useEffect(() => {
    if (!doc) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [doc, onClose]);

  if (!doc) return null;
  const src = `/api/documents/${doc.id}/view`;
  const isPdf = doc.mime === "application/pdf";
  const isImage = (doc.mime ?? "").startsWith("image/");

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Document ${doc.filename ?? ""}`}
      onClick={onClose}
      className="fixed inset-0 z-50 flex flex-col"
      style={{ background: "color-mix(in srgb, var(--surface) 80%, transparent)" }}
      data-testid="doc-viewer"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="mx-auto my-6 flex h-[90vh] w-[min(1000px,94vw)] flex-col overflow-hidden rounded-lg border shadow-lg"
        style={{ borderColor: "var(--border)", background: "var(--surface)" }}
      >
        <div className="flex items-center justify-between gap-3 border-b px-4 py-2" style={{ borderColor: "var(--border)" }}>
          <div className="min-w-0">
            <div className="truncate font-medium">{doc.filename ?? "(unnamed)"}</div>
            <div className="mono text-xs" style={{ color: "var(--text-faint)" }}>
              {doc.uploaderName ?? "system"} · {fmt(doc.createdAt)}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <a href={`${src}?download=1`} className="rounded border px-2 py-1 text-sm" style={{ borderColor: "var(--border)" }}>Download</a>
            <button onClick={onClose} aria-label="Close" className="rounded border px-2 py-1 text-sm" style={{ borderColor: "var(--border)" }}>✕</button>
          </div>
        </div>
        <div className="flex-1 overflow-auto" style={{ background: "var(--surface-muted)" }}>
          {isPdf ? (
            <iframe src={src} title={doc.filename ?? "document"} className="h-full w-full" style={{ border: "none" }} />
          ) : isImage ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={src} alt={doc.filename ?? "document"} className="mx-auto max-h-full max-w-full object-contain" />
          ) : (
            <div className="flex h-full items-center justify-center">
              <a href={`${src}?download=1`} className="rounded border px-3 py-2 text-sm" style={{ borderColor: "var(--border)" }}>
                Download {doc.filename ?? "file"}
              </a>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck + lint**

Run: `pnpm -w typecheck && pnpm -w lint`
Expected: PASS. (If `React.JSX.Element` is rejected by the repo's React types, use `import type { JSX } from "react"` and return `JSX.Element | null` — match whatever other components in `apps/web/src/components` use.)

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/DocViewer.tsx
git commit -m "feat(lead-docs): DocViewer shared lightbox"
```

---

### Task 8: Wire LeadDocsCard (view + parse panel + re-parse) and lead page

**Files:**
- Modify: `apps/web/src/app/(app)/leads/[id]/LeadDocsCard.tsx`
- Modify: `apps/web/src/app/(app)/leads/[id]/page.tsx`

**Interfaces:**
- Consumes: `getDocumentParseSummaries` (Task 3), `parseSummaryView` + `DocParseSummary` (Task 2), `DocViewer`/`ViewerDoc` (Task 7), `reparseDocument` (Task 6).
- Produces: `LeadDocsCard` now takes an added prop `parseSummaries: Record<string, DocParseSummary>`.

- [ ] **Step 1: Fetch summaries in the page**

In `apps/web/src/app/(app)/leads/[id]/page.tsx`:
- Add `getDocumentParseSummaries` to the `@savvy/db` import.
- After `documents` resolves, compute summaries and pass them down. Replace the `Promise.all` destructure to also compute summaries (documents is needed first for the ids), e.g. after the `Promise.all`:

```ts
const parseSummaries = await getDocumentParseSummaries({
  tenantId,
  documentIds: documents.filter((d) => d.kind === "insurance_estimate" || d.kind === "measurement_report").map((d) => d.id),
});
```
- Update the render: `<LeadDocsCard leadId={detail.id} documents={documents} parseSummaries={parseSummaries} />`.

- [ ] **Step 2: Extend LeadDocsCard**

Rewrite `apps/web/src/app/(app)/leads/[id]/LeadDocsCard.tsx`'s imports and body to add: (a) a "View" button per doc opening `DocViewer`; (b) the parse panel via `parseSummaryView`; (c) a "Re-run parse" button per parseable doc. Add near the top:

```tsx
import { DocViewer, type ViewerDoc } from "@/components/DocViewer";
import { parseSummaryView, type DocParseSummary } from "@savvy/core";
import { reparseDocument } from "@/lib/document-actions";
```

Change the signature:

```tsx
export function LeadDocsCard({ leadId, documents, parseSummaries }: {
  leadId: string;
  documents: LeadDocumentRow[];
  parseSummaries: Record<string, DocParseSummary>;
}) {
  const router = useRouter();
  const [viewing, setViewing] = useState<ViewerDoc | null>(null);
  // …existing state (kind, busy, dragOver, inputRef)…
```

Add a re-parse handler inside the component:

```tsx
  async function reparse(docId: string) {
    const res = await reparseDocument(docId);
    if ("ok" in res) { toast.success("Re-parsing…"); router.refresh(); }
    else toast.error(`Re-parse failed: ${res.error}`);
  }
```

Replace each document `<li>` (lines 116-130) with a richer row that keeps the existing filename/meta/status pill and adds View, the parse panel, and Re-run:

```tsx
{documents.map((d) => {
  const summary = parseSummaries[d.id];
  const view = summary ? parseSummaryView(summary) : null;
  const parseable = d.kind === "insurance_estimate" || d.kind === "measurement_report";
  return (
    <li key={d.id} className="rounded border p-2 text-sm" style={{ borderColor: "var(--border)" }}>
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate font-medium">{d.filename ?? "(unnamed)"}</div>
          <div className="mono text-xs" style={{ color: "var(--text-faint)" }}>
            {KIND_LABELS[d.kind] ?? d.kind} · {d.uploaderName ?? "system"} · {fmtTime(d.createdAt)}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            className="rounded border px-2 py-0.5 text-xs" style={{ borderColor: "var(--border)" }}
            onClick={() => setViewing({ id: d.id, filename: d.filename, mime: d.mime, uploaderName: d.uploaderName, createdAt: d.createdAt })}
            data-testid={`view-doc-${d.id}`}
          >View</button>
          {parseable && (
            <button className="rounded border px-2 py-0.5 text-xs" style={{ borderColor: "var(--border)" }} onClick={() => void reparse(d.id)}>
              Re-run parse
            </button>
          )}
          <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium" style={{ background: "var(--surface-muted)", color: "var(--text-muted)" }}>
            {PARSE_LABELS[d.parseStatus] ?? d.parseStatus}
          </span>
        </div>
      </div>
      {view && (
        <div className="mt-2 rounded border p-2" style={{ borderColor: "var(--border)", background: "var(--surface-muted)" }} data-testid={`parse-panel-${d.id}`}>
          <div className="text-xs font-medium" style={{ color: view.tone === "low" || view.tone === "failed" ? "var(--text-muted)" : "var(--text-body)" }}>
            {view.headline}
          </div>
          {view.rows.length > 0 && (
            <dl className="mt-1 grid grid-cols-2 gap-x-4 gap-y-0.5 text-xs">
              {view.rows.map((r) => (
                <div key={r.label} className="flex justify-between gap-2">
                  <dt style={{ color: "var(--text-faint)" }}>{r.label}</dt>
                  <dd className="font-medium">{r.value}</dd>
                </div>
              ))}
            </dl>
          )}
          {view.entityLink?.kind === "measurement" && (
            <a href={`/leads/${leadId}/measure`} className="mt-1 inline-block text-xs underline" style={{ color: "var(--text-muted)" }}>View measurement</a>
          )}
        </div>
      )}
    </li>
  );
})}
```

Mount the viewer once, before the closing `</Card>`:

```tsx
      <DocViewer doc={viewing} onClose={() => setViewing(null)} />
```

- [ ] **Step 3: Typecheck + lint**

Run: `pnpm -w typecheck && pnpm -w lint`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add "apps/web/src/app/(app)/leads/[id]/LeadDocsCard.tsx" "apps/web/src/app/(app)/leads/[id]/page.tsx"
git commit -m "feat(lead-docs): viewer + parse panel + re-parse on the lead docs card"
```

---

### Task 9: Adopt DocViewer + parse panel on the job DocsPanel

Carried-onto-job parseable docs get the same view + parse surface.

**Files:**
- Modify: `apps/web/src/app/(app)/jobs/[id]/DocsPanel.tsx`
- Modify: `apps/web/src/app/(app)/jobs/[id]/page.tsx`

**Interfaces:**
- Consumes: `getDocumentParseSummaries`, `parseSummaryView`, `DocViewer`, `reparseDocument`.
- Produces: `DocsPanel` gains a `parseSummaries: Record<string, DocParseSummary>` prop; `DocRow` gains `parseStatus: string`.

- [ ] **Step 1: Fetch summaries + widen the doc select in the job page**

In `apps/web/src/app/(app)/jobs/[id]/page.tsx`: include `parseStatus` in the documents select (so the panel can show it), add `getDocumentParseSummaries` to the `@savvy/db` import, compute summaries for parseable docs, and pass `parseSummaries` into `<DocsPanel …>`. Mirror the lead-page snippet from Task 8 Step 1.

- [ ] **Step 2: Wire DocsPanel**

In `apps/web/src/app/(app)/jobs/[id]/DocsPanel.tsx`:
- Add imports:
```tsx
import { DocViewer, type ViewerDoc } from "@/components/DocViewer";
import { parseSummaryView, type DocParseSummary } from "@savvy/core";
import { reparseDocument } from "@/lib/document-actions";
```
- Add `parseStatus: string;` to the `DocRow` interface and `parseSummaries: Record<string, DocParseSummary>;` to `Props`; destructure it in the component.
- Add `const [viewing, setViewing] = useState<ViewerDoc | null>(null);` and mount `<DocViewer doc={viewing} onClose={() => setViewing(null)} />` at the end of the returned tree.
- In the non-photo docs section, replace the `<DocFile …>` usage so its "View" opens the lightbox instead of `window.open`, and render the parse panel + a "Re-run parse" button for parseable kinds. Replace the `DocFile` component body's button `onClick` with `() => onView()` and thread an `onView` prop, or inline the row:

```tsx
{nonPhotos.map((doc) => {
  const summary = parseSummaries[doc.id];
  const view = summary ? parseSummaryView(summary) : null;
  const parseable = doc.kind === "insurance_estimate" || doc.kind === "measurement_report";
  return (
    <div key={doc.id} className="rounded-md border border-border p-2 text-sm">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-muted-foreground">{doc.filename ?? "file"}</span>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setViewing({ id: doc.id, filename: doc.filename, mime: doc.mime, createdAt: doc.createdAt })}>View</Button>
          {parseable && (
            <Button variant="outline" size="sm" onClick={async () => { const r = await reparseDocument(doc.id); if ("ok" in r) { toast.success("Re-parsing…"); router.refresh(); } else toast.error(`Re-parse failed: ${r.error}`); }}>
              Re-run parse
            </Button>
          )}
        </div>
      </div>
      {view && view.rows.length > 0 && (
        <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-0.5 text-xs">
          {view.rows.map((r) => (
            <div key={r.label} className="flex justify-between gap-2">
              <dt className="text-muted-foreground">{r.label}</dt><dd className="font-medium">{r.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {view && view.rows.length === 0 && <p className="mt-1 text-xs text-muted-foreground">{view.headline}</p>}
    </div>
  );
})}
```

Keep the existing `DocThumb` (photos) and CompanyCam branches unchanged. The now-unused `DocFile` component may be removed if nothing else references it (grep first).

- [ ] **Step 3: Typecheck + lint**

Run: `pnpm -w typecheck && pnpm -w lint`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add "apps/web/src/app/(app)/jobs/[id]/DocsPanel.tsx" "apps/web/src/app/(app)/jobs/[id]/page.tsx"
git commit -m "feat(lead-docs): adopt DocViewer + parse panel on the job docs panel"
```

---

### Task 10: E2E coverage + full verification + prod check

**Files:**
- Modify: `apps/web/tests/e2e/lead-documents.spec.ts`

- [ ] **Step 1: Extend the e2e spec**

Add a test (follow the existing spec's tenant/session setup) that, after a parseable doc is uploaded and rendered in `[data-testid="lead-docs-card"]`:
- clicks its `View` button (`[data-testid^="view-doc-"]`), asserts `[data-testid="doc-viewer"]` is visible and the header shows the filename, then closes it (Escape);
- clicks "Re-run parse" and asserts a toast / that the row re-enters a pending/parsed state.

Keep assertions resilient to Inngest async (assert the button works + status pill exists rather than a specific post-parse value). If the e2e stubs storage (TEST_MODE), the iframe body won't load a real PDF — assert the viewer chrome + header, not PDF contents.

- [ ] **Step 2: Run the full verification suite**

```bash
pnpm -w typecheck
pnpm -w lint
pnpm --filter @savvy/core test -- --run doc-parse-summary
pnpm --filter @savvy/db test -- --run lead-document-parse-helpers --run lead-document-parse-summaries --run lead-document-view-resolver --run lead-doc-evidence --run attach-lead-claim
pnpm --filter @savvy/agents test -- --run parse-lead-document
```
Expected: all green (ignore any `health-sweep.test.ts` shared-DB teardown FK flake).

- [ ] **Step 3: Live prod verification (state result in the PR)**

Sign in as a **Bloom** user on the deployed app, open the lead with the test insurance estimate, click **View** (PDF renders in the lightbox with the filename/uploader/date header), confirm the parse panel shows carrier/claim#/ACV/RCV/deductible/line-item count beside it, then click **Re-run parse** and confirm the confirmed fields are unchanged. Record the outcome in the PR body.

- [ ] **Step 4: Commit + open PR**

```bash
git add apps/web/tests/e2e/lead-documents.spec.ts
git commit -m "test(lead-docs): e2e view + re-parse coverage"
```
Then open the PR against `main` with a summary of the three capabilities, the red-path tests, and the live prod verification result.

---

## Self-Review

**Spec coverage:**
- Click-to-view every doc (PDF/image/other, header) → Tasks 5 (route), 7 (viewer), 8 (lead), 9 (job). ✓
- Short-lived presigned R2 GET, no public URL, no PII in URL → Task 5 (proxy route; presign server-side only). ✓
- Parse Result panel (carrier/claim#/ACV/RCV/deductible/line-item count | squares/pitch/LF; confidence; entity link) → Tasks 2 (mapper), 3 (reader), 8/9 (render). ✓
- Un-parsed / low-confidence status surface → Task 2 (`"Stored, unparsed — card open"`) + Task 3 (null entity). ✓
- Re-parse action, idempotent, confirmed-guard → Task 6 (action) + Task 1 (measurement upsert idempotency) + Task 6 red-path #3. ✓
- Evidence: extend `lead.doc_parse`, no orphaned R2 keys → Task 4. ✓
- Works for docs carried onto the job → Task 9. ✓
- Red paths: expired/cross-tenant rejected (adapted → resolver cross-tenant 404, Task 5), low-confidence render (Task 2), re-parse no-clobber (Task 6). ✓
- Live prod verify as Bloom user → Task 10 Step 3. ✓

**Placeholder scan:** No TBD/TODO; every code step shows full code. The one judgment call (the `infer`/`as never` typing in Task 3) has an explicit simpler alternative. ✓

**Type consistency:** `DocParseSummary`/`ClaimSummary`/`MeasurementSummary` defined in Task 2 and consumed by name in Tasks 3, 8, 9. `parseSummaryView`/`ParseView` consistent. `getDocumentParseSummaries` signature identical across Tasks 3, 8, 9. `ViewerDoc`/`DocViewer` from Task 7 used in 8, 9. `reparseDocument` return shape consistent across 6, 8, 9. ✓
