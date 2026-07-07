# Slice 6a — Lead Document Storage, Upload & Timeline — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users upload typed documents (insurance estimates, measurement reports, photos, contracts) onto a lead, store them lead-scoped in R2, record uploader + a timeline event, and carry them onto the job at conversion — no parsing yet (that is 6b/6c).

**Architecture:** Extend the existing unified `document` table with lead scope + uploader + parse-status columns (additive migration). A pure media-policy validator in `@savvy/core` enforces the 25 MB cap, mime allow-list, and PDF-only rule for parseable kinds. A new `lead-documents` lifecycle module records/lists docs (writing an `audit_log` timeline row and superseding prior single-slot docs). Two server actions wrap the existing R2 presigned-PUT flow for the lead path. `convertLeadToJob` carries lead-scoped docs onto the job. A new `LeadDocsCard` client component renders the card on the lead tile.

**Tech Stack:** Next.js App Router + TypeScript, Drizzle ORM + Postgres (RLS), Cloudflare R2 (presigned PUT via `@aws-sdk/client-s3`), shadcn/ui, Vitest (unit/integration), Playwright (e2e). pnpm + Turborepo monorepo.

## Global Constraints

- **Branch:** `slice6-lead-documents`, stacked on `leads-stage-overhaul`. All work commits here.
- **Tenant isolation:** every table has `tenant_id`; every query goes through `withTenant(tenantId, tx => …)` or `adminDb` (fixtures only). New columns must not bypass RLS.
- **No hard-coded model/provider in feature code** (N/A here — no AI in 6a, but do not add any).
- **AI/async is Inngest** (N/A in 6a; parse triggers land in 6b/6c).
- **No secrets in repo**; R2 config already lives in env via `@savvy/integrations`.
- **Every task ships tests + passes `pnpm typecheck` and `pnpm lint` before commit.**
- **ESM test imports use `.js` extensions** (e.g. `from "../src/index.js"`) — this repo compiles ESM.
- **Money is integer cents** (N/A in 6a).
- **Migration numbering:** this is the first Slice-6 migration; `pnpm db:generate` will produce `0063_*.sql` on top of Slice 1's `0062`.

---

### Task 1: Media policy validator (`@savvy/core`, pure)

Pure, DB-free validation shared by the server actions and (later) the parse router. Implements the #341 media policy that has never landed in code.

**Files:**
- Create: `packages/core/src/media-policy.ts`
- Create: `packages/core/src/media-policy.test.ts`
- Modify: `packages/core/src/index.ts` (add barrel export)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `MAX_UPLOAD_BYTES: number` (26_214_400)
  - `ALLOWED_UPLOAD_MIME: readonly string[]`
  - `PARSEABLE_KINDS: readonly ["insurance_estimate", "measurement_report"]`; `type ParseableKind`
  - `type UploadValidationError = "too_large" | "mime_not_allowed" | "typed_requires_pdf"`
  - `validateUpload(input: { kind: string; mime: string; sizeBytes: number }): { ok: true } | { ok: false; error: UploadValidationError }`

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/media-policy.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { validateUpload, MAX_UPLOAD_BYTES, PARSEABLE_KINDS } from "./media-policy";

describe("validateUpload", () => {
  it("accepts a PDF insurance_estimate under the cap", () => {
    expect(validateUpload({ kind: "insurance_estimate", mime: "application/pdf", sizeBytes: 1_000 }))
      .toEqual({ ok: true });
  });

  it("accepts an image for a photo kind", () => {
    expect(validateUpload({ kind: "photo", mime: "image/jpeg", sizeBytes: 1_000 }))
      .toEqual({ ok: true });
  });

  it("rejects a file over the 25MB cap", () => {
    expect(validateUpload({ kind: "photo", mime: "image/jpeg", sizeBytes: MAX_UPLOAD_BYTES + 1 }))
      .toEqual({ ok: false, error: "too_large" });
  });

  it("rejects a disallowed mime type", () => {
    expect(validateUpload({ kind: "other", mime: "application/zip", sizeBytes: 1_000 }))
      .toEqual({ ok: false, error: "mime_not_allowed" });
  });

  it("rejects a non-PDF upload for a parseable kind", () => {
    expect(validateUpload({ kind: "measurement_report", mime: "image/jpeg", sizeBytes: 1_000 }))
      .toEqual({ ok: false, error: "typed_requires_pdf" });
    expect(PARSEABLE_KINDS).toContain("measurement_report");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/src/media-policy.test.ts`
Expected: FAIL — cannot resolve `./media-policy`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/core/src/media-policy.ts`:

```ts
/** #341 media policy — shared upload validation (pure, no DB). */

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25 MB/doc

export const ALLOWED_UPLOAD_MIME = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
] as const;

/** Typed lead-document kinds that feed the parse pipeline (6b/6c). PDF-only. */
export const PARSEABLE_KINDS = ["insurance_estimate", "measurement_report"] as const;
export type ParseableKind = (typeof PARSEABLE_KINDS)[number];

export type UploadValidationError = "too_large" | "mime_not_allowed" | "typed_requires_pdf";

export function validateUpload(input: {
  kind: string;
  mime: string;
  sizeBytes: number;
}): { ok: true } | { ok: false; error: UploadValidationError } {
  if (input.sizeBytes > MAX_UPLOAD_BYTES) return { ok: false, error: "too_large" };
  if (!(ALLOWED_UPLOAD_MIME as readonly string[]).includes(input.mime)) {
    return { ok: false, error: "mime_not_allowed" };
  }
  if ((PARSEABLE_KINDS as readonly string[]).includes(input.kind) && input.mime !== "application/pdf") {
    return { ok: false, error: "typed_requires_pdf" };
  }
  return { ok: true };
}
```

Add the barrel export to `packages/core/src/index.ts` (append after the existing `export * from` lines):

```ts
export * from "./media-policy";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/core/src/media-policy.test.ts`
Expected: PASS (5 passing).

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @savvy/core typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/media-policy.ts packages/core/src/media-policy.test.ts packages/core/src/index.ts
git commit -m "feat(core): media-policy upload validator (#341) for slice 6a"
```

---

### Task 2: Document schema — lead scope + uploader + parse status (migration 0063)

Additive columns on `document`. No backfill needed (all new columns nullable or defaulted).

**Files:**
- Modify: `packages/db/src/schema/ops.ts:1-38` (imports + `document` table)
- Create (generated): `packages/db/drizzle/0063_*.sql` + `packages/db/drizzle/meta/*` (via `pnpm db:generate`)
- Create: `packages/db/tests/lead-document-schema.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `document` table gains columns `leadId`, `propertyId`, `uploadedByUserId`, `parseStatus` (default `"pending"`), `parseConfidence`; index `document_tenant_lead_idx`.

- [ ] **Step 1: Write the failing test**

Create `packages/db/tests/lead-document-schema.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { adminDb, document, eq } from "../src/index.js";
import { makeTenant, makeLeadWithProperty, makeUser } from "./helpers.js";

describe("document lead-scope columns", () => {
  it("stores a lead-scoped document with uploader and defaults parse_status to pending", async () => {
    const { tenantId } = await makeTenant();
    const { leadId, propertyId } = await makeLeadWithProperty(tenantId);
    const { userId } = await makeUser(tenantId);

    const [row] = await adminDb
      .insert(document)
      .values({
        tenantId,
        leadId,
        propertyId,
        uploadedByUserId: userId,
        kind: "insurance_estimate",
        r2Key: `${tenantId}/lead/${leadId}/x.pdf`,
        filename: "estimate.pdf",
        mime: "application/pdf",
        sizeBytes: 1234,
        source: "savvy",
      })
      .returning();

    const [read] = await adminDb.select().from(document).where(eq(document.id, row!.id));
    expect(read!.leadId).toBe(leadId);
    expect(read!.propertyId).toBe(propertyId);
    expect(read!.uploadedByUserId).toBe(userId);
    expect(read!.parseStatus).toBe("pending");
    expect(read!.parseConfidence).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @savvy/db exec vitest run tests/lead-document-schema.test.ts`
Expected: FAIL — `column "lead_id" of relation "document" does not exist` (or a TS error on `leadId`).

- [ ] **Step 3: Edit the schema**

In `packages/db/src/schema/ops.ts`, update the crm import (line 5) to include `lead`:

```ts
import { customer, property, lead } from "./crm";
```

Inside the `document` table definition, update the `kind` comment and add the five columns (place them right after `kind`/`label`, before `r2Key`):

```ts
  kind: text("kind").notNull(), // photo|measurement|contract|lien_waiver|cert|evidence|other|insurance_estimate|measurement_report
  label: text("label"),
  // Slice 6a: lead-stage scope + uploader + parse lifecycle (parsing lands in 6b/6c).
  leadId: uuid("lead_id").references(() => lead.id),
  propertyId: uuid("property_id").references(() => property.id),
  uploadedByUserId: uuid("uploaded_by_user_id").references(() => user.id),
  parseStatus: text("parse_status").notNull().default("pending"), // pending|parsed|parse_failed|unparsed_low_confidence
  parseConfidence: doublePrecision("parse_confidence"),
```

Add the index to the table's index array (after `document_tenant_job_idx`):

```ts
  index("document_tenant_lead_idx").on(t.tenantId, t.leadId),
```

- [ ] **Step 4: Generate and apply the migration**

Run: `pnpm db:generate`
Expected: creates `packages/db/drizzle/0063_*.sql` adding the 5 columns + index, and updates `packages/db/drizzle/meta/`.

Run: `pnpm db:migrate`
Expected: `0063` applied to the local dev DB, no errors.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @savvy/db exec vitest run tests/lead-document-schema.test.ts`
Expected: PASS (1 passing).

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @savvy/db typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/db/src/schema/ops.ts packages/db/drizzle/ packages/db/tests/lead-document-schema.test.ts
git commit -m "feat(db): document gains lead scope + uploader + parse-status (0063, slice 6a)"
```

---

### Task 3: Lead document lifecycle (record + list + supersede + timeline)

The data-layer API the server actions call. Records a lead-scoped doc, writes an `audit_log` timeline row, and supersedes prior single-slot (parseable) docs. Lists active docs newest-first with uploader name.

**Files:**
- Create: `packages/db/src/lifecycle/lead-documents.ts`
- Modify: `packages/db/src/index.ts` (add export near the other lifecycle exports, ~line 41)
- Create: `packages/db/tests/lead-documents.test.ts`

**Interfaces:**
- Consumes: `PARSEABLE_KINDS` from `@savvy/core`; `document` (Task 2 columns); `auditLog`, `lead`, `user` schema.
- Produces:
  - `interface LeadDocumentRow { id: string; kind: string; filename: string | null; mime: string | null; sizeBytes: number | null; parseStatus: string; parseConfidence: number | null; uploaderName: string | null; createdAt: Date }`
  - `recordLeadDocument(input: { tenantId: string; leadId: string; r2Key: string; kind: string; filename: string; mime: string; sizeBytes: number; uploadedByUserId: string | null }): Promise<{ id: string } | null>` (null when the lead doesn't exist)
  - `listLeadDocuments(input: { tenantId: string; leadId: string }): Promise<LeadDocumentRow[]>`

- [ ] **Step 1: Write the failing test**

Create `packages/db/tests/lead-documents.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { recordLeadDocument, listLeadDocuments } from "../src/lifecycle/lead-documents.js";
import { adminDb, auditLog, eq, and } from "../src/index.js";
import { makeTenant, makeLeadWithProperty, makeUser } from "./helpers.js";

async function record(tenantId: string, leadId: string, kind: string, uploadedByUserId: string | null) {
  return recordLeadDocument({
    tenantId, leadId, uploadedByUserId,
    r2Key: `${tenantId}/lead/${leadId}/${crypto.randomUUID()}.pdf`,
    kind, filename: `${kind}.pdf`, mime: "application/pdf", sizeBytes: 2048,
  });
}

describe("recordLeadDocument / listLeadDocuments", () => {
  it("records a lead-scoped doc, defaults parse_status pending, and writes a timeline audit row", async () => {
    const { tenantId } = await makeTenant();
    const { leadId } = await makeLeadWithProperty(tenantId);
    const { userId } = await makeUser(tenantId);

    const res = await record(tenantId, leadId, "insurance_estimate", userId);
    expect(res).not.toBeNull();

    const docs = await listLeadDocuments({ tenantId, leadId });
    expect(docs).toHaveLength(1);
    expect(docs[0]!.kind).toBe("insurance_estimate");
    expect(docs[0]!.parseStatus).toBe("pending");
    expect(docs[0]!.uploaderName).toBe("Test User");

    const audits = await adminDb.select().from(auditLog).where(
      and(eq(auditLog.entityType, "lead"), eq(auditLog.entityId, leadId)),
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]!.action).toBe("document.uploaded");
  });

  it("returns null when the lead does not exist", async () => {
    const { tenantId } = await makeTenant();
    const res = await record(tenantId, crypto.randomUUID(), "other", null);
    expect(res).toBeNull();
  });

  it("supersedes a prior parseable doc of the same kind (only newest is listed)", async () => {
    const { tenantId } = await makeTenant();
    const { leadId } = await makeLeadWithProperty(tenantId);

    await record(tenantId, leadId, "measurement_report", null);
    await record(tenantId, leadId, "measurement_report", null);

    const docs = await listLeadDocuments({ tenantId, leadId });
    expect(docs).toHaveLength(1); // older one archived
  });

  it("does NOT supersede non-parseable kinds (photos stack)", async () => {
    const { tenantId } = await makeTenant();
    const { leadId } = await makeLeadWithProperty(tenantId);

    await record(tenantId, leadId, "photo", null);
    await record(tenantId, leadId, "photo", null);

    const docs = await listLeadDocuments({ tenantId, leadId });
    expect(docs).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @savvy/db exec vitest run tests/lead-documents.test.ts`
Expected: FAIL — cannot resolve `../src/lifecycle/lead-documents.js`.

- [ ] **Step 3: Write the implementation**

Create `packages/db/src/lifecycle/lead-documents.ts`:

```ts
import { withTenant } from "../tenant";
import { document } from "../schema/ops";
import { lead } from "../schema/crm";
import { auditLog } from "../schema/agents";
import { user } from "../schema/tenancy";
import { and, eq, isNull, desc } from "drizzle-orm";
import { PARSEABLE_KINDS } from "@savvy/core";

export interface LeadDocumentRow {
  id: string;
  kind: string;
  filename: string | null;
  mime: string | null;
  sizeBytes: number | null;
  parseStatus: string;
  parseConfidence: number | null;
  uploaderName: string | null;
  createdAt: Date;
}

/**
 * Record a lead-scoped document. Derives property/customer from the lead, writes a
 * `document.uploaded` audit_log timeline row, and supersedes a prior active doc of the
 * same PARSEABLE kind (single-slot). Returns null when the lead doesn't exist.
 */
export async function recordLeadDocument(input: {
  tenantId: string;
  leadId: string;
  r2Key: string;
  kind: string;
  filename: string;
  mime: string;
  sizeBytes: number;
  uploadedByUserId: string | null;
}): Promise<{ id: string } | null> {
  return withTenant(input.tenantId, async (tx) => {
    const [l] = await tx
      .select({ customerId: lead.customerId, propertyId: lead.propertyId })
      .from(lead)
      .where(eq(lead.id, input.leadId));
    if (!l) return null;

    // Supersede: a newer single-slot (parseable) doc archives the prior active one.
    if ((PARSEABLE_KINDS as readonly string[]).includes(input.kind)) {
      await tx
        .update(document)
        .set({ archivedAt: new Date() })
        .where(and(
          eq(document.leadId, input.leadId),
          eq(document.kind, input.kind),
          isNull(document.archivedAt),
        ));
    }

    const [row] = await tx
      .insert(document)
      .values({
        tenantId: input.tenantId,
        leadId: input.leadId,
        propertyId: l.propertyId ?? null,
        customerId: l.customerId ?? null,
        kind: input.kind,
        r2Key: input.r2Key,
        filename: input.filename,
        mime: input.mime,
        sizeBytes: input.sizeBytes,
        uploadedByUserId: input.uploadedByUserId,
        source: "savvy",
        parseStatus: "pending",
      })
      .returning({ id: document.id });

    await tx.insert(auditLog).values({
      tenantId: input.tenantId,
      userId: input.uploadedByUserId,
      entityType: "lead",
      entityId: input.leadId,
      action: "document.uploaded",
      diff: { kind: input.kind, filename: input.filename },
    });

    return { id: row!.id };
  });
}

/** Active (non-archived) lead documents, newest-first, with uploader name. */
export async function listLeadDocuments(input: {
  tenantId: string;
  leadId: string;
}): Promise<LeadDocumentRow[]> {
  return withTenant(input.tenantId, async (tx) => {
    return tx
      .select({
        id: document.id,
        kind: document.kind,
        filename: document.filename,
        mime: document.mime,
        sizeBytes: document.sizeBytes,
        parseStatus: document.parseStatus,
        parseConfidence: document.parseConfidence,
        uploaderName: user.name,
        createdAt: document.createdAt,
      })
      .from(document)
      .leftJoin(user, eq(document.uploadedByUserId, user.id))
      .where(and(eq(document.leadId, input.leadId), isNull(document.archivedAt)))
      .orderBy(desc(document.createdAt));
  });
}
```

Add the export to `packages/db/src/index.ts` near the other lifecycle exports (after the `lead-artifacts` export line):

```ts
export { recordLeadDocument, listLeadDocuments, type LeadDocumentRow } from "./lifecycle/lead-documents";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @savvy/db exec vitest run tests/lead-documents.test.ts`
Expected: PASS (4 passing).

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @savvy/db typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/lifecycle/lead-documents.ts packages/db/src/index.ts packages/db/tests/lead-documents.test.ts
git commit -m "feat(db): lead-document lifecycle (record/list/supersede + timeline) for slice 6a"
```

---

### Task 4: Carry lead documents onto the job at conversion

Extend `convertLeadToJob` so every lead-scoped document (not just the customer-scoped cert/photo set) gets its `job_id` stamped when the job is born. Idempotent via the existing `job_id IS NULL` guard.

**Files:**
- Modify: `packages/db/src/lifecycle/appointments.ts:212-223` (the `stampCerts` helper)
- Create: `packages/db/tests/lead-document-carryover.test.ts`

**Interfaces:**
- Consumes: `recordLeadDocument` (Task 3); `convertLeadToJob(args: { tenantId; leadId; manualJob? })` (existing).
- Produces: no new export; `convertLeadToJob` now also stamps `job_id` onto lead-scoped docs.

- [ ] **Step 1: Write the failing test**

Create `packages/db/tests/lead-document-carryover.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { recordLeadDocument } from "../src/lifecycle/lead-documents.js";
import { convertLeadToJob } from "../src/lifecycle/appointments.js";
import { adminDb, document, eq } from "../src/index.js";
import { makeTenant, makeLeadWithProperty } from "./helpers.js";

describe("convertLeadToJob — lead document carryover", () => {
  it("stamps job_id onto the lead's documents at conversion", async () => {
    const { tenantId } = await makeTenant();
    const { leadId } = await makeLeadWithProperty(tenantId);

    const a = await recordLeadDocument({
      tenantId, leadId, uploadedByUserId: null,
      r2Key: `${tenantId}/lead/${leadId}/a.pdf`, kind: "insurance_estimate",
      filename: "a.pdf", mime: "application/pdf", sizeBytes: 10,
    });
    const b = await recordLeadDocument({
      tenantId, leadId, uploadedByUserId: null,
      r2Key: `${tenantId}/lead/${leadId}/b.pdf`, kind: "measurement_report",
      filename: "b.pdf", mime: "application/pdf", sizeBytes: 10,
    });

    // manualJob bypasses the accepted-estimate red-path; we only care about carryover here.
    const { jobId } = await convertLeadToJob({ tenantId, leadId, manualJob: true });

    const [da] = await adminDb.select().from(document).where(eq(document.id, a!.id));
    const [db] = await adminDb.select().from(document).where(eq(document.id, b!.id));
    expect(da!.jobId).toBe(jobId);
    expect(db!.jobId).toBe(jobId);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @savvy/db exec vitest run tests/lead-document-carryover.test.ts`
Expected: FAIL — `da.jobId` is `null` (carryover not yet wired for lead-scoped docs).

- [ ] **Step 3: Edit `stampCerts`**

In `packages/db/src/lifecycle/appointments.ts`, replace the `stampCerts` helper (lines 212-223) so it also carries lead-scoped docs. Keep the existing customer-scoped cert/photo stamp (storm certs predate `lead_id`), then add the lead-scoped stamp:

```ts
    // Carry the lead's documents onto the job within the same transaction. Idempotent:
    // only updates docs where jobId IS NULL, so a repeat conversion never re-stamps.
    async function stampCerts(jobId: string): Promise<void> {
      // Storm certs / photos attached before lead_id existed are customer-scoped.
      await tx
        .update(document)
        .set({ jobId })
        .where(
          and(
            eq(document.customerId, l!.customerId!),
            inArray(document.kind, ["cert", "photo"]),
            isNull(document.jobId),
          ),
        );
      // Slice 6a: all lead-scoped documents (insurance estimates, measurement reports, etc.).
      await tx
        .update(document)
        .set({ jobId })
        .where(and(eq(document.leadId, l!.id), isNull(document.jobId)));
    }
```

(No import changes — `and`, `eq`, `isNull`, `inArray`, `document` are already imported in this file.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @savvy/db exec vitest run tests/lead-document-carryover.test.ts`
Expected: PASS (1 passing).

- [ ] **Step 5: Regression — the existing appointment/estimate suites still pass**

Run: `pnpm --filter @savvy/db exec vitest run tests/appointments.test.ts tests/draft-lead-estimate.test.ts`
Expected: PASS (no regressions from the `stampCerts` change).

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/lifecycle/appointments.ts packages/db/tests/lead-document-carryover.test.ts
git commit -m "feat(db): carry lead documents onto the job at conversion (slice 6a)"
```

---

### Task 5: Lead upload server actions (presign + record)

Thin server actions wrapping the existing R2 presigned-PUT flow for the lead path, gated by the media policy and lead-scoped key prefix. Per repo precedent (the e2e harness stubs Clerk to a seeded org-admin; no-session auth paths are validated by typecheck + code review, not unit tests), these are verified by typecheck; their meaningful logic (`validateUpload`, `recordLeadDocument`) is unit-tested in Tasks 1 and 3.

**Files:**
- Modify: `apps/web/src/lib/document-actions.ts` (add two exports; extend imports)

**Interfaces:**
- Consumes: `validateUpload`, `UploadValidationError` from `@savvy/core`; `recordLeadDocument`, `lead` from `@savvy/db`; `r2Storage` from `@savvy/integrations`; `getTenantId`, `getCurrentUser`.
- Produces:
  - `presignLeadDocumentUpload(input: { leadId: string; kind: string; filename: string; contentType: string; sizeBytes: number }): Promise<{ ok: true; uploadUrl: string; r2Key: string } | { error: "not_found" | "storage_not_configured" | UploadValidationError }>`
  - `recordLeadDocumentAction(input: { leadId: string; r2Key: string; kind: string; filename: string; mime: string; sizeBytes: number }): Promise<{ ok: true; id: string } | { error: "bad_key" | "not_found" | UploadValidationError }>`

- [ ] **Step 1: Extend the imports**

In `apps/web/src/lib/document-actions.ts`, update the top imports to add `lead`, `recordLeadDocument`, and the core validator:

```ts
import { withTenant, job, lead, document, eq, keepFlaggedPhoto as dbKeepFlaggedPhoto, recordLeadDocument } from "@savvy/db";
import { validateUpload, type UploadValidationError } from "@savvy/core";
```

- [ ] **Step 2: Add the two server actions**

Append to `apps/web/src/lib/document-actions.ts`:

```ts
export async function presignLeadDocumentUpload(input: {
  leadId: string;
  kind: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
}): Promise<
  { ok: true; uploadUrl: string; r2Key: string }
  | { error: "not_found" | "storage_not_configured" | UploadValidationError }
> {
  const tenantId = await getTenantId();
  const v = validateUpload({ kind: input.kind, mime: input.contentType, sizeBytes: input.sizeBytes });
  if (!v.ok) return { error: v.error };
  const found = await withTenant(tenantId, async (tx) => {
    const [l] = await tx.select({ id: lead.id }).from(lead).where(eq(lead.id, input.leadId));
    return l;
  });
  if (!found) return { error: "not_found" };
  const safe = input.filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
  const r2Key = `${tenantId}/lead/${input.leadId}/${crypto.randomUUID()}-${safe}`;
  try {
    const { url } = await r2Storage.presignUpload({ key: r2Key, contentType: input.contentType });
    return { ok: true, uploadUrl: url, r2Key };
  } catch {
    return { error: "storage_not_configured" };
  }
}

export async function recordLeadDocumentAction(input: {
  leadId: string;
  r2Key: string;
  kind: string;
  filename: string;
  mime: string;
  sizeBytes: number;
}): Promise<{ ok: true; id: string } | { error: "bad_key" | "not_found" | UploadValidationError }> {
  const { tenantId, userId } = await getCurrentUser();
  const v = validateUpload({ kind: input.kind, mime: input.mime, sizeBytes: input.sizeBytes });
  if (!v.ok) return { error: v.error };
  // Reject any r2Key not scoped to this tenant+lead — defense against forged keys.
  if (!input.r2Key.startsWith(`${tenantId}/lead/${input.leadId}/`)) return { error: "bad_key" };
  // TEST_MODE's getCurrentUser returns the non-UUID sentinel "test-user"; uploaded_by_user_id
  // FK is nullable, so record null rather than a fake id.
  const auditUserId = userId === "test-user" ? null : userId;
  const res = await recordLeadDocument({
    tenantId,
    leadId: input.leadId,
    r2Key: input.r2Key,
    kind: input.kind,
    filename: input.filename,
    mime: input.mime,
    sizeBytes: input.sizeBytes,
    uploadedByUserId: auditUserId,
  });
  if (!res) return { error: "not_found" };
  revalidatePath(`/leads/${input.leadId}`);
  return { ok: true, id: res.id };
}
```

- [ ] **Step 3: Typecheck (the deliverable's verification)**

Run: `pnpm --filter web typecheck`
Expected: no errors. (Auth-gate behavior follows the established Clerk-stub precedent and is code-reviewed, not unit-tested — consistent with `keepFlaggedPhoto` above.)

- [ ] **Step 4: Lint**

Run: `pnpm --filter web lint`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/document-actions.ts
git commit -m "feat(web): lead-document upload server actions (presign + record) for slice 6a"
```

---

### Task 6: LeadDocsCard component + lead page wiring + e2e

Render a Documents card on the lead tile: an upload control (file picker + drag/drop, doc-type selector) and a list of active docs with uploader, timestamp, and a parse-status chip. Server-fetch the list in the page; the client component performs presign → PUT → record → `router.refresh()`.

**Files:**
- Create: `apps/web/src/app/(app)/leads/[id]/LeadDocsCard.tsx`
- Modify: `apps/web/src/app/(app)/leads/[id]/page.tsx` (fetch list + render card)
- Create: `apps/web/tests/e2e/lead-documents.spec.ts`

**Interfaces:**
- Consumes: `presignLeadDocumentUpload`, `recordLeadDocumentAction` (Task 5); `listLeadDocuments`, `type LeadDocumentRow` (Task 3).
- Produces: `LeadDocsCard` React component; a `data-testid="lead-docs-card"` surface on the lead page.

- [ ] **Step 1: Write the failing e2e**

Create `apps/web/tests/e2e/lead-documents.spec.ts` (mirrors the seed+navigate pattern of `estimate.spec.ts`; seeds a document row directly so it does not depend on R2):

```ts
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { adminDb, customer, property, lead, document } from "@savvy/db";

const { id: tenantId } = JSON.parse(
  readFileSync("/tmp/savvy-e2e-tenant.json", "utf8"),
) as { id: string; key: string };

test("lead documents: card renders a seeded lead-scoped document", async ({ page }) => {
  const stamp = randomUUID().slice(0, 8);
  const [cust] = await adminDb.insert(customer).values({
    tenantId, name: `Docs Dan ${stamp}`,
  }).returning();
  const [prop] = await adminDb.insert(property).values({
    tenantId, customerId: cust!.id, address: `${stamp} Docs Way`,
  }).returning();
  const [l] = await adminDb.insert(lead).values({
    tenantId, customerId: cust!.id, propertyId: prop!.id, source: "e2e",
  }).returning();
  await adminDb.insert(document).values({
    tenantId, leadId: l!.id, propertyId: prop!.id, customerId: cust!.id,
    kind: "insurance_estimate", r2Key: `${tenantId}/lead/${l!.id}/seed.pdf`,
    filename: "carrier-estimate.pdf", mime: "application/pdf", sizeBytes: 4096,
    source: "savvy", parseStatus: "pending",
  });

  await page.goto(`/leads/${l!.id}`);
  const card = page.getByTestId("lead-docs-card");
  await expect(card).toBeVisible();
  await expect(card).toContainText("carrier-estimate.pdf");
  await expect(card).toContainText("Pending"); // parse-status chip
});
```

- [ ] **Step 2: Run the e2e to verify it fails**

Run: `pnpm --filter web exec playwright test tests/e2e/lead-documents.spec.ts`
Expected: FAIL — no element with `data-testid="lead-docs-card"`.

- [ ] **Step 3: Create the component**

Create `apps/web/src/app/(app)/leads/[id]/LeadDocsCard.tsx`:

```tsx
"use client";
import { useState, useRef } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/card";
import { toast } from "sonner";
import { presignLeadDocumentUpload, recordLeadDocumentAction } from "@/lib/document-actions";
import type { LeadDocumentRow } from "@savvy/db";

const KINDS = ["insurance_estimate", "measurement_report", "photo", "contract", "other"] as const;
const KIND_LABELS: Record<string, string> = {
  insurance_estimate: "Insurance estimate",
  measurement_report: "Measurement report",
  photo: "Photo",
  contract: "Contract",
  other: "Other",
};
const PARSE_LABELS: Record<string, string> = {
  pending: "Pending",
  parsed: "Parsed",
  parse_failed: "Parse failed",
  unparsed_low_confidence: "Stored, unparsed",
};

function fmtTime(d: Date | string): string {
  return new Date(d).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function LeadDocsCard({ leadId, documents }: { leadId: string; documents: LeadDocumentRow[] }) {
  const router = useRouter();
  const [kind, setKind] = useState<string>("insurance_estimate");
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  async function upload(file: File) {
    setBusy(true);
    try {
      const pres = await presignLeadDocumentUpload({
        leadId, kind, filename: file.name, contentType: file.type, sizeBytes: file.size,
      });
      if (!("ok" in pres)) {
        toast.error(`Upload rejected: ${pres.error}`);
        return;
      }
      const put = await fetch(pres.uploadUrl, { method: "PUT", body: file, headers: { "content-type": file.type } });
      if (!put.ok) {
        toast.error("Upload to storage failed");
        return;
      }
      const rec = await recordLeadDocumentAction({
        leadId, r2Key: pres.r2Key, kind, filename: file.name, mime: file.type, sizeBytes: file.size,
      });
      if (!("ok" in rec)) {
        toast.error(`Could not record document: ${rec.error}`);
        return;
      }
      toast.success("Document uploaded");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="p-4" data-testid="lead-docs-card">
      <div className="eyebrow mb-3">Documents</div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <select
          className="rounded border px-2 py-1 text-sm"
          value={kind}
          onChange={(e) => setKind(e.target.value)}
          aria-label="Document type"
        >
          {KINDS.map((k) => <option key={k} value={k}>{KIND_LABELS[k]}</option>)}
        </select>
      </div>

      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const f = e.dataTransfer.files?.[0];
          if (f) void upload(f);
        }}
        onClick={() => inputRef.current?.click()}
        className="mb-4 cursor-pointer rounded border border-dashed p-4 text-center text-sm"
        style={{ borderColor: dragOver ? "var(--text-muted)" : "var(--border)", color: "var(--text-muted)" }}
        data-testid="lead-docs-dropzone"
      >
        {busy ? "Uploading…" : "Drop a file here, or click to choose (PDF for insurance / measurement; 25MB max)"}
        <input
          ref={inputRef}
          type="file"
          className="hidden"
          accept="application/pdf,image/jpeg,image/png,image/webp,image/heic"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void upload(f);
            e.target.value = "";
          }}
        />
      </div>

      {documents.length === 0 ? (
        <p className="text-sm" style={{ color: "var(--text-faint)" }}>No documents yet.</p>
      ) : (
        <ul className="space-y-2">
          {documents.map((d) => (
            <li key={d.id} className="flex items-center justify-between gap-2 text-sm">
              <div>
                <div className="font-medium">{d.filename ?? "(unnamed)"}</div>
                <div className="mono text-xs" style={{ color: "var(--text-faint)" }}>
                  {KIND_LABELS[d.kind] ?? d.kind} · {d.uploaderName ?? "system"} · {fmtTime(d.createdAt)}
                </div>
              </div>
              <span
                className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium"
                style={{ background: "var(--surface-muted)", color: "var(--text-muted)" }}
              >
                {PARSE_LABELS[d.parseStatus] ?? d.parseStatus}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
```

- [ ] **Step 4: Wire the card into the lead page**

In `apps/web/src/app/(app)/leads/[id]/page.tsx`:

Add imports:
```ts
import { listLeadDocuments } from "@savvy/db";
import { LeadDocsCard } from "./LeadDocsCard";
```

Extend the `Promise.all` (line 28) to also fetch documents. Because `listLeadDocuments` needs the tenant id, fetch it via the same `getTenantId` the other lead actions use — import it and resolve first:
```ts
import { getTenantId } from "@/lib/tenant";
```
Replace the data-fetch block:
```ts
  const { id } = await params;
  const tenantId = await getTenantId();
  const [detail, users, artifacts, documents] = await Promise.all([
    getLeadDetail(id),
    listUsers(),
    getLeadArtifactsForLead(id),
    listLeadDocuments({ tenantId, leadId: id }),
  ]);
  if (!detail) notFound();
```

Render the card right after `<LeadArtifactsSections artifacts={artifacts} />` (line 113):
```tsx
      <LeadArtifactsSections artifacts={artifacts} />

      <LeadDocsCard leadId={detail.id} documents={documents} />
```

- [ ] **Step 5: Run the e2e to verify it passes**

Run: `pnpm --filter web exec playwright test tests/e2e/lead-documents.spec.ts`
Expected: PASS — the card renders with the seeded filename and the "Pending" chip.

- [ ] **Step 6: Typecheck + lint**

Run: `pnpm --filter web typecheck && pnpm --filter web lint`
Expected: no errors, clean.

- [ ] **Step 7: Manual verification of the live upload flow**

The e2e seeds a row directly and does not exercise the presign→PUT→record path (that needs real R2). Verify the live path once with the `verify` skill / `pnpm dev`: open a lead, drag a PDF as "Insurance estimate", confirm it appears in the list with your name + "Pending", and that a second insurance_estimate upload supersedes the first (only the newest shows). Confirm an oversized (>25MB) or non-PDF insurance upload is rejected with a toast.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/app/(app)/leads/[id]/LeadDocsCard.tsx apps/web/src/app/(app)/leads/[id]/page.tsx apps/web/tests/e2e/lead-documents.spec.ts
git commit -m "feat(web): LeadDocsCard upload + timeline on the lead tile (slice 6a)"
```

---

## Definition of Done (Slice 6a)

- [ ] `document` carries lead scope, uploader, and parse-status columns (migration 0063 applied).
- [ ] Media policy (25MB cap, mime allow-list, PDF-only for parseable kinds) enforced server-side and unit-tested.
- [ ] Lead docs record with an `audit_log` timeline row; single-slot parseable kinds supersede prior versions; no delete exposed.
- [ ] Lead docs carry onto the job at `convertLeadToJob`.
- [ ] Lead tile shows a Documents card with upload (drag/drop + picker) and a list with uploader + timestamp + parse-status chip.
- [ ] `pnpm typecheck` and `pnpm lint` clean across `@savvy/core`, `@savvy/db`, and `web`.
- [ ] All new tests green; `appointments`/`draft-lead-estimate` regressions green.

## Self-Review notes (coverage vs the 6a spec)

- **Storage + model** (lead_id, uploader, doc-type via extended `kind`, R2 path): Tasks 2, 3, 5. ✅
- **Media policy #341** (25MB, mime, PDF-only typed): Task 1 + enforced in Task 5. ✅
- **Upload UI on the lead tile** (drag/drop + picker + doc-type): Task 6. ✅
- **Uploader + timeline** (uploaded_by_user_id + audit_log + doc card): Tasks 2, 3, 6. ✅
- **Supersede, no delete** (reuse archivedAt): Task 3 (+ manual check Task 6.7). ✅
- **Carryover at conversion**: Task 4. ✅
- **Deferred to later phases (correctly out of 6a):** parse routing + `parse_status` transitions off `pending` (6b/6c write these columns), measurement `source` (6b), claim rescope (6c), evidence checks (6d).

**Not covered by an automated test (by repo precedent, documented):** the server-action auth gate (Clerk-stub precedent → typecheck + code review, Task 5.3) and the live presign→PUT→record upload path (needs real R2 → manual verify, Task 6.7).
