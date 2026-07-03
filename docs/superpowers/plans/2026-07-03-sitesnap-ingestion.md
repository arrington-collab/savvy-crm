# SiteSnap Ingestion (Slice 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ingest SiteSnap-captured photos into Savvy jobs via a Savvy-defined inbound webhook — resolve the job by property address, copy image bytes to R2, store a `document` row, emit `photo/ingested`, and surface address-misses in a `photo_unmatched` Needs-you exception.

**Architecture:** Mirror the proven CompanyCam webhook (`apps/web/src/app/api/companycam/webhook/route.ts` + `recordCompanyCamPhoto`), swapping HMAC→bearer-key auth and project-id→address matching, adding an R2 byte-copy. Ingestion orchestration lives in a testable `@/lib` function; the route is a thin wrapper. QC (Slice 2) is a separate plan that consumes `photo/ingested`.

**Tech Stack:** TypeScript, Next.js App Router (route handler), Drizzle+Postgres (RLS), Inngest, Cloudflare R2 (`@savvy/integrations` storage), Vitest, pnpm monorepo.

## Global Constraints

- **Tenant isolation (non-negotiable):** every DB access via `withTenant(tenantId, ...)`; the webhook resolves the tenant from its ingestion key on the admin path (like `recordCompanyCamPhoto`), then all row writes are RLS-scoped.
- **Events emitted only from `apps/web`** (route handlers / server actions), never from `@savvy/db`.
- **Fail-soft `photo/ingested` emission** — an Inngest hiccup must not fail the webhook (the row is already written).
- **Idempotency:** a repeat webhook for the same `(tenantId, sitesnapPhotoId)` is a no-op (mirrors CompanyCam's `companycamPhotoId` dedupe).
- **No secrets in the repo;** the ingestion key lives in `tenant.settings.sitesnap.ingestKey`.
- **Job stages** are `["lead","inspected","estimate","approved","production","closeout","billing","complete","lost"]` — "open" means stage NOT in (`complete`, `lost`).
- **Commit trailer:** every commit body ends with
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- **Test commands:** pure → `pnpm --filter @savvy/core vitest run <file>`; db/web integration → run from the package with `pnpm vitest run <file>` against the local Postgres test DB. Migrations: edit schema → `pnpm db:generate` → `pnpm db:migrate`.

---

### Task 1: `document` schema columns + migration

**Files:**
- Modify: `packages/db/src/schema/ops.ts` (the `document` table)
- Generate: a new SQL migration under `packages/db/` (via `pnpm db:generate`)
- Test: `packages/db/src/lifecycle/sitesnap-schema.test.ts` (create — a smoke test that the columns exist)

**Interfaces:**
- Produces: `document.phash`, `document.qcStatus` (default `'pending'`), `document.qcReasons` (jsonb), `document.captureAddress`, `document.sitesnapPhotoId`; a partial-unique index on `(tenant_id, sitesnap_photo_id)`.

- [ ] **Step 1: Add the columns to the schema**

In `packages/db/src/schema/ops.ts`, inside the `document` pgTable (after `companycamPhotoId`), add:

```ts
  sitesnapPhotoId: text("sitesnap_photo_id"),          // dedupe key for the SiteSnap webhook
  captureAddress: text("capture_address"),             // raw address from the producer (for unmatched re-match)
  phash: text("phash"),                                // perceptual hash (Slice 2 dedup)
  qcStatus: text("qc_status").default("pending"),      // pending|passed|flagged|skipped
  qcReasons: jsonb("qc_reasons").$type<unknown>(),     // structured QC reasons (Slice 2)
```

And add a partial-unique index in the table's index array (alongside `document_tenant_job_idx`):

```ts
  uniqueIndex("document_tenant_sitesnap_uniq").on(t.tenantId, t.sitesnapPhotoId).where(sql`${t.sitesnapPhotoId} is not null`),
```

Ensure `uniqueIndex` and `sql` are imported at the top of the file (check existing imports — `jsonb` is already used by this table; add `uniqueIndex`/`sql` from `drizzle-orm`/`drizzle-orm/pg-core` if missing, matching how other schema files import them).

- [ ] **Step 2: Generate + apply the migration**

Run: `pnpm db:generate`
Expected: a new `packages/db/drizzle/*.sql` (or configured migrations dir) adding the 5 columns + the unique index. Inspect it — it must be additive only (no drops).
Run: `pnpm db:migrate`
Expected: applies cleanly to the local test DB.

- [ ] **Step 3: Write a smoke test**

Create `packages/db/src/lifecycle/sitesnap-schema.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { adminDb, tenant, customer, property, job, document, eq } from "../index";

describe("document sitesnap columns", () => {
  it("accepts the new sitesnap/qc columns and defaults qcStatus to 'pending'", async () => {
    const [t] = await adminDb.insert(tenant).values({ name: "SS", publicKey: `pk-${crypto.randomUUID()}`, clerkOrgId: `org-${crypto.randomUUID()}` }).returning();
    const [c] = await adminDb.insert(customer).values({ tenantId: t!.id, name: "C" }).returning();
    const [p] = await adminDb.insert(property).values({ tenantId: t!.id, customerId: c!.id, address: "1 A St" }).returning();
    const [j] = await adminDb.insert(job).values({ tenantId: t!.id, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "production" }).returning();
    const [d] = await adminDb.insert(document).values({
      tenantId: t!.id, jobId: j!.id, kind: "photo", source: "sitesnap",
      label: "ridge", sitesnapPhotoId: "ss-1", captureAddress: "1 A St",
    }).returning();
    expect(d!.qcStatus).toBe("pending");
    expect(d!.sitesnapPhotoId).toBe("ss-1");
  });
});
```

- [ ] **Step 4: Run the smoke test**

Run: `cd packages/db && pnpm vitest run src/lifecycle/sitesnap-schema.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/schema/ops.ts packages/db/drizzle packages/db/src/lifecycle/sitesnap-schema.test.ts
git commit -m "feat(db): document columns for SiteSnap ingestion + QC (migration)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Address normalization (pure)

**Files:**
- Create: `packages/core/src/address.ts`
- Create: `packages/core/src/address.test.ts`
- Modify: `packages/core/src/index.ts` (barrel — add `export * from "./address";`)

**Interfaces:**
- Produces: `normalizeAddress(raw: string): string` — lowercased, trimmed, whitespace-collapsed, common street-suffix abbreviations standardized, punctuation stripped. Deterministic; used both when ingesting and when indexing properties for match.

- [ ] **Step 1: Write the failing tests**

Create `packages/core/src/address.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { normalizeAddress } from "./address";

describe("normalizeAddress", () => {
  it("lowercases, trims, and collapses whitespace", () => {
    expect(normalizeAddress("  123   Main   St  ")).toBe("123 main st");
  });
  it("standardizes common suffix abbreviations", () => {
    expect(normalizeAddress("123 Main Street")).toBe("123 main st");
    expect(normalizeAddress("5 Oak Avenue")).toBe("5 oak ave");
    expect(normalizeAddress("9 Elm Drive")).toBe("9 elm dr");
  });
  it("strips punctuation so equivalent addresses match", () => {
    expect(normalizeAddress("123 Main St.")).toBe(normalizeAddress("123 Main Street"));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/core && pnpm vitest run src/address.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `packages/core/src/address.ts`:

```ts
const SUFFIX: Record<string, string> = {
  street: "st", st: "st", avenue: "ave", ave: "ave", av: "ave",
  drive: "dr", dr: "dr", road: "rd", rd: "rd", lane: "ln", ln: "ln",
  boulevard: "blvd", blvd: "blvd", court: "ct", ct: "ct", place: "pl", pl: "pl",
  circle: "cir", cir: "cir", terrace: "ter", ter: "ter", highway: "hwy", hwy: "hwy",
};

/** Normalize a street address for fuzzy equality: lowercase, strip punctuation,
 *  collapse whitespace, and standardize common street-suffix words. */
export function normalizeAddress(raw: string): string {
  const cleaned = raw.toLowerCase().replace(/[.,#]/g, " ").replace(/\s+/g, " ").trim();
  return cleaned
    .split(" ")
    .map((tok) => SUFFIX[tok] ?? tok)
    .join(" ");
}
```

- [ ] **Step 4: Barrel export + run tests**

Add `export * from "./address";` to `packages/core/src/index.ts` (alongside the other `export * from` lines).
Run: `cd packages/core && pnpm vitest run src/address.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/address.ts packages/core/src/address.test.ts packages/core/src/index.ts
git commit -m "feat(core): normalizeAddress for photo→property matching

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `resolvePhotoJob` + `resolveTenantByIngestKey` (db)

**Files:**
- Create: `packages/db/src/lifecycle/photos.ts`
- Modify: `packages/db/src/index.ts` (export both)
- Test: `packages/db/src/lifecycle/photos-resolve.test.ts` (create)

**Interfaces:**
- Consumes: `normalizeAddress` (`@savvy/core`).
- Produces:
  ```ts
  resolvePhotoJob(input: { tenantId: string; address: string }): Promise<{ jobId: string } | null>
  resolveTenantByIngestKey(key: string): Promise<{ tenantId: string } | null>
  ```

- [ ] **Step 1: Write the failing integration tests**

Create `packages/db/src/lifecycle/photos-resolve.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { adminDb, tenant, customer, property, job, eq } from "../index";
import { resolvePhotoJob, resolveTenantByIngestKey } from "../index";

async function seedTenant(settings: unknown = {}) {
  const [t] = await adminDb.insert(tenant).values({ name: "SS", publicKey: `pk-${crypto.randomUUID()}`, clerkOrgId: `org-${crypto.randomUUID()}`, settings: settings as never }).returning();
  const [c] = await adminDb.insert(customer).values({ tenantId: t!.id, name: "C" }).returning();
  return { tenantId: t!.id, customerId: c!.id };
}

describe("resolvePhotoJob", () => {
  it("matches by normalized address and prefers the most recent open job", async () => {
    const { tenantId, customerId } = await seedTenant();
    const [p] = await adminDb.insert(property).values({ tenantId, customerId, address: "123 Main Street" }).returning();
    // an older completed job and a newer open job on the same property
    await adminDb.insert(job).values({ tenantId, customerId, propertyId: p!.id, type: "retail", stage: "complete" }).returning();
    const [open] = await adminDb.insert(job).values({ tenantId, customerId, propertyId: p!.id, type: "retail", stage: "production" }).returning();
    const r = await resolvePhotoJob({ tenantId, address: "123 Main St." }); // punctuation/suffix variant
    expect(r?.jobId).toBe(open!.id);
  });

  it("returns null when no property matches", async () => {
    const { tenantId } = await seedTenant();
    expect(await resolvePhotoJob({ tenantId, address: "999 Nowhere Rd" })).toBeNull();
  });
});

describe("resolveTenantByIngestKey", () => {
  it("resolves a tenant by its settings.sitesnap.ingestKey", async () => {
    const key = `k-${crypto.randomUUID()}`;
    const { tenantId } = await seedTenant({ sitesnap: { ingestKey: key } });
    expect((await resolveTenantByIngestKey(key))?.tenantId).toBe(tenantId);
    expect(await resolveTenantByIngestKey("nope")).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/db && pnpm vitest run src/lifecycle/photos-resolve.test.ts`
Expected: FAIL — functions not exported.

- [ ] **Step 3: Implement**

Create `packages/db/src/lifecycle/photos.ts`:

```ts
import { adminDb } from "../admin-client";
import { withTenant } from "../tenant";
import { property, job } from "../schema/index";
import { tenant } from "../schema/index";
import { and, eq, notInArray, desc, sql } from "drizzle-orm";
import { normalizeAddress } from "@savvy/core";

const CLOSED_STAGES = ["complete", "lost"] as const;

/** Resolve the Savvy job a photo belongs to by matching its property address.
 *  Prefers the most recent open (non-complete/lost) job; else the newest job. */
export async function resolvePhotoJob(input: { tenantId: string; address: string }): Promise<{ jobId: string } | null> {
  const norm = normalizeAddress(input.address);
  return withTenant(input.tenantId, async (tx) => {
    // Normalize property addresses in SQL the same way (lower + strip . , # + collapse spaces).
    // Suffix-word standardization is not reproduced in SQL; we compare on the cleaned form and
    // rely on normalizeAddress-equal inputs. Fetch candidates, then match in JS for parity.
    const props = await tx.select({ id: property.id, address: property.address }).from(property);
    const match = props.find((p) => normalizeAddress(p.address) === norm);
    if (!match) return null;
    const jobs = await tx.select({ id: job.id, stage: job.stage, createdAt: job.createdAt })
      .from(job).where(eq(job.propertyId, match.id)).orderBy(desc(job.createdAt));
    if (jobs.length === 0) return null;
    const open = jobs.find((j) => !CLOSED_STAGES.includes(j.stage as (typeof CLOSED_STAGES)[number]));
    return { jobId: (open ?? jobs[0]!).id };
  });
}

/** Resolve a tenant by its SiteSnap ingestion key (settings.sitesnap.ingestKey). Admin path. */
export async function resolveTenantByIngestKey(key: string): Promise<{ tenantId: string } | null> {
  if (!key) return null;
  const [row] = await adminDb.select({ id: tenant.id })
    .from(tenant)
    .where(sql`${tenant.settings} #>> '{sitesnap,ingestKey}' = ${key}`);
  return row ? { tenantId: row.id } : null;
}
```

(Drop the unused `and`/`notInArray` imports if the final code doesn't use them.)

- [ ] **Step 4: Export from the barrel + run tests**

In `packages/db/src/index.ts`, add:
```ts
export { resolvePhotoJob, resolveTenantByIngestKey } from "./lifecycle/photos";
```
Run: `cd packages/db && pnpm vitest run src/lifecycle/photos-resolve.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/lifecycle/photos.ts packages/db/src/index.ts packages/db/src/lifecycle/photos-resolve.test.ts
git commit -m "feat(db): resolvePhotoJob (address match) + resolveTenantByIngestKey

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `recordSiteSnapPhoto` + `listUnmatchedPhotos` + `matchPhotoToJob` (db)

**Files:**
- Modify: `packages/db/src/lifecycle/photos.ts`
- Modify: `packages/db/src/index.ts` (export the three)
- Test: `packages/db/src/lifecycle/photos-record.test.ts` (create)

**Interfaces:**
- Produces:
  ```ts
  recordSiteSnapPhoto(input: {
    tenantId: string; jobId: string | null; category: string;
    r2Key: string; captureAddress: string; sitesnapPhotoId: string;
  }): Promise<{ created: boolean; documentId: string }>
  listUnmatchedPhotos(tenantId: string): Promise<{ id: string; captureAddress: string | null; label: string | null; createdAt: Date }[]>
  matchPhotoToJob(input: { tenantId: string; documentId: string; jobId: string }): Promise<void>
  ```

- [ ] **Step 1: Write the failing integration tests**

Create `packages/db/src/lifecycle/photos-record.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { adminDb, tenant, customer, property, job, document, withTenant, eq } from "../index";
import { recordSiteSnapPhoto, listUnmatchedPhotos, matchPhotoToJob } from "../index";

async function seed() {
  const [t] = await adminDb.insert(tenant).values({ name: "SS", publicKey: `pk-${crypto.randomUUID()}`, clerkOrgId: `org-${crypto.randomUUID()}` }).returning();
  const [c] = await adminDb.insert(customer).values({ tenantId: t!.id, name: "C" }).returning();
  const [p] = await adminDb.insert(property).values({ tenantId: t!.id, customerId: c!.id, address: "1 A St" }).returning();
  const [j] = await adminDb.insert(job).values({ tenantId: t!.id, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "production" }).returning();
  return { tenantId: t!.id, jobId: j!.id };
}

describe("recordSiteSnapPhoto", () => {
  it("inserts a photo document and is idempotent on sitesnapPhotoId", async () => {
    const { tenantId, jobId } = await seed();
    const a = await recordSiteSnapPhoto({ tenantId, jobId, category: "ridge", r2Key: "k1", captureAddress: "1 A St", sitesnapPhotoId: "ss-1" });
    expect(a.created).toBe(true);
    const b = await recordSiteSnapPhoto({ tenantId, jobId, category: "ridge", r2Key: "k1", captureAddress: "1 A St", sitesnapPhotoId: "ss-1" });
    expect(b.created).toBe(false);
    expect(b.documentId).toBe(a.documentId);
    const rows = await withTenant(tenantId, (tx) => tx.select().from(document).where(eq(document.sitesnapPhotoId, "ss-1")));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe("photo");
    expect(rows[0]!.source).toBe("sitesnap");
    expect(rows[0]!.label).toBe("ridge");
  });

  it("lists unmatched photos and matchPhotoToJob attaches one to a job", async () => {
    const { tenantId, jobId } = await seed();
    const u = await recordSiteSnapPhoto({ tenantId, jobId: null, category: "eave", r2Key: "k2", captureAddress: "77 Lost Ln", sitesnapPhotoId: "ss-2" });
    const unmatched = await listUnmatchedPhotos(tenantId);
    expect(unmatched.map((x) => x.id)).toContain(u.documentId);
    await matchPhotoToJob({ tenantId, documentId: u.documentId, jobId });
    expect((await listUnmatchedPhotos(tenantId)).map((x) => x.id)).not.toContain(u.documentId);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/db && pnpm vitest run src/lifecycle/photos-record.test.ts`
Expected: FAIL — functions not exported.

- [ ] **Step 3: Implement (append to `photos.ts`)**

```ts
import { document } from "../schema/index";
import { isNull } from "drizzle-orm";

/** Idempotent insert of a SiteSnap photo document. Repeat (tenant, sitesnapPhotoId) → no-op. */
export async function recordSiteSnapPhoto(input: {
  tenantId: string; jobId: string | null; category: string;
  r2Key: string; captureAddress: string; sitesnapPhotoId: string;
}): Promise<{ created: boolean; documentId: string }> {
  return withTenant(input.tenantId, async (tx) => {
    const [existing] = await tx.select({ id: document.id }).from(document)
      .where(and(eq(document.tenantId, input.tenantId), eq(document.sitesnapPhotoId, input.sitesnapPhotoId)));
    if (existing) return { created: false, documentId: existing.id };
    const [row] = await tx.insert(document).values({
      tenantId: input.tenantId, jobId: input.jobId, kind: "photo", source: "sitesnap",
      label: input.category, r2Key: input.r2Key, captureAddress: input.captureAddress,
      sitesnapPhotoId: input.sitesnapPhotoId, qcStatus: "pending",
    }).returning({ id: document.id });
    return { created: true, documentId: row!.id };
  });
}

/** SiteSnap photos with no job (address didn't match) — the unmatched tray. */
export async function listUnmatchedPhotos(tenantId: string): Promise<{ id: string; captureAddress: string | null; label: string | null; createdAt: Date }[]> {
  return withTenant(tenantId, (tx) => tx.select({
    id: document.id, captureAddress: document.captureAddress, label: document.label, createdAt: document.createdAt,
  }).from(document).where(and(eq(document.source, "sitesnap"), isNull(document.jobId))));
}

/** Manually attach an unmatched photo to a job (from the tray). */
export async function matchPhotoToJob(input: { tenantId: string; documentId: string; jobId: string }): Promise<void> {
  await withTenant(input.tenantId, (tx) => tx.update(document).set({ jobId: input.jobId })
    .where(and(eq(document.id, input.documentId), eq(document.tenantId, input.tenantId))));
}
```

Ensure `and`, `eq`, `isNull` are imported (Task 3 already imported `and`, `eq`).

- [ ] **Step 4: Export from the barrel + run tests**

In `packages/db/src/index.ts` extend the photos export line:
```ts
export { resolvePhotoJob, resolveTenantByIngestKey, recordSiteSnapPhoto, listUnmatchedPhotos, matchPhotoToJob } from "./lifecycle/photos";
```
Run: `cd packages/db && pnpm vitest run src/lifecycle/photos-record.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/lifecycle/photos.ts packages/db/src/index.ts packages/db/src/lifecycle/photos-record.test.ts
git commit -m "feat(db): recordSiteSnapPhoto (idempotent) + unmatched tray readers

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Ingestion orchestration + webhook route (apps/web)

**Files:**
- Create: `apps/web/src/lib/sitesnap-ingest.ts` (testable orchestration)
- Create: `apps/web/src/lib/sitesnap-ingest.test.ts`
- Create: `apps/web/src/app/api/sitesnap/photos/route.ts` (thin wrapper)

**Interfaces:**
- Consumes: `resolveTenantByIngestKey`, `resolvePhotoJob`, `recordSiteSnapPhoto` (`@savvy/db`); `r2Storage`/`StorageGateway` (`@savvy/integrations`); `inngest` (`@savvy/agents`).
- Produces:
  ```ts
  ingestSiteSnapPhoto(
    body: { address: string; category: string; imageUrl: string; externalPhotoId: string; capturedAt?: string },
    key: string,
    deps: { storage: StorageGateway; fetchBytes: (url: string) => Promise<{ bytes: Uint8Array; mime: string }>; emit: (jobId: string | null, documentId: string, tenantId: string) => Promise<void> },
  ): Promise<{ status: number; body: unknown }>
  ```

**Design notes:** Inject `storage`, `fetchBytes`, and `emit` so the test uses `makeFakeStorage`, a stub fetch, and a spy emit — no network, no R2, no Inngest. The route supplies the real deps. R2 key: `sitesnap/${tenantId}/${externalPhotoId}`. Order: resolve tenant (401 if none) → fetch bytes (502 on failure) → resolve job (may be null) → `storage.putObject` → `recordSiteSnapPhoto` → `emit` (fail-soft, only when a real photo was created; still return 200 on emit failure) → 200 `{ ok: true, matched: boolean, documentId }`.

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/lib/sitesnap-ingest.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { adminDb, tenant, customer, property, job, withTenant, document, eq } from "@savvy/db";
import { makeFakeStorage } from "@savvy/integrations";
import { ingestSiteSnapPhoto } from "./sitesnap-ingest";

async function seed(key: string) {
  const [t] = await adminDb.insert(tenant).values({ name: "SS", publicKey: `pk-${crypto.randomUUID()}`, clerkOrgId: `org-${crypto.randomUUID()}`, settings: { sitesnap: { ingestKey: key } } as never }).returning();
  const [c] = await adminDb.insert(customer).values({ tenantId: t!.id, name: "C" }).returning();
  const [p] = await adminDb.insert(property).values({ tenantId: t!.id, customerId: c!.id, address: "123 Main Street" }).returning();
  const [j] = await adminDb.insert(job).values({ tenantId: t!.id, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "production" }).returning();
  return { tenantId: t!.id, jobId: j!.id };
}

const fetchBytes = async () => ({ bytes: new Uint8Array([1, 2, 3]), mime: "image/jpeg" });

describe("ingestSiteSnapPhoto", () => {
  it("401s on an unknown key", async () => {
    const r = await ingestSiteSnapPhoto({ address: "x", category: "ridge", imageUrl: "u", externalPhotoId: "e1" }, "bad-key", { storage: makeFakeStorage(), fetchBytes, emit: vi.fn() });
    expect(r.status).toBe(401);
  });

  it("matches by address, stores to R2, records the doc, and emits", async () => {
    const key = `k-${crypto.randomUUID()}`;
    const { tenantId, jobId } = await seed(key);
    const storage = makeFakeStorage();
    const emit = vi.fn(async () => {});
    const r = await ingestSiteSnapPhoto({ address: "123 Main St.", category: "ridge", imageUrl: "u", externalPhotoId: "e2" }, key, { storage, fetchBytes, emit });
    expect(r.status).toBe(200);
    expect(storage.calls.some((c) => c.op === "put" || c.op === "upload")).toBe(true);
    const rows = await withTenant(tenantId, (tx) => tx.select().from(document).where(eq(document.sitesnapPhotoId, "e2")));
    expect(rows[0]!.jobId).toBe(jobId);
    expect(emit).toHaveBeenCalledWith(jobId, rows[0]!.id, tenantId);
  });

  it("stores unmatched (jobId null) when no address matches", async () => {
    const key = `k-${crypto.randomUUID()}`;
    const { tenantId } = await seed(key);
    const r = await ingestSiteSnapPhoto({ address: "999 Nowhere Rd", category: "eave", imageUrl: "u", externalPhotoId: "e3" }, key, { storage: makeFakeStorage(), fetchBytes, emit: vi.fn(async () => {}) });
    expect(r.status).toBe(200);
    const rows = await withTenant(tenantId, (tx) => tx.select().from(document).where(eq(document.sitesnapPhotoId, "e3")));
    expect(rows[0]!.jobId).toBeNull();
  });
});
```

Note: `makeFakeStorage().putObject` records `{ op: "put", key }` (verified) — the `storage.calls.some((c) => c.op === "put")` predicate works as written. No change to `storage.ts` is needed.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/web && pnpm vitest run src/lib/sitesnap-ingest.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the orchestration**

Create `apps/web/src/lib/sitesnap-ingest.ts`:

```ts
import { resolveTenantByIngestKey, resolvePhotoJob, recordSiteSnapPhoto } from "@savvy/db";
import type { StorageGateway } from "@savvy/integrations";

export type IngestBody = { address: string; category: string; imageUrl: string; externalPhotoId: string; capturedAt?: string };
export type IngestDeps = {
  storage: StorageGateway;
  fetchBytes: (url: string) => Promise<{ bytes: Uint8Array; mime: string }>;
  emit: (jobId: string | null, documentId: string, tenantId: string) => Promise<void>;
};

export async function ingestSiteSnapPhoto(body: IngestBody, key: string, deps: IngestDeps): Promise<{ status: number; body: unknown }> {
  const t = await resolveTenantByIngestKey(key);
  if (!t) return { status: 401, body: { error: "unauthorized" } };

  let img: { bytes: Uint8Array; mime: string };
  try { img = await deps.fetchBytes(body.imageUrl); }
  catch { return { status: 502, body: { error: "image_fetch_failed" } }; }

  const match = await resolvePhotoJob({ tenantId: t.tenantId, address: body.address });
  const r2Key = `sitesnap/${t.tenantId}/${body.externalPhotoId}`;
  await deps.storage.putObject({ key: r2Key, bytes: img.bytes, contentType: img.mime });

  const rec = await recordSiteSnapPhoto({
    tenantId: t.tenantId, jobId: match?.jobId ?? null, category: body.category,
    r2Key, captureAddress: body.address, sitesnapPhotoId: body.externalPhotoId,
  });

  if (rec.created) {
    // Fail-soft: the row is committed; an emit hiccup must not fail the webhook.
    try { await deps.emit(match?.jobId ?? null, rec.documentId, t.tenantId); } catch { /* noop */ }
  }
  return { status: 200, body: { ok: true, matched: match != null, documentId: rec.documentId } };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/web && pnpm vitest run src/lib/sitesnap-ingest.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the thin route**

Create `apps/web/src/app/api/sitesnap/photos/route.ts`:

```ts
import { NextResponse } from "next/server";
import { inngest } from "@savvy/agents";
import { r2Storage } from "@savvy/integrations";
import { ingestSiteSnapPhoto, type IngestBody } from "@/lib/sitesnap-ingest";
import { log } from "@/lib/log";

export const runtime = "nodejs";

export async function POST(req: Request): Promise<NextResponse> {
  const key = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  let body: IngestBody;
  try { body = (await req.json()) as IngestBody; } catch { return NextResponse.json({ error: "bad_payload" }, { status: 400 }); }
  if (!body?.address || !body?.category || !body?.imageUrl || !body?.externalPhotoId) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }

  const res = await ingestSiteSnapPhoto(body, key, {
    storage: r2Storage,
    fetchBytes: async (url) => {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`fetch ${r.status}`);
      const buf = new Uint8Array(await r.arrayBuffer());
      return { bytes: buf, mime: r.headers.get("content-type") ?? "image/jpeg" };
    },
    emit: async (jobId, documentId, tenantId) => {
      await inngest.send({ name: "photo/ingested", data: { tenantId, documentId, jobId } });
    },
  });
  if (res.status >= 500) log.error("sitesnap ingest failed", { route: "/api/sitesnap/photos", status: res.status });
  return NextResponse.json(res.body, { status: res.status });
}
```

- [ ] **Step 6: Register the event + typecheck**

The Inngest client uses a typed `Events` record (`EventSchemas().fromRecord<Events>()` in `packages/agents/src/client.ts`), so `inngest.send({ name: "photo/ingested", ... })` will NOT typecheck until the event is registered. Add to the `Events` type (additive, alongside the existing events):

```ts
  "photo/ingested": { data: { tenantId: string; documentId: string; jobId: string | null } };
```

Run: `pnpm --filter @savvy/web typecheck` (or `pnpm typecheck`).
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/lib/sitesnap-ingest.ts apps/web/src/lib/sitesnap-ingest.test.ts apps/web/src/app/api/sitesnap/photos/route.ts packages/agents/src/client.ts
git commit -m "feat(web): SiteSnap photo ingestion webhook + orchestration

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: `photo_unmatched` exception surface

**Files:**
- Modify: `packages/core/src/exception-queue.ts` (add kind + input + push loop)
- Modify: `packages/core/src/exception-queue.test.ts` (cover the new kind)
- Modify: `apps/web/src/lib/exception-queries.ts` (feed the queue from `listUnmatchedPhotos`)

**Interfaces:**
- Consumes: `listUnmatchedPhotos` (`@savvy/db`).
- Produces: `ExceptionKind` gains `"photo_unmatched"`; `buildExceptionQueue` accepts `photoUnmatched?: PhotoUnmatchedInput[]` where `PhotoUnmatchedInput = { documentId: string; captureAddress: string | null; occurredAt: Date | null }`.

- [ ] **Step 1: Write the failing test**

Add to `packages/core/src/exception-queue.test.ts`:

```ts
it("emits a photo_unmatched exception per unmatched photo", () => {
  const q = buildExceptionQueue({
    atRiskJobs: [], overdueInvoices: [], missedAppointments: [], overdueTasks: [],
    materialDeliveries: [], taskNeedsApprovals: [], weatherAtRisks: [], roofTypeNeeded: [],
    marginOutliers: [], photoIncomplete: [],
    photoUnmatched: [{ documentId: "d1", captureAddress: "77 Lost Ln", occurredAt: new Date() }],
  });
  const row = q.items.find((i) => i.kind === "photo_unmatched");
  expect(row).toBeTruthy();
  expect(row!.detail).toContain("77 Lost Ln");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && pnpm vitest run src/exception-queue.test.ts`
Expected: FAIL — `photo_unmatched` not a member / field ignored.

- [ ] **Step 3: Implement**

In `packages/core/src/exception-queue.ts`:
- Add `"photo_unmatched"` to the `ExceptionKind` union and to the `KINDS` array.
- Add the input type: `export type PhotoUnmatchedInput = { documentId: string; captureAddress: string | null; occurredAt: Date | null };`
- Add `photoUnmatched?: PhotoUnmatchedInput[];` to the `buildExceptionQueue` input type.
- Add the push loop (before the sort), mirroring the `photoIncomplete` block:

```ts
  for (const p of input.photoUnmatched ?? []) {
    items.push({
      kind: "photo_unmatched",
      severity: "medium",
      title: "Unmatched photo",
      detail: `SiteSnap photo needs a job${p.captureAddress ? ` — ${p.captureAddress}` : ""}`,
      href: `/photos/unmatched`,
      occurredAt: p.occurredAt,
    });
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/core && pnpm vitest run src/exception-queue.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the real data source**

In `apps/web/src/lib/exception-queries.ts`: import `listUnmatchedPhotos`, build `photoUnmatched: PhotoUnmatchedInput[]` from it (map `id`→`documentId`, `createdAt`→`occurredAt`), and pass it into the `buildExceptionQueue({ ... })` call (mirror how `photoIncomplete` is assembled and passed). Add the `PhotoUnmatchedInput` type to the existing `@savvy/core` import.

- [ ] **Step 6: Typecheck + commit**

Run: `pnpm --filter @savvy/core --filter @savvy/web typecheck` (or `pnpm typecheck`).
Expected: clean.

```bash
git add packages/core/src/exception-queue.ts packages/core/src/exception-queue.test.ts apps/web/src/lib/exception-queries.ts
git commit -m "feat(jobs): photo_unmatched exception for unmatched SiteSnap photos

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage (Slice 1 rows of the spec):**
- Inbound webhook + bearer-key auth → Task 5 (route) + Task 3 (`resolveTenantByIngestKey`). ✓
- Fetch bytes → copy to R2 → Task 5. ✓
- Address→job match + selection rule → Task 2 (normalize) + Task 3 (`resolvePhotoJob`). ✓
- `document` row (source=sitesnap, label=category, r2Key, captureAddress, sitesnapPhotoId) + idempotency → Task 1 (columns/index) + Task 4 (`recordSiteSnapPhoto`). ✓
- `photo/ingested` emission (fail-soft) → Task 5. ✓
- Unmatched tray → Task 4 (`listUnmatchedPhotos`/`matchPhotoToJob`) + Task 6 (`photo_unmatched` exception). ✓
- Migration → Task 1. ✓

**Placeholder scan:** No TBD/TODO. Each code step carries complete code. Instructions that say "mirror how `photoIncomplete` is assembled/passed" (Task 6 Step 5) and "confirm the op label `putObject` records" (Task 5 Step 1) are real observe-the-existing-pattern instructions, not placeholders — the types/signatures are fully specified.

**Type consistency:** `recordSiteSnapPhoto` input `{ tenantId, jobId, category, r2Key, captureAddress, sitesnapPhotoId }` matches between Task 4 def and Task 5 call. `resolvePhotoJob`/`resolveTenantByIngestKey` signatures match between Task 3 and Task 5. `PhotoUnmatchedInput` fields match between Task 6 def, its test, and the Task 4 reader shape (`id`→`documentId`, `createdAt`→`occurredAt` mapped in Task 6 Step 5). `photo/ingested` payload `{ tenantId, documentId, jobId }` is consistent between Task 5 emit and its consumer (Slice 2).

## Out of scope (Slice 1)
- All of AI photo QC (vision extension, dHash dedup, `photo_quality` exception) — that's Slice 2's plan.
- A polished unmatched-photos tray **page** — v1 surfaces unmatched photos as `photo_unmatched` exception rows (href `/photos/unmatched`) and exposes `matchPhotoToJob`; a dedicated interactive page can be a follow-up.
- SiteSnap's own capture UI / project model.
