# Phase 6B — Closeout E-Sign (DocuSeal) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A rep sends a lien waiver or certificate of completion from a job; the customer signs via DocuSeal; the signed PDF lands as a `document` on the job and the completed signature is recorded as a meterable event.

**Architecture:** Mirrors the existing Stripe webhook → event → durable-consumer pattern. A `sendForSignature` server action creates a DocuSeal submission (Savvy-mediated, one Savvy-owned instance) and inserts an `esign_request` row (`status: sent`). DocuSeal emails the signer and posts a webhook on completion; the public webhook route verifies the signature, flips the row to `completed`, and emits `esign/completed`. An Inngest function `esignFinalize` durably downloads the signed PDF and stores it in R2 (reusing the 6A `StorageGateway`, extended with a server-side `putObject`) as a `document`, then links it back to the request. No completion gating is added — photos remain the only completion gate (6A).

**Tech Stack:** Next.js 16 (App Router) server actions + route handlers · Drizzle + Postgres RLS · Inngest · Cloudflare R2 (S3 SDK) · DocuSeal (native `fetch`) · Vitest + Playwright · pnpm + Turborepo.

**Branch:** `feat/phase6b-closeout-esign` (already created off `main`).

**DB env for db/agents tests + migrations:**
```bash
export DATABASE_URL=postgres://savvy_app:savvy_app@localhost:5432/savvy
export DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/savvy
```

**Repo gotchas to respect throughout:**
- Import drizzle ops (`eq`,`and`,`sql`) + tables from `@savvy/db`; `z` + helpers from `@savvy/core`. Never from `drizzle-orm`/`zod` directly. No `.js` on SOURCE relative imports; `@savvy/db` TEST files DO use `.js`. (This plan's tests live in `packages/*` — match each file's neighbors.)
- `noUncheckedIndexedAccess` is ON — use `arr[i]?.x` / `.at()` / `!` after a guard.
- Do outbound HTTP OUTSIDE the `withTenant` transaction.
- `"use server"` actions are public endpoints — verify tenant ownership server-side.
- New tenant tables MUST get `tenantIsolation()` AND an isolation test case.
- `tenant` table has NO RLS — read/write `tenant.settings` via `adminDb`.
- Inngest serializes Date→ISO across `step.run`; re-hydrate with `new Date(x)`.
- `gh pr create` MUST pass `--base main`.
- After a workspace dep add, run `pnpm install` at root.

**Gate before each commit (run from repo root):** `pnpm typecheck && pnpm lint && pnpm test`

---

## File Structure (what gets created / modified)

**Created:**
- `packages/core/src/esign.ts` — pure config parser + prefill builder + docType enum.
- `packages/integrations/src/docuseal.ts` — `DocusealGateway` (real + `makeFakeDocuseal`).
- `packages/db/src/lifecycle/esign.ts` — `markEsignBySubmission` (webhook-side, adminDb lookup + tenant-scoped update).
- `packages/agents/src/functions/esign-finalize.ts` — `finalizeEsign` helper + `esignFinalize` Inngest fn.
- `packages/agents/src/functions/esign-finalize.test.ts` — integration test (real DB + fake gateways).
- `apps/web/src/lib/esign-actions.ts` — `sendForSignature` server action.
- `apps/web/src/app/api/docuseal/webhook/route.ts` — public webhook route.
- `apps/web/src/app/(app)/jobs/[id]/EsignPanel.tsx` — client UI.
- `apps/web/tests/e2e/docuseal-stub.mjs` — minimal DocuSeal stub for e2e.
- `apps/web/tests/e2e/esign.spec.ts` — e2e flow.

**Modified:**
- `packages/core/src/index.ts` — export esign module.
- `packages/integrations/src/storage.ts` — add `putObject` to `StorageGateway` + both impls.
- `packages/integrations/src/index.ts` — export DocuSeal gateway.
- `packages/db/src/schema/ops.ts` — add `esign_request` table (+ imports).
- `packages/db/src/index.ts` — export `markEsignBySubmission`.
- `packages/db/tests/isolation.test.ts` — add `esign_request` isolation case.
- `packages/db/drizzle/0007_*.sql` — generated migration.
- `packages/agents/src/client.ts` — register `esign/completed` event.
- `packages/agents/src/index.ts` — register `esignFinalize`.
- `apps/web/src/middleware.ts` — add webhook to PUBLIC.
- `apps/web/src/app/(app)/jobs/[id]/page.tsx` — load esign requests + pass to tabs.
- `apps/web/src/app/(app)/jobs/[id]/tabs.tsx` — add "E-sign" tab.
- `.env.example` — document `DOCUSEAL_*`.

---

## Task 1: Core — esign config parser + prefill builder

**Files:**
- Create: `packages/core/src/esign.ts`
- Test: `packages/core/src/esign.test.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/esign.test.ts`:

```typescript
import { test, expect } from "vitest";
import {
  parseEsignConfig, resolveEsignTemplate, buildEsignPrefill, ESIGN_DOC_TYPE,
} from "./esign";

test("ESIGN_DOC_TYPE has both doc types", () => {
  expect(ESIGN_DOC_TYPE).toEqual(["lien_waiver", "cert"]);
});

test("parseEsignConfig fills defaults from empty/undefined", () => {
  expect(parseEsignConfig(undefined).templates.lien_waiver).toBe("");
  expect(parseEsignConfig({}).templates.cert).toBe("");
});

test("parseEsignConfig keeps a tenant override", () => {
  const cfg = parseEsignConfig({ templates: { cert: "tpl_99" } });
  expect(cfg.templates.cert).toBe("tpl_99");
  expect(cfg.templates.lien_waiver).toBe("");
});

test("resolveEsignTemplate prefers the configured id, else the fallback", () => {
  const cfg = parseEsignConfig({ templates: { lien_waiver: "tpl_lw" } });
  expect(resolveEsignTemplate(cfg, "lien_waiver", "env_lw")).toBe("tpl_lw");
  expect(resolveEsignTemplate(cfg, "cert", "env_cert")).toBe("env_cert");
});

test("buildEsignPrefill: cert has name/address/date, NO amount", () => {
  const f = buildEsignPrefill("cert", { customerName: "Jane", propertyAddress: "1 Main", date: "2026-06-15" });
  expect(f).toEqual([
    { name: "customer_name", default_value: "Jane" },
    { name: "property_address", default_value: "1 Main" },
    { name: "date", default_value: "2026-06-15" },
  ]);
});

test("buildEsignPrefill: lien_waiver adds amount (empty when omitted)", () => {
  const withAmt = buildEsignPrefill("lien_waiver", { customerName: "J", propertyAddress: "1 Main", date: "2026-06-15", amount: "$1,200.00" });
  expect(withAmt.at(-1)).toEqual({ name: "amount", default_value: "$1,200.00" });
  const noAmt = buildEsignPrefill("lien_waiver", { customerName: "J", propertyAddress: "1 Main", date: "2026-06-15" });
  expect(noAmt.at(-1)).toEqual({ name: "amount", default_value: "" });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @savvy/core exec vitest run src/esign.test.ts`
Expected: FAIL — `Cannot find module './esign'`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/core/src/esign.ts`:

```typescript
import { z } from "./schemas";

export const ESIGN_DOC_TYPE = ["lien_waiver", "cert"] as const;
export type EsignDocType = (typeof ESIGN_DOC_TYPE)[number];

const esignSchema = z.object({
  templates: z
    .object({
      lien_waiver: z.string().default(""),
      cert: z.string().default(""),
    })
    .default({}),
});

export type EsignConfig = z.infer<typeof esignSchema>;

export function parseEsignConfig(raw: unknown): EsignConfig {
  return esignSchema.parse(raw ?? {});
}

/** The configured template id wins; otherwise the env-supplied Savvy standard id. */
export function resolveEsignTemplate(cfg: EsignConfig, docType: EsignDocType, fallback: string): string {
  const id = cfg.templates[docType];
  return id.length > 0 ? id : fallback;
}

export type EsignPrefillCtx = {
  customerName: string;
  propertyAddress: string;
  date: string;
  amount?: string;
};

/** DocuSeal prefill shape: [{ name, default_value }]. lien_waiver also carries amount. */
export function buildEsignPrefill(docType: EsignDocType, ctx: EsignPrefillCtx): { name: string; default_value: string }[] {
  const fields = [
    { name: "customer_name", default_value: ctx.customerName },
    { name: "property_address", default_value: ctx.propertyAddress },
    { name: "date", default_value: ctx.date },
  ];
  if (docType === "lien_waiver") {
    fields.push({ name: "amount", default_value: ctx.amount ?? "" });
  }
  return fields;
}
```

- [ ] **Step 4: Export from the core barrel**

In `packages/core/src/index.ts`, add after the existing `export * from "./production";` line:

```typescript
export * from "./esign";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @savvy/core exec vitest run src/esign.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/esign.ts packages/core/src/esign.test.ts packages/core/src/index.ts
git commit -m "feat(core): esign config parser + prefill builder"
```

---

## Task 2: DB — `esign_request` table + migration

**Files:**
- Modify: `packages/db/src/schema/ops.ts`
- Create (generated): `packages/db/drizzle/0007_*.sql`

- [ ] **Step 1: Inspect current ops.ts imports**

Run: `sed -n '1,6p' packages/db/src/schema/ops.ts`
Note which of `timestamp` and `uniqueIndex` are already imported from `drizzle-orm/pg-core`. The `document` table is at the top of this file and is referenced by the new table.

- [ ] **Step 2: Ensure required imports**

In `packages/db/src/schema/ops.ts`, the first import line pulls named helpers from `"drizzle-orm/pg-core"`. Make sure it includes `timestamp` and `uniqueIndex` (add whichever are missing). For example, the line should read like:

```typescript
import { pgTable, uuid, text, integer, jsonb, index, uniqueIndex, timestamp } from "drizzle-orm/pg-core";
```

(Keep any helpers already present; only add the missing ones. `idCol`, `createdAt`, `tenantIsolation` come from the existing `_rls` import — leave that import untouched.)

- [ ] **Step 3: Add the `esign_request` table**

At the END of `packages/db/src/schema/ops.ts`, after the `document` table definition, append:

```typescript
// E-sign requests (Phase 6B). One row per lien-waiver/cert signature request.
// docusealSubmissionId is globally unique within the single Savvy DocuSeal instance;
// the (tenant, submission) unique index makes the webhook idempotent.
export const esignRequest = pgTable("esign_request", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  jobId: uuid("job_id").notNull().references(() => job.id),
  customerId: uuid("customer_id").notNull().references(() => customer.id),
  docType: text("doc_type").notNull(), // lien_waiver|cert
  templateId: text("template_id").notNull(),
  docusealSubmissionId: text("docuseal_submission_id").notNull(),
  status: text("status").notNull().default("draft"), // draft|sent|completed|declined|voided
  signingUrl: text("signing_url"),
  documentId: uuid("document_id").references(() => document.id),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [
  index("esign_request_tenant_job_idx").on(t.tenantId, t.jobId),
  uniqueIndex("esign_request_submission_uniq").on(t.tenantId, t.docusealSubmissionId),
  tenantIsolation(),
]);
```

Note: `tenant`, `job`, `customer`, `document`, `idCol`, `createdAt`, `tenantIsolation` are all already imported/defined in this file (the `document` table uses them). Do not re-import.

- [ ] **Step 4: Generate the migration**

Run: `pnpm --filter @savvy/db db:generate`
Expected: a new file `packages/db/drizzle/0007_*.sql` is created containing `CREATE TABLE ... "esign_request"`, the two indexes, the FKs, `ENABLE ROW LEVEL SECURITY`, and `CREATE POLICY "tenant_isolation" ON "esign_request"`.

- [ ] **Step 5: Verify the generated SQL**

Run: `cat packages/db/drizzle/0007_*.sql`
Confirm it contains: `CREATE TABLE`, `esign_request_submission_uniq` (UNIQUE), `esign_request_tenant_job_idx`, three FK constraints (tenant/job/customer) + the document FK, `ENABLE ROW LEVEL SECURITY`, and the `tenant_isolation` policy. If the policy or RLS line is missing, the `tenantIsolation()` call was dropped — fix Step 3 and regenerate.

- [ ] **Step 6: Apply the migration locally**

Run: `pnpm --filter @savvy/db db:migrate`
Expected: migration `0007` applies cleanly (no error).

- [ ] **Step 7: Typecheck**

Run: `pnpm --filter @savvy/db typecheck`
Expected: PASS (the new table is exported automatically via `export * from "./schema/index"`).

- [ ] **Step 8: Commit**

```bash
git add packages/db/src/schema/ops.ts packages/db/drizzle/
git commit -m "feat(db): add esign_request table + migration 0007"
```

---

## Task 3: DB — RLS isolation test for `esign_request`

**Files:**
- Modify: `packages/db/tests/isolation.test.ts`

- [ ] **Step 1: Read the existing test to learn the helpers**

Run: `sed -n '1,100p' packages/db/tests/isolation.test.ts`
Note: it imports `adminDb`, `withTenant`, `eq`, and tables from `@savvy/db` (TEST files use `.js`-less named imports from the package). It already has module-level `tenantAId` / `tenantBId` and creates a tenant-B job (`jb`) + customer in `beforeAll`. Note the exact variable names for tenant B's job id and customer id.

- [ ] **Step 2: Add `esignRequest` to the test's `@savvy/db` import**

In the import block at the top of `packages/db/tests/isolation.test.ts`, add `esignRequest` to the destructured names imported from `@savvy/db`.

- [ ] **Step 3: Write the failing isolation test (self-contained)**

Add this `it(...)` inside the main `describe(...)` block (place it next to the existing `document` isolation test). It seeds its own rows via `adminDb` (bypasses RLS) and cleans them up, so it does not depend on other tests' fixtures. Replace `B_JOB_ID` and `B_CUSTOMER_ID` with the tenant-B job/customer variables you found in Step 1 (these already exist for tenant `tenantBId`):

```typescript
it("SELECT on esign_request is tenant-scoped (A cannot see B's requests)", async () => {
  const [er] = await adminDb
    .insert(esignRequest)
    .values({
      tenantId: tenantBId,
      jobId: B_JOB_ID,
      customerId: B_CUSTOMER_ID,
      docType: "lien_waiver",
      templateId: "tpl_b",
      docusealSubmissionId: "sub_b_iso_1",
      status: "sent",
    })
    .returning();
  try {
    const rows = await withTenant(tenantAId, (tx) => tx.select().from(esignRequest));
    expect(rows.some((r) => r.tenantId === tenantBId)).toBe(false);
  } finally {
    await adminDb.delete(esignRequest).where(eq(esignRequest.id, er!.id));
  }
});
```

If the existing `beforeAll` tears down tenant B's job/customer, ensure `esign_request` rows are deleted BEFORE the job/customer delete (FK order). Since this test deletes its own row in `finally`, no change to the shared teardown is required — but if you added any module-level esign rows, add `await adminDb.delete(esignRequest).where(eq(esignRequest.tenantId, tenantBId));` to `afterAll` before the job delete.

- [ ] **Step 4: Run the test**

Run: `pnpm --filter @savvy/db exec vitest run tests/isolation.test.ts`
Expected: PASS, including the new case. (The whole isolation suite must stay green.)

- [ ] **Step 5: Commit**

```bash
git add packages/db/tests/isolation.test.ts
git commit -m "test(db): esign_request RLS isolation"
```

---

## Task 4: DB — `markEsignBySubmission` lifecycle helper

The webhook has no Clerk session, so it looks the request up by the globally-unique DocuSeal submission id via `adminDb`, then writes the status change inside `withTenant` (so the write still passes through RLS).

**Files:**
- Create: `packages/db/src/lifecycle/esign.ts`
- Create: `packages/db/src/lifecycle/esign.test.ts`
- Modify: `packages/db/src/index.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/db/src/lifecycle/esign.test.ts` (mirror the tenant/customer/property/job insert shape from `packages/db/tests/isolation.test.ts` `beforeAll`; read that file for the exact required columns of `property` and `job`):

```typescript
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import {
  adminDb, adminPool, pool, eq,
  tenant, customer, property, job, esignRequest,
} from "@savvy/db";
import { markEsignBySubmission } from "./esign.js";

let tId: string, custId: string, propId: string, jobId: string;

beforeAll(async () => {
  const [t] = await adminDb.insert(tenant).values({ name: "ES", publicKey: "es", clerkOrgId: "org_es" }).returning();
  tId = t!.id;
  const [c] = await adminDb.insert(customer).values({ tenantId: tId, name: "Pat", email: "pat@x.com" }).returning();
  custId = c!.id;
  // property + job: copy the required columns from isolation.test.ts beforeAll.
  const [p] = await adminDb.insert(property).values({ tenantId: tId, customerId: custId, address: "1 Main St" }).returning();
  propId = p!.id;
  const [j] = await adminDb.insert(job).values({ tenantId: tId, customerId: custId, propertyId: propId }).returning();
  jobId = j!.id;
});

afterAll(async () => {
  await adminDb.delete(esignRequest).where(eq(esignRequest.tenantId, tId));
  await adminDb.delete(job).where(eq(job.tenantId, tId));
  await adminDb.delete(property).where(eq(property.tenantId, tId));
  await adminDb.delete(customer).where(eq(customer.tenantId, tId));
  await adminDb.delete(tenant).where(eq(tenant.id, tId));
  await pool.end();
  await adminPool.end();
});

describe("markEsignBySubmission", () => {
  it("flips a sent request to completed + sets completedAt; idempotent on replay", async () => {
    await adminDb.insert(esignRequest).values({
      tenantId: tId, jobId, customerId: custId, docType: "cert",
      templateId: "tpl", docusealSubmissionId: "sub_1", status: "sent",
    });

    const first = await markEsignBySubmission({ submissionId: "sub_1", status: "completed" });
    expect(first?.changed).toBe(true);
    expect(first?.tenantId).toBe(tId);

    const [row] = await adminDb.select().from(esignRequest).where(eq(esignRequest.docusealSubmissionId, "sub_1"));
    expect(row!.status).toBe("completed");
    expect(row!.completedAt).not.toBeNull();

    const second = await markEsignBySubmission({ submissionId: "sub_1", status: "completed" });
    expect(second?.changed).toBe(false); // already completed → no-op
  });

  it("returns null for an unknown submission", async () => {
    const r = await markEsignBySubmission({ submissionId: "does_not_exist", status: "completed" });
    expect(r).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @savvy/db exec vitest run src/lifecycle/esign.test.ts`
Expected: FAIL — `Cannot find module './esign.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/db/src/lifecycle/esign.ts`:

```typescript
import { eq } from "drizzle-orm";
import { adminDb } from "../admin-client";
import { withTenant } from "../tenant";
import { esignRequest } from "../schema/ops";

/**
 * Webhook-side status update. The webhook has no tenant session, so we resolve
 * the tenant via the globally-unique DocuSeal submission id (adminDb, bypassing
 * RLS for the read), then write the change inside withTenant (RLS-enforced).
 * Idempotent: a request already in a terminal state returns { changed: false }.
 */
export async function markEsignBySubmission(input: {
  submissionId: string;
  status: "completed" | "declined";
}): Promise<{ tenantId: string; requestId: string; changed: boolean } | null> {
  const [row] = await adminDb
    .select({ id: esignRequest.id, tenantId: esignRequest.tenantId, status: esignRequest.status })
    .from(esignRequest)
    .where(eq(esignRequest.docusealSubmissionId, input.submissionId));
  if (!row) return null;
  if (row.status === "completed" || row.status === "declined") {
    return { tenantId: row.tenantId, requestId: row.id, changed: false };
  }
  await withTenant(row.tenantId, (tx) =>
    tx
      .update(esignRequest)
      .set({
        status: input.status,
        completedAt: input.status === "completed" ? new Date() : null,
      })
      .where(eq(esignRequest.id, row.id)),
  );
  return { tenantId: row.tenantId, requestId: row.id, changed: true };
}
```

- [ ] **Step 4: Export from the db barrel**

In `packages/db/src/index.ts`, add after the existing `export { recordCommission } from "./lifecycle/commission";` line:

```typescript
export { markEsignBySubmission } from "./lifecycle/esign";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @savvy/db exec vitest run src/lifecycle/esign.test.ts`
Expected: PASS (2 tests). If the `property`/`job` inserts error on a missing not-null column, open `packages/db/tests/isolation.test.ts` and copy the exact column set it uses for those inserts.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/lifecycle/esign.ts packages/db/src/lifecycle/esign.test.ts packages/db/src/index.ts
git commit -m "feat(db): markEsignBySubmission webhook-side status update"
```

---

## Task 5: Integrations — extend `StorageGateway` with `putObject`

`esignFinalize` holds the signed PDF bytes server-side and must store them. The 6A gateway only presigns browser URLs, so add a server-side put.

**Files:**
- Modify: `packages/integrations/src/storage.ts`
- Test: `packages/integrations/src/storage.test.ts` (create if absent; otherwise add to it)

- [ ] **Step 1: Write the failing test**

Create or extend `packages/integrations/src/storage.test.ts`:

```typescript
import { test, expect } from "vitest";
import { makeFakeStorage } from "./storage";

test("makeFakeStorage.putObject records the call", async () => {
  const s = makeFakeStorage();
  await s.putObject({ key: "t/j/file.pdf", bytes: new Uint8Array([1, 2, 3]), contentType: "application/pdf" });
  expect(s.calls).toContainEqual({ op: "put", key: "t/j/file.pdf" });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @savvy/integrations exec vitest run src/storage.test.ts`
Expected: FAIL — `putObject is not a function` (TS error or runtime).

- [ ] **Step 3: Add `putObject` to the interface + both impls**

In `packages/integrations/src/storage.ts`:

a) Add to the `StorageGateway` interface (after `presignDownload`):
```typescript
  putObject(o: { key: string; bytes: Uint8Array; contentType: string }): Promise<void>;
```

b) Add to the real `r2Storage` object (after the `presignDownload` method). `PutObjectCommand` is already imported in this file:
```typescript
  async putObject({ key, bytes, contentType }) {
    await r2Client().send(
      new PutObjectCommand({ Bucket: process.env.R2_BUCKET, Key: key, Body: bytes, ContentType: contentType }),
    );
  },
```

c) In `makeFakeStorage`, widen the `calls` array type and add the method. Change the return type annotation's `calls` to `{ op: string; key: string }[]` (it already is), and add after `presignDownload`:
```typescript
    async putObject({ key }) {
      calls.push({ op: "put", key });
    },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @savvy/integrations exec vitest run src/storage.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @savvy/integrations typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/integrations/src/storage.ts packages/integrations/src/storage.test.ts
git commit -m "feat(integrations): StorageGateway.putObject (server-side R2 put)"
```

---

## Task 6: Integrations — `DocusealGateway`

**Files:**
- Create: `packages/integrations/src/docuseal.ts`
- Create: `packages/integrations/src/docuseal.test.ts`
- Modify: `packages/integrations/src/index.ts`

Note: the real impl's exact DocuSeal request/response/webhook shapes are best-effort and **sandbox-validated** (same posture as the QBO gateway). The gateway interface isolates any later correction to this one file. Tests exercise the fake.

- [ ] **Step 1: Write the failing test**

Create `packages/integrations/src/docuseal.test.ts`:

```typescript
import { test, expect } from "vitest";
import { makeFakeDocuseal } from "./docuseal";

test("fake createSubmission returns a submissionId + signingUrl and records the call", async () => {
  const d = makeFakeDocuseal();
  const r = await d.createSubmission({
    templateId: "tpl_1",
    signer: { name: "Jane", email: "jane@x.com" },
    fields: [{ name: "customer_name", default_value: "Jane" }],
    metadata: { tenantId: "t1", jobId: "j1", docType: "cert" },
  });
  expect(r.submissionId).toMatch(/^sub_fake_/);
  expect(r.signingUrl).toContain(r.submissionId);
  expect(d.calls).toContainEqual({ op: "create" });
});

test("fake verifyWebhook parses a well-formed body and rejects junk", () => {
  const d = makeFakeDocuseal();
  expect(d.verifyWebhook(JSON.stringify({ submissionId: "sub_fake_1", status: "completed" }), null))
    .toEqual({ submissionId: "sub_fake_1", status: "completed" });
  expect(d.verifyWebhook("not json", null)).toBeNull();
  expect(d.verifyWebhook(JSON.stringify({ status: "completed" }), null)).toBeNull();
});

test("fake downloadSignedPdf returns PDF-magic bytes", async () => {
  const d = makeFakeDocuseal();
  const { bytes, mime } = await d.downloadSignedPdf({ submissionId: "sub_fake_1" });
  expect(mime).toBe("application/pdf");
  expect(Array.from(bytes.slice(0, 4))).toEqual([37, 80, 68, 70]); // %PDF
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @savvy/integrations exec vitest run src/docuseal.test.ts`
Expected: FAIL — `Cannot find module './docuseal'`.

- [ ] **Step 3: Write the implementation**

Create `packages/integrations/src/docuseal.ts`:

```typescript
import { createHmac, timingSafeEqual } from "node:crypto";

export interface DocusealGateway {
  createSubmission(o: {
    templateId: string;
    signer: { name: string; email: string };
    fields: { name: string; default_value: string }[];
    metadata: { tenantId: string; jobId: string; docType: string };
  }): Promise<{ submissionId: string; signingUrl: string }>;
  verifyWebhook(rawBody: string, signature: string | null):
    | { submissionId: string; status: "completed" | "declined" }
    | null;
  downloadSignedPdf(o: { submissionId: string }): Promise<{ bytes: Uint8Array; mime: string }>;
}

function cfg(): { base: string; key: string } {
  const base = process.env.DOCUSEAL_BASE_URL;
  const key = process.env.DOCUSEAL_API_KEY;
  if (!base || !key) throw new Error("docuseal_not_configured");
  return { base: base.replace(/\/$/, ""), key };
}

export const docusealGateway: DocusealGateway = {
  async createSubmission({ templateId, signer, fields, metadata }) {
    const { base, key } = cfg();
    const res = await fetch(`${base}/submissions`, {
      method: "POST",
      headers: { "X-Auth-Token": key, "Content-Type": "application/json" },
      body: JSON.stringify({
        template_id: Number(templateId),
        send_email: true,
        submitters: [{ role: "Signer", name: signer.name, email: signer.email, fields }],
        metadata,
      }),
    });
    if (!res.ok) throw new Error(`docuseal createSubmission -> ${res.status}`);
    const arr = (await res.json()) as Array<{ submission_id: number; slug: string; embed_src?: string }>;
    const first = arr[0];
    if (!first) throw new Error("docuseal createSubmission: empty response");
    return {
      submissionId: String(first.submission_id),
      signingUrl: first.embed_src ?? `${base}/s/${first.slug}`,
    };
  },

  verifyWebhook(rawBody, signature) {
    const secret = process.env.DOCUSEAL_WEBHOOK_SECRET ?? "";
    if (secret) {
      if (!signature) return null;
      const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
      const a = Buffer.from(expected);
      const b = Buffer.from(signature);
      if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    }
    let payload: { event_type?: string; data?: { id?: number; submission_id?: number } };
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return null;
    }
    const subId = payload.data?.submission_id ?? payload.data?.id;
    if (subId == null) return null;
    const et = payload.event_type ?? "";
    const status: "completed" | "declined" | null = et.includes("completed")
      ? "completed"
      : et.includes("declined")
        ? "declined"
        : null;
    if (!status) return null;
    return { submissionId: String(subId), status };
  },

  async downloadSignedPdf({ submissionId }) {
    const { base, key } = cfg();
    const res = await fetch(`${base}/submissions/${submissionId}`, { headers: { "X-Auth-Token": key } });
    if (!res.ok) throw new Error(`docuseal getSubmission -> ${res.status}`);
    const sub = (await res.json()) as { documents?: Array<{ url: string }>; combined_document_url?: string };
    const url = sub.combined_document_url ?? sub.documents?.[0]?.url;
    if (!url) throw new Error("docuseal: no signed document url");
    const pdfRes = await fetch(url);
    if (!pdfRes.ok) throw new Error(`docuseal download -> ${pdfRes.status}`);
    return { bytes: new Uint8Array(await pdfRes.arrayBuffer()), mime: "application/pdf" };
  },
};

export function makeFakeDocuseal(): DocusealGateway & { calls: { op: string }[] } {
  const calls: { op: string }[] = [];
  let n = 0;
  return {
    calls,
    async createSubmission() {
      const submissionId = `sub_fake_${++n}`;
      calls.push({ op: "create" });
      return { submissionId, signingUrl: `https://docuseal.test/s/${submissionId}` };
    },
    verifyWebhook(rawBody) {
      calls.push({ op: "verify" });
      try {
        const p = JSON.parse(rawBody) as { submissionId?: string; status?: "completed" | "declined" };
        if (!p.submissionId || (p.status !== "completed" && p.status !== "declined")) return null;
        return { submissionId: p.submissionId, status: p.status };
      } catch {
        return null;
      }
    },
    async downloadSignedPdf() {
      calls.push({ op: "download" });
      return { bytes: new Uint8Array([37, 80, 68, 70]), mime: "application/pdf" }; // %PDF
    },
  };
}
```

- [ ] **Step 4: Export from the integrations barrel**

In `packages/integrations/src/index.ts`, add after the `r2Storage` export line:

```typescript
export { docusealGateway, makeFakeDocuseal, type DocusealGateway } from "./docuseal";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @savvy/integrations exec vitest run src/docuseal.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/integrations/src/docuseal.ts packages/integrations/src/docuseal.test.ts packages/integrations/src/index.ts
git commit -m "feat(integrations): DocusealGateway (real + fake)"
```

---

## Task 7: Agents — `esign/completed` event + `esignFinalize`

**Files:**
- Modify: `packages/agents/src/client.ts`
- Create: `packages/agents/src/functions/esign-finalize.ts`
- Create: `packages/agents/src/functions/esign-finalize.test.ts`
- Modify: `packages/agents/src/index.ts`

- [ ] **Step 1: Register the event type**

In `packages/agents/src/client.ts`, add to the `Events` type (after the `"invoice/void"` line):

```typescript
  "esign/completed": { data: { requestId: string; tenantId: string } };
```

- [ ] **Step 2: Write the failing integration test**

Create `packages/agents/src/functions/esign-finalize.test.ts` (mirror the tenant/customer/property/job insert columns from `packages/db/tests/isolation.test.ts` — read it for the exact required `property`/`job` columns):

```typescript
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import {
  adminDb, adminPool, pool, eq,
  tenant, customer, property, job, document, esignRequest,
} from "@savvy/db";
import { makeFakeDocuseal, makeFakeStorage } from "@savvy/integrations";
import { finalizeEsign } from "./esign-finalize";

let tId: string, custId: string, propId: string, jobId: string, reqId: string;

beforeAll(async () => {
  const [t] = await adminDb.insert(tenant).values({ name: "EF", publicKey: "ef", clerkOrgId: "org_ef" }).returning();
  tId = t!.id;
  const [c] = await adminDb.insert(customer).values({ tenantId: tId, name: "Pat", email: "pat@x.com" }).returning();
  custId = c!.id;
  const [p] = await adminDb.insert(property).values({ tenantId: tId, customerId: custId, address: "1 Main St" }).returning();
  propId = p!.id;
  const [j] = await adminDb.insert(job).values({ tenantId: tId, customerId: custId, propertyId: propId }).returning();
  jobId = j!.id;
  const [r] = await adminDb.insert(esignRequest).values({
    tenantId: tId, jobId, customerId: custId, docType: "cert",
    templateId: "tpl", docusealSubmissionId: "sub_ef_1", status: "completed",
  }).returning();
  reqId = r!.id;
});

afterAll(async () => {
  await adminDb.delete(esignRequest).where(eq(esignRequest.tenantId, tId));
  await adminDb.delete(document).where(eq(document.tenantId, tId));
  await adminDb.delete(job).where(eq(job.tenantId, tId));
  await adminDb.delete(property).where(eq(property.tenantId, tId));
  await adminDb.delete(customer).where(eq(customer.tenantId, tId));
  await adminDb.delete(tenant).where(eq(tenant.id, tId));
  await pool.end();
  await adminPool.end();
});

describe("finalizeEsign", () => {
  it("downloads the PDF, stores a document, and links it to the request", async () => {
    const docuseal = makeFakeDocuseal();
    const storage = makeFakeStorage();
    const r = await finalizeEsign({ tenantId: tId, requestId: reqId }, { docuseal, storage });
    expect(r.stored).toBe(true);

    const docs = await adminDb.select().from(document).where(eq(document.jobId, jobId));
    expect(docs.length).toBe(1);
    expect(docs[0]!.source).toBe("docuseal");
    expect(docs[0]!.kind).toBe("cert");
    expect(docs[0]!.r2Key).toContain(`${tId}/${jobId}/esign-${reqId}`);
    expect(storage.calls.some((c) => c.op === "put")).toBe(true);

    const [er] = await adminDb.select().from(esignRequest).where(eq(esignRequest.id, reqId));
    expect(er!.documentId).toBe(docs[0]!.id);
  });

  it("is idempotent — a second run stores nothing new", async () => {
    const docuseal = makeFakeDocuseal();
    const storage = makeFakeStorage();
    const r = await finalizeEsign({ tenantId: tId, requestId: reqId }, { docuseal, storage });
    expect(r.stored).toBe(false);
    expect(r.reason).toBe("already_finalized");

    const docs = await adminDb.select().from(document).where(eq(document.jobId, jobId));
    expect(docs.length).toBe(1); // still just the one from the first test
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @savvy/agents exec vitest run src/functions/esign-finalize.test.ts`
Expected: FAIL — `Cannot find module './esign-finalize'`.

- [ ] **Step 4: Write the implementation**

Create `packages/agents/src/functions/esign-finalize.ts`:

```typescript
import { withTenant, eq, esignRequest, document } from "@savvy/db";
import type { DocusealGateway, StorageGateway } from "@savvy/integrations";
import { docusealGateway, r2Storage } from "@savvy/integrations";
import { inngest } from "../client";

/**
 * Pure helper (injectable deps) so it can be tested with fake gateways against a
 * real DB. Idempotent: if the request already has a documentId, store nothing.
 * Bytes never cross a step boundary — download + store + record happen here.
 */
export async function finalizeEsign(
  input: { tenantId: string; requestId: string },
  deps: { docuseal: DocusealGateway; storage: StorageGateway },
): Promise<{ stored: boolean; reason?: string }> {
  const { tenantId, requestId } = input;

  const req = await withTenant(tenantId, async (tx) => {
    const [r] = await tx
      .select({
        jobId: esignRequest.jobId,
        customerId: esignRequest.customerId,
        docType: esignRequest.docType,
        submissionId: esignRequest.docusealSubmissionId,
        documentId: esignRequest.documentId,
      })
      .from(esignRequest)
      .where(eq(esignRequest.id, requestId));
    return r ?? null;
  });
  if (!req) return { stored: false, reason: "not_found" };
  if (req.documentId) return { stored: false, reason: "already_finalized" };

  const pdf = await deps.docuseal.downloadSignedPdf({ submissionId: req.submissionId });
  const key = `${tenantId}/${req.jobId}/esign-${requestId}.pdf`;
  await deps.storage.putObject({ key, bytes: pdf.bytes, contentType: pdf.mime });

  await withTenant(tenantId, async (tx) => {
    const [doc] = await tx
      .insert(document)
      .values({
        tenantId,
        jobId: req.jobId,
        customerId: req.customerId,
        kind: req.docType,
        r2Key: key,
        filename: `${req.docType}.pdf`,
        mime: pdf.mime,
        sizeBytes: pdf.bytes.byteLength,
        source: "docuseal",
      })
      .returning({ id: document.id });
    await tx.update(esignRequest).set({ documentId: doc!.id }).where(eq(esignRequest.id, requestId));
  });

  return { stored: true };
}

export const esignFinalize = inngest.createFunction(
  { id: "esign-finalize", concurrency: { limit: 10 } },
  { event: "esign/completed" },
  async ({ event, step }) =>
    step.run("finalize", () =>
      finalizeEsign(event.data, { docuseal: docusealGateway, storage: r2Storage }),
    ),
);
```

- [ ] **Step 5: Register the function**

In `packages/agents/src/index.ts`:
- Add import: `import { esignFinalize } from "./functions/esign-finalize";`
- Add export: `export { esignFinalize } from "./functions/esign-finalize";`
- Add `esignFinalize` to the end of the `functions` array.

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm --filter @savvy/agents exec vitest run src/functions/esign-finalize.test.ts`
Expected: PASS (2 tests). If `property`/`job` inserts fail on a missing column, copy the exact column set from `packages/db/tests/isolation.test.ts`.

- [ ] **Step 7: Typecheck the package**

Run: `pnpm --filter @savvy/agents typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/agents/src/client.ts packages/agents/src/functions/esign-finalize.ts packages/agents/src/functions/esign-finalize.test.ts packages/agents/src/index.ts
git commit -m "feat(agents): esignFinalize durably stores the signed PDF"
```

---

## Task 8: Web — `sendForSignature` server action

**Files:**
- Create: `apps/web/src/lib/esign-actions.ts`

(No unit test here — this repo tests server actions through Playwright e2e in Task 11. The DocuSeal call, prefill, and config resolution are covered by Tasks 1/6; this action wires them.)

- [ ] **Step 1: Write the server action**

Create `apps/web/src/lib/esign-actions.ts`:

```typescript
"use server";
import { withTenant, adminDb, tenant, job, customer, property, esignRequest, eq } from "@savvy/db";
import { docusealGateway } from "@savvy/integrations";
import {
  parseEsignConfig, resolveEsignTemplate, buildEsignPrefill, ESIGN_DOC_TYPE, type EsignDocType,
} from "@savvy/core";
import { revalidatePath } from "next/cache";
import { getTenantId } from "./tenant";

type SendResult =
  | { ok: true; requestId: string; signingUrl: string }
  | { error: "bad_doc_type" | "not_found" | "no_customer_email" | "docuseal_failed" };

export async function sendForSignature(input: { jobId: string; docType: EsignDocType }): Promise<SendResult> {
  if (!ESIGN_DOC_TYPE.includes(input.docType)) return { error: "bad_doc_type" };
  const tenantId = await getTenantId();

  // Read job + customer + property in one tenant-scoped transaction.
  const ctx = await withTenant(tenantId, async (tx) => {
    const [j] = await tx
      .select({
        customerId: job.customerId,
        propertyId: job.propertyId,
        valueFinal: job.valueFinal,
        valueEstimate: job.valueEstimate,
      })
      .from(job)
      .where(eq(job.id, input.jobId));
    if (!j) return null;
    const [c] = await tx.select({ name: customer.name, email: customer.email }).from(customer).where(eq(customer.id, j.customerId));
    const [p] = await tx.select({ address: property.address }).from(property).where(eq(property.id, j.propertyId));
    return { j, c, p };
  });
  if (!ctx) return { error: "not_found" };
  if (!ctx.c?.email) return { error: "no_customer_email" };

  // tenant.settings has no RLS — read via adminDb.
  const [t] = await adminDb.select({ settings: tenant.settings }).from(tenant).where(eq(tenant.id, tenantId));
  const cfg = parseEsignConfig((t?.settings as { esign?: unknown } | undefined)?.esign);
  const fallback =
    input.docType === "lien_waiver"
      ? process.env.DOCUSEAL_TEMPLATE_LIEN_WAIVER ?? ""
      : process.env.DOCUSEAL_TEMPLATE_CERT ?? "";
  const templateId = resolveEsignTemplate(cfg, input.docType, fallback);

  const amountCents = ctx.j.valueFinal ?? ctx.j.valueEstimate ?? null;
  const amount = amountCents != null ? `$${(amountCents / 100).toFixed(2)}` : "";
  const date = new Date().toISOString().slice(0, 10);
  const fields = buildEsignPrefill(input.docType, {
    customerName: ctx.c.name,
    propertyAddress: ctx.p?.address ?? "",
    date,
    amount,
  });

  // Outbound HTTP OUTSIDE the transaction.
  let submission: { submissionId: string; signingUrl: string };
  try {
    submission = await docusealGateway.createSubmission({
      templateId,
      signer: { name: ctx.c.name, email: ctx.c.email },
      fields,
      metadata: { tenantId, jobId: input.jobId, docType: input.docType },
    });
  } catch {
    return { error: "docuseal_failed" };
  }

  const requestId = await withTenant(tenantId, async (tx) => {
    const [row] = await tx
      .insert(esignRequest)
      .values({
        tenantId,
        jobId: input.jobId,
        customerId: ctx.j.customerId,
        docType: input.docType,
        templateId,
        docusealSubmissionId: submission.submissionId,
        status: "sent",
        signingUrl: submission.signingUrl,
        sentAt: new Date(),
      })
      .returning({ id: esignRequest.id });
    return row!.id;
  });

  revalidatePath(`/jobs/${input.jobId}`);
  return { ok: true, requestId, signingUrl: submission.signingUrl };
}
```

- [ ] **Step 2: Typecheck the web app**

Run: `pnpm --filter @savvy/web typecheck`
Expected: PASS. (Confirms `property`, `esignRequest`, `tenant.settings` etc. all resolve from `@savvy/db`. If `property` isn't exported from `@savvy/db`, check `packages/db/src/schema/index.ts` — it should already be re-exported since the job page joins it.)

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/lib/esign-actions.ts
git commit -m "feat(web): sendForSignature server action"
```

---

## Task 9: Web — public webhook route + middleware

**Files:**
- Create: `apps/web/src/app/api/docuseal/webhook/route.ts`
- Modify: `apps/web/src/middleware.ts`

- [ ] **Step 1: Write the webhook route**

Create `apps/web/src/app/api/docuseal/webhook/route.ts`:

```typescript
import { NextResponse } from "next/server";
import { docusealGateway } from "@savvy/integrations";
import { markEsignBySubmission } from "@savvy/db";
import { inngest } from "@savvy/agents";

export const runtime = "nodejs";

export async function POST(req: Request): Promise<NextResponse> {
  const raw = await req.text(); // raw body required for signature verification
  const sig = req.headers.get("x-docuseal-signature");
  const evt = docusealGateway.verifyWebhook(raw, sig);
  if (!evt) return new NextResponse("bad signature", { status: 400 });

  try {
    const r = await markEsignBySubmission({ submissionId: evt.submissionId, status: evt.status });
    // Only emit when we actually transitioned a request into completed (idempotent).
    if (r && r.changed && evt.status === "completed") {
      try {
        await inngest.send({ name: "esign/completed", data: { requestId: r.requestId, tenantId: r.tenantId } });
      } catch (e) {
        console.error(e);
      }
    }
  } catch (e) {
    // Unknown/duplicate handled inside markEsignBySubmission; log other errors but still 200
    // so DocuSeal doesn't hammer retries on a poison event.
    console.error("docuseal webhook", e);
  }
  return NextResponse.json({ received: true });
}
```

- [ ] **Step 2: Add the route to the PUBLIC allowlist**

In `apps/web/src/middleware.ts`, add `/^\/api\/docuseal\/webhook$/` to the `PUBLIC` array (next to `/^\/api\/stripe\/webhook$/`):

```typescript
const PUBLIC = [/^\/intake\//, /^\/api\/leads$/, /^\/api\/twilio\//, /^\/api\/inngest$/, /^\/api\/stripe\/webhook$/, /^\/api\/docuseal\/webhook$/];
```

- [ ] **Step 3: Typecheck the web app**

Run: `pnpm --filter @savvy/web typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/app/api/docuseal/webhook/route.ts apps/web/src/middleware.ts
git commit -m "feat(web): public DocuSeal webhook route"
```

---

## Task 10: Web — "E-sign" tab UI

**Files:**
- Create: `apps/web/src/app/(app)/jobs/[id]/EsignPanel.tsx`
- Modify: `apps/web/src/app/(app)/jobs/[id]/page.tsx`
- Modify: `apps/web/src/app/(app)/jobs/[id]/tabs.tsx`

- [ ] **Step 1: Build the client panel**

Create `apps/web/src/app/(app)/jobs/[id]/EsignPanel.tsx`:

```tsx
"use client";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { sendForSignature } from "@/lib/esign-actions";
import { presignDocumentView } from "@/lib/document-actions";

export type EsignRow = {
  id: string;
  docType: string;
  status: string;
  signingUrl: string | null;
  documentId: string | null;
};

function statusBadge(status: string) {
  if (status === "completed") return <Badge variant="secondary">Completed</Badge>;
  if (status === "declined") return <Badge variant="destructive">Declined</Badge>;
  if (status === "voided") return <Badge variant="outline">Voided</Badge>;
  return <Badge variant="outline">Sent</Badge>;
}

const DOC_LABEL: Record<string, string> = { lien_waiver: "Lien waiver", cert: "Certificate of completion" };

export function EsignPanel({
  jobId,
  customerEmail,
  requests,
}: {
  jobId: string;
  customerEmail: string | null;
  requests: EsignRow[];
}) {
  const [docType, setDocType] = useState<"lien_waiver" | "cert">("lien_waiver");
  const [busy, setBusy] = useState(false);

  async function handleSend() {
    setBusy(true);
    const res = await sendForSignature({ jobId, docType });
    setBusy(false);
    if ("ok" in res) {
      toast.success("Sent for signature — DocuSeal emailed the customer.");
    } else if (res.error === "no_customer_email") {
      toast.error("Add a customer email before sending for signature.");
    } else if (res.error === "docuseal_failed") {
      toast.error("DocuSeal is not configured or unreachable.");
    } else {
      toast.error("Could not send for signature.");
    }
  }

  async function copyLink(url: string) {
    await navigator.clipboard.writeText(url);
    toast.success("Signing link copied.");
  }

  async function viewSigned(documentId: string) {
    const res = await presignDocumentView(documentId);
    if ("ok" in res) window.open(res.url, "_blank", "noreferrer");
    else toast.error("Could not load the signed document.");
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <select
          value={docType}
          onChange={(e) => setDocType(e.target.value as "lien_waiver" | "cert")}
          className="h-9 rounded-md border border-input bg-background px-3 text-sm"
          aria-label="Document type"
        >
          <option value="lien_waiver">Lien waiver</option>
          <option value="cert">Certificate of completion</option>
        </select>
        <Button onClick={handleSend} disabled={busy || !customerEmail}>
          {busy ? "Sending…" : "Send for signature"}
        </Button>
        {!customerEmail && <span className="text-xs text-muted-foreground">Customer email required</span>}
      </div>

      {requests.length === 0 ? (
        <p className="text-sm text-muted-foreground">No signature requests yet.</p>
      ) : (
        <ul className="space-y-2">
          {requests.map((r) => (
            <li key={r.id} className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-sm">
              <span className="flex items-center gap-2">
                {statusBadge(r.status)}
                <span>{DOC_LABEL[r.docType] ?? r.docType}</span>
              </span>
              <span className="flex items-center gap-2">
                {r.status === "sent" && r.signingUrl && (
                  <Button variant="outline" size="sm" onClick={() => copyLink(r.signingUrl!)}>
                    Copy link
                  </Button>
                )}
                {r.status === "completed" && r.documentId && (
                  <Button variant="outline" size="sm" onClick={() => viewSigned(r.documentId!)}>
                    View signed PDF
                  </Button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Load esign requests in the page data fetch**

In `apps/web/src/app/(app)/jobs/[id]/page.tsx`:

a) Add `esignRequest` to the `@savvy/db` import.

b) Inside the `withTenant(tenantId, async (tx) => { ... })` block (where `docRows` is selected), add an esign query and include it in the returned object:

```typescript
    const esignRows = await tx
      .select({
        id: esignRequest.id,
        docType: esignRequest.docType,
        status: esignRequest.status,
        signingUrl: esignRequest.signingUrl,
        documentId: esignRequest.documentId,
      })
      .from(esignRequest)
      .where(eq(esignRequest.jobId, id))
      .orderBy(desc(esignRequest.createdAt));
```

Add `esignRows` to the object this callback returns (alongside `docRows`, `tenantRow`, etc.).

c) When rendering `<JobTabs .../>`, pass two new props (the customer email is already selected as `customerEmail` in the job row query — reuse it):

```tsx
        esignRequests={data.esignRows}
        customerEmail={data.jobRow.customerEmail ?? null}
```

- [ ] **Step 3: Add the tab**

In `apps/web/src/app/(app)/jobs/[id]/tabs.tsx`:

a) Import the panel + its row type at the top:
```typescript
import { EsignPanel, type EsignRow } from "./EsignPanel";
```

b) Extend the `JobTabs` props type with:
```typescript
  esignRequests: EsignRow[];
  customerEmail: string | null;
```
and add `esignRequests` + `customerEmail` to the destructured params.

c) Add a trigger inside `<TabsList>` after the Docs trigger:
```tsx
        <TabsTrigger value="esign">E-sign</TabsTrigger>
```

d) Add the content after the Docs `<TabsContent>`:
```tsx
      <TabsContent value="esign">
        <EsignPanel jobId={jobId} customerEmail={customerEmail} requests={esignRequests} />
      </TabsContent>
```

- [ ] **Step 4: Typecheck + lint the web app**

Run: `pnpm --filter @savvy/web typecheck && pnpm --filter @savvy/web lint`
Expected: PASS, 0 errors. (Confirm `sonner`'s `toast` import path matches `DocsPanel.tsx`. Confirm `desc` is imported in `page.tsx` — it's already used for `docRows`.)

- [ ] **Step 5: Commit**

```bash
git add "apps/web/src/app/(app)/jobs/[id]/EsignPanel.tsx" "apps/web/src/app/(app)/jobs/[id]/page.tsx" "apps/web/src/app/(app)/jobs/[id]/tabs.tsx"
git commit -m "feat(web): E-sign tab on job detail"
```

---

## Task 11: e2e — send → webhook → completed

The e2e exercises the UI send (against a tiny DocuSeal stub server, like the existing `ai-stub.mjs`) and the webhook status flip. The document-storage finalize (R2) is covered by Task 7's integration test, not e2e (e2e has no R2 creds); `esignFinalize` will run in inngest-dev and no-op/error harmlessly without R2 — the request is already `completed`. `DOCUSEAL_WEBHOOK_SECRET` is left empty in e2e so `verifyWebhook` skips HMAC and accepts the simulated webhook body.

**Files:**
- Create: `apps/web/tests/e2e/docuseal-stub.mjs`
- Create: `apps/web/tests/e2e/esign.spec.ts`

- [ ] **Step 1: Write the DocuSeal stub server**

Create `apps/web/tests/e2e/docuseal-stub.mjs` (model on `apps/web/tests/e2e/ai-stub.mjs`):

```javascript
import { createServer } from "node:http";

const PORT = Number(process.env.DOCUSEAL_STUB_PORT ?? 4020);
let n = 0;

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    res.setHeader("content-type", "application/json");
    if (req.method === "POST" && req.url === "/submissions") {
      n += 1;
      res.end(JSON.stringify([{ submission_id: n, slug: `slug${n}`, embed_src: `http://localhost:${PORT}/s/slug${n}` }]));
      return;
    }
    if (req.method === "GET" && req.url?.startsWith("/submissions/")) {
      res.end(JSON.stringify({ combined_document_url: `http://localhost:${PORT}/pdf` }));
      return;
    }
    if (req.method === "GET" && req.url === "/pdf") {
      res.setHeader("content-type", "application/pdf");
      res.end(Buffer.from([0x25, 0x50, 0x44, 0x46])); // %PDF
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
});
server.listen(PORT, () => console.log(`docuseal-stub on ${PORT}`));
```

- [ ] **Step 2: Write the e2e spec**

Create `apps/web/tests/e2e/esign.spec.ts`. It seeds a job + customer-with-email via the test-tenant helper data path used by other specs (read an existing spec under `apps/web/tests/e2e/` to match how a job is created/opened). The test then: opens the job, switches to the E-sign tab, sends a lien waiver, asserts a "Sent" row with a Copy-link button appears, POSTs a simulated webhook, and asserts the row flips to "Completed":

```typescript
import { test, expect } from "@playwright/test";

// Assumes a seeded job exists for the test tenant. Reuse the job-creation/open
// pattern from the sibling e2e specs (e.g. the docs/photos spec) to get a jobId
// with a customer that has an email.
test("send for signature, then webhook marks it completed", async ({ page, request }) => {
  // --- open a job (replace with the shared helper used by other specs) ---
  await page.goto("/jobs");
  await page.getByRole("link").first().click(); // first job in the list
  await page.getByRole("button", { name: "E-sign" }).click(); // TabsTrigger renders a <button>

  // --- send ---
  await page.getByRole("button", { name: "Send for signature" }).click();
  await expect(page.getByText("Sent", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy link" })).toBeVisible();

  // --- simulate the DocuSeal webhook (empty secret => no signature needed) ---
  // submission_id 1 is the first stub submission created above.
  const res = await request.post("/api/docuseal/webhook", {
    headers: { "content-type": "application/json" },
    data: { event_type: "submission.completed", data: { submission_id: 1 } },
  });
  expect(res.status()).toBe(200);

  // --- the request flips to completed (reload to re-read) ---
  await page.reload();
  await page.getByRole("button", { name: "E-sign" }).click();
  await expect(page.getByText("Completed", { exact: true })).toBeVisible();
});
```

- [ ] **Step 3: Run the e2e (full harness)**

From repo root, with Docker Postgres up:

```bash
export DATABASE_URL=postgres://savvy_app:savvy_app@localhost:5432/savvy
export DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/savvy
export AI_STUB_PORT=4010 INNGEST_DEV=1
export DOCUSEAL_BASE_URL=http://localhost:4020 DOCUSEAL_API_KEY=test DOCUSEAL_WEBHOOK_SECRET=
node apps/web/tests/e2e/ai-stub.mjs &
node apps/web/tests/e2e/docuseal-stub.mjs &
npx --yes inngest-cli@latest dev -u http://localhost:3000/api/inngest --no-discovery &
pnpm --filter @savvy/web exec tsx tests/e2e/create-tenant.ts
export TEST_TENANT_ID=$(node -e "console.log(require('/tmp/savvy-e2e-tenant.json').id)")
pnpm --filter @savvy/web exec playwright test esign.spec.ts
```

Expected: PASS. Then kill the backgrounded stubs + inngest-dev.

Note: if the sibling specs use a dedicated seed/helper to create a job (rather than clicking the first list row), adopt that helper here so the test is deterministic. The first-row click is a fallback.

- [ ] **Step 4: Commit**

```bash
git add apps/web/tests/e2e/docuseal-stub.mjs apps/web/tests/e2e/esign.spec.ts
git commit -m "test(e2e): esign send + webhook completes the request"
```

---

## Task 12: Docs/env + full gate

**Files:**
- Modify: `.env.example`

- [ ] **Step 1: Document the DocuSeal env**

Append to `.env.example` (near the R2 / integration vars):

```bash
# DocuSeal e-sign (Phase 6B) — Savvy-mediated single instance
DOCUSEAL_BASE_URL=
DOCUSEAL_API_KEY=
DOCUSEAL_WEBHOOK_SECRET=
DOCUSEAL_TEMPLATE_LIEN_WAIVER=
DOCUSEAL_TEMPLATE_CERT=
```

- [ ] **Step 2: Relink + run the full gate**

```bash
pnpm install
pnpm typecheck && pnpm lint && pnpm test
```

Expected: typecheck clean, lint 0 errors (pre-existing test-file WARNINGS OK), all tests green (prior suite count + the new core/integrations/db/agents tests).

- [ ] **Step 3: Commit**

```bash
git add .env.example
git commit -m "docs: document DOCUSEAL_* env for Phase 6B"
```

---

## Self-Review — Spec Coverage Check

| Spec section | Covered by |
|---|---|
| §2 Both doc types | Task 1 (`ESIGN_DOC_TYPE`), Task 8/10 (both selectable) |
| §2 Savvy-mediated DocuSeal | Task 6 (`DOCUSEAL_BASE_URL`/`X-Auth-Token`) |
| §2 Standard templates w/ tenant override | Task 1 (`resolveEsignTemplate`), Task 8 (env fallback) |
| §2 No completion gating | No gate code added anywhere (verified — Task list touches no stage-change logic) |
| §2 Meterable unit | Task 2 (`esign_request` row), `completed` status is the unit |
| §4.1 `esign_request` table + unique idempotency index | Task 2 |
| §4.2 `document.source: "docuseal"` | Task 7 (insert `source: "docuseal"`) |
| §4.3 `tenant.settings.esign` | Task 1 parser + Task 8 read |
| §5 DocusealGateway (3 methods, real + fake) | Task 6 |
| §6 Send action (email required, template resolve, I/O outside tx) | Task 8 |
| §7.1 Public webhook (verify, 200 fast, idempotent) | Task 4 + Task 9 |
| §7.2 `esignFinalize` durable store + idempotent | Task 7 |
| §8 Prefill builder | Task 1 |
| §9 UI (send, list, copy-link, signed-PDF link) | Task 10 |
| §11 Tests (unit/gateway/integration/RLS/e2e) | Tasks 1,3,4,5,6,7,11 |
| §12 DoD (migration 0007, RLS test, no provider strings, env documented) | Tasks 2,3,6,12 |

**Decision deviations from spec, by design:**
- The spec's §11 e2e said "signed doc appears." This plan scopes e2e to the `completed` status flip (Task 11) and verifies the actual signed-PDF document storage in the Task 7 integration test, because e2e has no R2 credentials. This is a stronger, deterministic split — flagged here for the reviewer.
- Added `StorageGateway.putObject` (Task 5) — not named in the spec, but required because the 6A gateway only presigns browser URLs and `esignFinalize` stores bytes server-side. Minimal, reuses the existing S3 client.

**Type consistency check:** `DocusealGateway.downloadSignedPdf({ submissionId })` (Task 6) matches `finalizeEsign`'s call (Task 7). `markEsignBySubmission` return `{ tenantId, requestId, changed }` (Task 4) matches the webhook's usage (Task 9). `EsignRow` shape (Task 10) matches the `esignRows` select (page.tsx). `esign/completed` payload `{ requestId, tenantId }` is identical in client.ts (Task 7-1), the webhook emit (Task 9), and the function input (Task 7-4). ✓
