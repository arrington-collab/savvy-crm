# Phase 6A — Production Spine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Attach photos/documents to a job (stored in Cloudflare R2 via presigned direct upload) and block a job from being marked `complete` until every required photo label for its job type is present.

**Architecture:** Files upload browser→R2 directly via short-lived presigned PUT URLs from an injectable `StorageGateway` (real R2 + fake). Completion gating is pure `@savvy/core` logic enforced transactionally inside the existing `recordStageChange` (throws `IncompletePhotosError`, caught by `moveJobToStage`). Config in `tenant.settings.production` (zod). No AI, no Inngest — synchronous request/response.

**Tech Stack:** TypeScript, pnpm/Turborepo, Drizzle (Postgres + RLS), `@aws-sdk/client-s3` + `s3-request-presigner` (R2 is S3-compatible), Vitest, Playwright, Next.js App Router, shadcn.

**Spec:** `docs/superpowers/specs/2026-06-15-phase6a-production-spine-design.md`

---

## Conventions (read once)
- Run one package's tests from root: `pnpm test <pattern>`. DB/agents tests need: `export DATABASE_URL=postgres://savvy_app:savvy_app@localhost:5432/savvy DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/savvy` and `docker compose up -d`.
- Imports: tables + drizzle ops (`eq`, `and`, `sql`…) from `@savvy/db`; `z` + helpers from `@savvy/core`. **No `.js`** on SOURCE relative imports; `@savvy/db` TEST files DO use `.js`.
- **`noUncheckedIndexedAccess` is ON** — `arr[i].x` fails `tsc` (vitest doesn't typecheck); use `arr[i]?.x` / `.at()`.
- Static gate before each commit: `pnpm typecheck && pnpm lint && pnpm test`.

## File Structure
| File | Responsibility | Wave |
|------|----------------|------|
| `packages/core/src/production.ts` (new) | `missingRequiredPhotos` + `parseProductionConfig` | 0 |
| `packages/core/src/index.ts` (mod) | export `./production` | 0 |
| `packages/db/src/schema/ops.ts` (mod) | add `document.label` | 0 |
| `packages/integrations/src/storage.ts` (new) | `StorageGateway` + `r2Storage` + `makeFakeStorage` | A |
| `packages/integrations/src/index.ts` (mod) | export storage | A |
| `packages/integrations/package.json` (mod) | add aws-sdk deps | A |
| `packages/db/src/lifecycle/record-stage-change.ts` (mod) | `IncompletePhotosError` + `→complete` gate | B |
| `packages/db/src/index.ts` (mod) | export `IncompletePhotosError` | B |
| `apps/web/src/lib/job-actions.ts` (mod) | `moveJobToStage` catches the gate error | B |
| `apps/web/src/app/(app)/jobs/board.tsx` (mod) | surface `missing_photos` to the user | B |
| `apps/web/src/lib/document-actions.ts` (new) | presign upload/view + record document | C |
| `apps/web/src/app/(app)/jobs/[id]/DocsPanel.tsx` (new) + `tabs.tsx`/`page.tsx` (mod) | checklist + grid + upload UI | C |
| `packages/db/tests/isolation.test.ts` (mod) | cover `document` | gate |
| `apps/web/tests/e2e/production-gating.spec.ts` (new) | e2e | gate |
| `.env.example` (mod) | R2 vars | gate |

---

# Wave 0 — Foundation

## Task 1: `missingRequiredPhotos` + `parseProductionConfig` (pure core)

**Files:** Create `packages/core/src/production.ts`; Modify `packages/core/src/index.ts`; Test `packages/core/src/production.test.ts`

- [ ] **Step 1: Failing test** `packages/core/src/production.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { missingRequiredPhotos, parseProductionConfig } from "./production";

describe("missingRequiredPhotos", () => {
  it("returns required labels with no matching present (case-insensitive, trimmed)", () => {
    expect(missingRequiredPhotos(["before", "after"], ["Before"])).toEqual(["after"]);
    expect(missingRequiredPhotos(["before", "after"], [" before ", "AFTER"])).toEqual([]);
    expect(missingRequiredPhotos([], ["x"])).toEqual([]);
  });
});

describe("parseProductionConfig", () => {
  it("fills per-job-type defaults", () => {
    const cfg = parseProductionConfig(undefined);
    expect(cfg.requiredPhotos.retail).toEqual(["before", "after"]);
    expect(cfg.requiredPhotos.insurance).toEqual(["before", "after", "permit"]);
  });
  it("merges a partial override and normalizes labels", () => {
    const cfg = parseProductionConfig({ requiredPhotos: { retail: [" Before ", "DUMP"] } });
    expect(cfg.requiredPhotos.retail).toEqual(["before", "dump"]);
    expect(cfg.requiredPhotos.repair).toEqual(["before", "after"]); // default preserved
  });
});
```

- [ ] **Step 2: Run, verify FAIL** — `pnpm --filter @savvy/core test production`

- [ ] **Step 3: Implement** `packages/core/src/production.ts`:
```ts
import { z } from "./schemas";
import type { JobType } from "./enums";

/** Required labels with no case-insensitive/trimmed match in `present`. [] = complete. */
export function missingRequiredPhotos(required: string[], present: string[]): string[] {
  const have = new Set(present.map((s) => s.trim().toLowerCase()));
  return required.filter((r) => !have.has(r.trim().toLowerCase()));
}

const DEFAULTS: Record<JobType, string[]> = {
  retail: ["before", "after"],
  insurance: ["before", "after", "permit"],
  repair: ["before", "after"],
  commercial: ["before", "after"],
};

const labels = (def: string[]) =>
  z.array(z.string()).default(def).transform((a) => a.map((s) => s.trim().toLowerCase()));

const productionSchema = z.object({
  requiredPhotos: z.object({
    retail: labels(DEFAULTS.retail),
    insurance: labels(DEFAULTS.insurance),
    repair: labels(DEFAULTS.repair),
    commercial: labels(DEFAULTS.commercial),
  }).default({}),
});

export type ProductionConfig = z.infer<typeof productionSchema>;

export function parseProductionConfig(raw: unknown): ProductionConfig {
  return productionSchema.parse(raw ?? {});
}
```

- [ ] **Step 4: Run, verify PASS.** Add `export * from "./production";` to `packages/core/src/index.ts`.
- [ ] **Step 5:** `pnpm --filter @savvy/core typecheck` clean.
- [ ] **Step 6: Commit**
```bash
git add packages/core/src/production.ts packages/core/src/production.test.ts packages/core/src/index.ts
git commit -m "feat(core): production config + missingRequiredPhotos gate logic"
```

## Task 2: `document.label` column + migration 0006

**Files:** Modify `packages/db/src/schema/ops.ts`; Generate `packages/db/drizzle/0006_*.sql`; Test `packages/db/tests/document-label.test.ts`

- [ ] **Step 1:** In `packages/db/src/schema/ops.ts`, add to the `document` table columns (after `kind`): `label: text("label"),`. (`text` is already imported.)

- [ ] **Step 2: Generate migration** (DB env exported, docker up):
```bash
pnpm db:generate
```
Expected: `0006_*.sql` with one `ALTER TABLE "document" ADD COLUMN "label" text;` + snapshot + journal entry, non-interactive (additive nullable column).

- [ ] **Step 3: Apply** — `pnpm db:migrate`.

- [ ] **Step 4: Test** `packages/db/tests/document-label.test.ts` (mirror `commission.test.ts` setup helpers — uses `.js` extensions):
```ts
import { describe, it, expect } from "vitest";
import { withTenant } from "../src/tenant.js";
import { document } from "../src/schema/ops.js";
import { eq } from "drizzle-orm";
// reuse helpers that make a tenant + job (see invoices.test.ts / commission.test.ts)

describe("document.label", () => {
  it("persists a photo label", async () => {
    const { tenantId, jobId } = await makeTenantAndJob(); // adapt to existing helpers
    const row = await withTenant(tenantId, async (tx) => {
      const [r] = await tx.insert(document).values({
        tenantId, jobId, kind: "photo", label: "before", r2Key: `${tenantId}/${jobId}/x.jpg`, source: "savvy",
      }).returning();
      return r;
    });
    expect(row.label).toBe("before");
  });
});
```
Inspect `commission.test.ts`/`invoices.test.ts` for the exact tenant/job helper and reuse it; `r2Key` is `notNull` so always provide it.

- [ ] **Step 5: Run** — `pnpm test document-label` → PASS.
- [ ] **Step 6: Commit**
```bash
git add packages/db/src/schema/ops.ts packages/db/drizzle packages/db/tests/document-label.test.ts
git commit -m "feat(db): document.label column + migration 0006"
```

---

# Wave A — Storage gateway

## Task 3: `StorageGateway` (R2 real + fake)

**Files:** Create `packages/integrations/src/storage.ts`, `packages/integrations/src/storage.test.ts`; Modify `packages/integrations/src/index.ts`, `packages/integrations/package.json`

- [ ] **Step 1: Add deps**
```bash
pnpm --filter @savvy/integrations add @aws-sdk/client-s3 @aws-sdk/s3-request-presigner
```
(Adds to `packages/integrations/package.json` + updates `pnpm-lock.yaml`.)

- [ ] **Step 2: Failing test** `packages/integrations/src/storage.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { makeFakeStorage } from "./storage";

describe("makeFakeStorage", () => {
  it("returns deterministic urls + records calls", async () => {
    const s = makeFakeStorage();
    const up = await s.presignUpload({ key: "t/j/x.jpg", contentType: "image/jpeg" });
    const dn = await s.presignDownload({ key: "t/j/x.jpg" });
    expect(up.url).toContain("t/j/x.jpg");
    expect(dn.url).toContain("sig=get");
    expect(s.calls.map((c) => c.op)).toEqual(["upload", "download"]);
  });
});
```

- [ ] **Step 3: Run, verify FAIL** — `pnpm --filter @savvy/integrations test storage`

- [ ] **Step 4: Implement** `packages/integrations/src/storage.ts`:
```ts
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export interface StorageGateway {
  presignUpload(o: { key: string; contentType: string }): Promise<{ url: string }>;
  presignDownload(o: { key: string }): Promise<{ url: string }>;
}

function r2Client(): S3Client {
  const acct = process.env.R2_ACCOUNT_ID;
  if (!acct || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY || !process.env.R2_BUCKET) {
    throw new Error("storage_not_configured");
  }
  return new S3Client({
    region: "auto",
    endpoint: `https://${acct}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });
}

export const r2Storage: StorageGateway = {
  async presignUpload({ key, contentType }) {
    const url = await getSignedUrl(
      r2Client(),
      new PutObjectCommand({ Bucket: process.env.R2_BUCKET, Key: key, ContentType: contentType }),
      { expiresIn: 300 },
    );
    return { url };
  },
  async presignDownload({ key }) {
    const url = await getSignedUrl(
      r2Client(),
      new GetObjectCommand({ Bucket: process.env.R2_BUCKET, Key: key }),
      { expiresIn: 300 },
    );
    return { url };
  },
};

export function makeFakeStorage(): StorageGateway & { calls: { op: string; key: string }[] } {
  const calls: { op: string; key: string }[] = [];
  return {
    calls,
    async presignUpload({ key }) { calls.push({ op: "upload", key }); return { url: `https://fake-r2/${key}?sig=put` }; },
    async presignDownload({ key }) { calls.push({ op: "download", key }); return { url: `https://fake-r2/${key}?sig=get` }; },
  };
}
```

- [ ] **Step 5: Run, verify PASS.** Add to `packages/integrations/src/index.ts`: `export { r2Storage, makeFakeStorage, type StorageGateway } from "./storage";`
- [ ] **Step 6:** `pnpm typecheck` + `pnpm lint` clean.
- [ ] **Step 7: Commit**
```bash
git add packages/integrations/src/storage.ts packages/integrations/src/storage.test.ts packages/integrations/src/index.ts packages/integrations/package.json pnpm-lock.yaml
git commit -m "feat(integrations): R2 StorageGateway (presigned upload/download) + fake"
```

---

# Wave B — Completion gating

## Task 4: `IncompletePhotosError` + gate in `recordStageChange`

**Files:** Modify `packages/db/src/lifecycle/record-stage-change.ts`, `packages/db/src/index.ts`; Test `packages/db/tests/stage-gate.test.ts`

- [ ] **Step 1: Implement the gate** — in `packages/db/src/lifecycle/record-stage-change.ts`:
  - Add imports: `import { parseProductionConfig, missingRequiredPhotos, type JobType } from "@savvy/core";` and add `document` to the `../schema/index` import and `tenant` (check current imports — `job, jobTask, jobStageEvent, auditLog` are imported from `../schema/index`; add `document, tenant`). Ensure `and` is imported from `drizzle-orm` (it is).
  - Add the exported error class near the top:
```ts
export class IncompletePhotosError extends Error {
  missing: string[];
  constructor(missing: string[]) {
    super("incomplete_photos");
    this.name = "IncompletePhotosError";
    this.missing = missing;
  }
}
```
  - At the very START of `recordStageChange` (before the `const [current] = ...` read), insert the gate:
```ts
  if (opts.toStage === "complete") {
    const [j] = await tx.select({ type: job.type }).from(job).where(eq(job.id, opts.jobId));
    const [t] = await tx.select({ settings: tenant.settings }).from(tenant).where(eq(tenant.id, opts.tenantId));
    const cfg = parseProductionConfig((t?.settings as { production?: unknown } | undefined)?.production);
    const required = cfg.requiredPhotos[(j?.type ?? "retail") as JobType] ?? [];
    if (required.length > 0) {
      const rows = await tx.selectDistinct({ label: document.label }).from(document)
        .where(and(eq(document.jobId, opts.jobId), eq(document.kind, "photo")));
      const present = rows.map((r) => r.label).filter((x): x is string => !!x);
      const missing = missingRequiredPhotos(required, present);
      if (missing.length > 0) throw new IncompletePhotosError(missing);
    }
  }
```
  Throwing aborts the surrounding transaction, so no `job` update / `job_stage_event` / `audit_log` is written.

- [ ] **Step 2: Export** — add to `packages/db/src/index.ts` (next to `recordStageChange`): change the line to also export the error, e.g. `export { recordStageChange, IncompletePhotosError } from "./lifecycle/record-stage-change";`

- [ ] **Step 3: Write the integration test** `packages/db/tests/stage-gate.test.ts` (reuse helpers; `.js` imports):
```ts
import { describe, it, expect } from "vitest";
import { withTenant } from "../src/tenant.js";
import { recordStageChange, IncompletePhotosError } from "../src/lifecycle/record-stage-change.js";
import { document, jobStageEvent } from "../src/schema/index.js";
import { eq, and } from "drizzle-orm";
// reuse helpers to make a tenant + a job (type "retail", default requiredPhotos ["before","after"])

describe("completion photo gate", () => {
  it("blocks ->complete when a required photo label is missing (and writes no stage event)", async () => {
    const { tenantId, jobId } = await makeTenantAndJob(); // retail job, no photos
    await expect(
      withTenant(tenantId, (tx) => recordStageChange(tx, { tenantId, jobId, toStage: "complete" })),
    ).rejects.toBeInstanceOf(IncompletePhotosError);
    const events = await withTenant(tenantId, (tx) =>
      tx.select().from(jobStageEvent).where(and(eq(jobStageEvent.jobId, jobId), eq(jobStageEvent.toStage, "complete"))));
    expect(events).toHaveLength(0); // tx aborted
  });

  it("allows ->complete once all required photo labels are present", async () => {
    const { tenantId, jobId } = await makeTenantAndJob();
    await withTenant(tenantId, async (tx) => {
      for (const label of ["before", "after"]) {
        await tx.insert(document).values({ tenantId, jobId, kind: "photo", label, r2Key: `${tenantId}/${jobId}/${label}.jpg`, source: "savvy" });
      }
    });
    await withTenant(tenantId, (tx) => recordStageChange(tx, { tenantId, jobId, toStage: "complete" }));
    const events = await withTenant(tenantId, (tx) =>
      tx.select().from(jobStageEvent).where(and(eq(jobStageEvent.jobId, jobId), eq(jobStageEvent.toStage, "complete"))));
    expect(events).toHaveLength(1);
  });

  it("does not check photos for non-complete transitions", async () => {
    const { tenantId, jobId } = await makeTenantAndJob();
    await withTenant(tenantId, (tx) => recordStageChange(tx, { tenantId, jobId, toStage: "production" })); // no throw
  });
});
```
Adapt `makeTenantAndJob` to the real helpers (it must create a job with `type` defaulting to "retail"). NOTE the two-`withTenant`-calls pattern for the "allows" test: insert photos in one tx, then move in another — because the throwing tx would roll back the inserts if combined.

- [ ] **Step 4: Run** — `pnpm test stage-gate` → all 3 pass.
- [ ] **Step 5: Commit**
```bash
git add packages/db/src/lifecycle/record-stage-change.ts packages/db/src/index.ts packages/db/tests/stage-gate.test.ts
git commit -m "feat(db): gate job completion on required photos (IncompletePhotosError)"
```

## Task 5: `moveJobToStage` surfaces the gate + board handles it

**Files:** Modify `apps/web/src/lib/job-actions.ts`, `apps/web/src/app/(app)/jobs/board.tsx`

- [ ] **Step 1:** In `apps/web/src/lib/job-actions.ts`, import the error and update `moveJobToStage`:
```ts
import { withTenant, recordStageChange, IncompletePhotosError, jobTask, eq } from "@savvy/db";
// ...
export async function moveJobToStage(
  jobId: string,
  toStage: JobStage,
): Promise<{ ok: true } | { error: "missing_photos"; missing: string[] }> {
  const tenantId = await getTenantId();
  try {
    await withTenant(tenantId, (tx) => recordStageChange(tx, { tenantId, jobId, toStage }));
  } catch (e) {
    if (e instanceof IncompletePhotosError) return { error: "missing_photos", missing: e.missing };
    throw e;
  }
  revalidatePath("/jobs");
  return { ok: true };
}
```

- [ ] **Step 2: Board handling** — read `apps/web/src/app/(app)/jobs/board.tsx`. Find where it calls `moveJobToStage` (on drop). It currently assumes success. Update the handler to check the result: if `result.error === "missing_photos"`, surface it (toast/alert) listing `result.missing`, and revert the optimistic move if the board does optimistic updates. Use the board's existing toast/notification mechanism if present; otherwise a minimal `alert()` is acceptable but prefer matching existing UX. Example:
```tsx
const result = await moveJobToStage(jobId, toStage);
if ("error" in result && result.error === "missing_photos") {
  // revert optimistic state, then notify
  toast?.error?.(`Can't complete: missing photos — ${result.missing.join(", ")}`)
    ?? alert(`Can't complete: missing photos — ${result.missing.join(", ")}`);
  return;
}
```
Match the file's actual state-management/notification pattern (read it first; don't invent a toast lib that isn't installed).

- [ ] **Step 3:** `pnpm typecheck` + `pnpm lint` clean.
- [ ] **Step 4: Commit**
```bash
git add apps/web/src/lib/job-actions.ts "apps/web/src/app/(app)/jobs/board.tsx"
git commit -m "feat(web): surface missing-photo completion block on the job board"
```

---

# Wave C — Document actions + UI

## Task 6: Document server actions

**Files:** Create `apps/web/src/lib/document-actions.ts`; Test (manual/e2e — these are server actions with external R2; covered by e2e in Task 9 using fake storage via DI is NOT possible here since the action imports `r2Storage` directly — so keep them thin and rely on e2e + the gateway unit test).

- [ ] **Step 1: Implement** `apps/web/src/lib/document-actions.ts`:
```ts
"use server";
import { withTenant, job, document, eq } from "@savvy/db";
import { r2Storage } from "@savvy/integrations";
import { revalidatePath } from "next/cache";
import { getTenantId } from "./tenant";

export async function presignDocumentUpload(input: {
  jobId: string; kind: string; label?: string; filename: string; contentType: string;
}): Promise<{ ok: true; uploadUrl: string; r2Key: string } | { error: "not_found" | "storage_not_configured" }> {
  const tenantId = await getTenantId();
  const found = await withTenant(tenantId, async (tx) => {
    const [j] = await tx.select({ id: job.id }).from(job).where(eq(job.id, input.jobId));
    return j;
  });
  if (!found) return { error: "not_found" };
  const safe = input.filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
  const r2Key = `${tenantId}/${input.jobId}/${crypto.randomUUID()}-${safe}`;
  try {
    const { url } = await r2Storage.presignUpload({ key: r2Key, contentType: input.contentType });
    return { ok: true, uploadUrl: url, r2Key };
  } catch {
    return { error: "storage_not_configured" };
  }
}

export async function recordDocument(input: {
  jobId: string; r2Key: string; kind: string; label?: string; filename: string; mime: string; sizeBytes: number;
}): Promise<{ ok: true; id: string } | { error: "bad_key" | "not_found" }> {
  const tenantId = await getTenantId();
  if (!input.r2Key.startsWith(`${tenantId}/${input.jobId}/`)) return { error: "bad_key" };
  const res = await withTenant(tenantId, async (tx) => {
    const [j] = await tx.select({ id: job.id, customerId: job.customerId }).from(job).where(eq(job.id, input.jobId));
    if (!j) return null;
    const [row] = await tx.insert(document).values({
      tenantId, jobId: input.jobId, customerId: j.customerId ?? null,
      kind: input.kind, label: input.label ?? null, r2Key: input.r2Key,
      filename: input.filename, mime: input.mime, sizeBytes: input.sizeBytes, source: "savvy",
    }).returning({ id: document.id });
    return row;
  });
  if (!res) return { error: "not_found" };
  revalidatePath(`/jobs/${input.jobId}`);
  return { ok: true, id: res.id };
}

export async function presignDocumentView(documentId: string):
  Promise<{ ok: true; url: string } | { error: "not_found" | "storage_not_configured" }> {
  const tenantId = await getTenantId();
  const doc = await withTenant(tenantId, async (tx) => {
    const [d] = await tx.select({ r2Key: document.r2Key }).from(document).where(eq(document.id, documentId));
    return d;
  });
  if (!doc) return { error: "not_found" };
  try {
    const { url } = await r2Storage.presignDownload({ key: doc.r2Key });
    return { ok: true, url };
  } catch {
    return { error: "storage_not_configured" };
  }
}
```
Verify `job.customerId`, `document` columns (`label`, `r2Key`, `mime`, `sizeBytes`, `source`) match the schema. `crypto.randomUUID()` is available in the Next server runtime.

- [ ] **Step 2:** `pnpm typecheck` + `pnpm lint` clean.
- [ ] **Step 3: Commit**
```bash
git add apps/web/src/lib/document-actions.ts
git commit -m "feat(web): document upload presign + record + view server actions"
```

## Task 7: Docs tab UI — checklist + grid + upload

**Files:** Create `apps/web/src/app/(app)/jobs/[id]/DocsPanel.tsx`; Modify `apps/web/src/app/(app)/jobs/[id]/tabs.tsx` + `page.tsx`

Read `tabs.tsx` (the `<TabsContent value="docs">` block at ~line 182) and `page.tsx` (the server component — see what it queries and passes to `JobTabs`). You'll thread the job's documents + type + required config into a new client `DocsPanel`.

- [ ] **Step 1: Server data** — in `page.tsx` (server component), alongside the existing job/tasks queries, load the job's documents and the production config:
```ts
import { parseProductionConfig } from "@savvy/core";
// inside the page loader, within withTenant(tenantId, ...):
const docs = await tx.select().from(document).where(eq(document.jobId, jobId)).orderBy(desc(document.createdAt));
const [t] = await tx.select({ settings: tenant.settings }).from(tenant).where(eq(tenant.id, tenantId));
const requiredPhotos = parseProductionConfig((t?.settings as { production?: unknown })?.production).requiredPhotos[job.type];
```
Pass `docs`, `requiredPhotos`, `jobId`, and `jobType` into `JobTabs` → the docs `TabsContent`. (`document`, `tenant`, `desc`, `eq` from `@savvy/db`.)

- [ ] **Step 2: `DocsPanel.tsx`** (client component). Props: `{ jobId: string; jobType: string; documents: DocRow[]; requiredPhotos: string[] }`. Renders:
  1. **Checklist**: for each label in `requiredPhotos`, ✓ if some `documents` has `kind==='photo' && label?.toLowerCase()===label`, else ✗.
  2. **Grid**: each photo as an `<img>` whose `src` is fetched via `presignDocumentView(doc.id)` (resolve on mount / on click to reveal); non-photo docs as filename + a "view" link (also via `presignDocumentView`).
  3. **Upload control**: `<input type="file" accept="image/*" capture="environment">` + a label `<select>` (options = `requiredPhotos` + `"other"`) + a kind `<select>` (photo/measurement/contract/evidence/other, default photo). On file pick:
```ts
const pre = await presignDocumentUpload({ jobId, kind, label, filename: file.name, contentType: file.type });
if (!("ok" in pre)) { setError(pre.error); return; }
await fetch(pre.uploadUrl, { method: "PUT", body: file, headers: { "Content-Type": file.type } });
const rec = await recordDocument({ jobId, r2Key: pre.r2Key, kind, label, filename: file.name, mime: file.type, sizeBytes: file.size });
if ("ok" in rec) router.refresh();
```
  Use `useRouter().refresh()` (next/navigation) to re-fetch the server component after upload. Show an upload-in-progress state. Add `data-testid="required-photo-{label}"` on each checklist item and `data-testid="doc-upload-input"` on the file input (for e2e).

- [ ] **Step 3: Wire** the `<TabsContent value="docs">` in `tabs.tsx` to render `<DocsPanel ... />` with the props threaded from `page.tsx`. Keep the other tabs unchanged.

- [ ] **Step 4:** `pnpm typecheck` + `pnpm lint` clean. (Do NOT run `pnpm build` — the pre-existing Clerk prerender warning is unrelated; `/jobs/[id]` is dynamic.)
- [ ] **Step 5: Commit**
```bash
git add "apps/web/src/app/(app)/jobs/[id]/DocsPanel.tsx" "apps/web/src/app/(app)/jobs/[id]/tabs.tsx" "apps/web/src/app/(app)/jobs/[id]/page.tsx"
git commit -m "feat(web): job Docs tab — required-photo checklist, grid, camera upload"
```

---

# Wave Gate

## Task 8: RLS isolation covers `document`

**Files:** Modify `packages/db/tests/isolation.test.ts`

- [ ] **Step 1:** Read `isolation.test.ts`; add a `document` case mirroring an existing table (e.g. `commission` — added recently). Insert a `document` row for tenant B via `adminDb` (real row, FKs satisfied: tenant B already has a job in the test setup), then assert `withTenant(tenantAId, tx => tx.select().from(document))` returns no row with `tenantId === tenantBId`. Add cleanup of the document row in `afterAll` (before its job/tenant deletes).
- [ ] **Step 2: Run** — `pnpm test isolation` → all pass incl. the document case.
- [ ] **Step 3: Commit**
```bash
git add packages/db/tests/isolation.test.ts
git commit -m "test(db): RLS isolation covers document table"
```

## Task 9: e2e — gating + upload

**Files:** Create `apps/web/tests/e2e/production-gating.spec.ts`

Use the harness recipe (DB + ai-stub + inngest-cli + playwright; `TEST_MODE=1`, `TEST_TENANT_ID`). Mirror `finance-automation.spec.ts` for setup. NOTE: the real `presignDocumentUpload` calls `r2Storage` which throws without R2 env — so for the e2e, set fake R2 env so presign succeeds against a fake, OR assert the gate path (which needs NO upload) as the primary, reliable check and treat the full upload round-trip as best-effort.

- [ ] **Step 1: Write the e2e**, primary (reliable) assertions:
  1. Seed a retail job (default required `["before","after"]`) with NO photos via `adminDb`.
  2. Drive `moveJobToStage(jobId, "complete")` (call the server action through the UI board drag, or assert via a direct DB attempt) → expect it blocked: the job's stage is NOT `complete` and the missing-photos message shows. The cleanest reliable check: insert the two required photos via `adminDb` (`document` rows kind=photo, label before/after), then move to `complete` succeeds (job.stage === "complete"); and a second job WITHOUT photos stays blocked. This exercises the gate end-to-end without needing real R2.
  3. (Best-effort) If you set fake-storage-compatible behavior, drive the `/jobs/[id]` Docs tab upload and assert the checklist flips — but if R2/presign can't be faked in the running app, SKIP the UI-upload leg and note it (the upload actions are thin; the gate is the риск).

- [ ] **Step 2: Run** the e2e per the recipe until green; kill bg services after. A committed e2e MUST pass — if the upload leg is flaky, keep only the gate assertions and note the scope.
- [ ] **Step 3: Commit**
```bash
git add apps/web/tests/e2e/production-gating.spec.ts
git commit -m "test(e2e): completion gate blocks until required photos present"
```

## Task 10: `.env.example` + final gate + PR

**Files:** Modify `.env.example`

- [ ] **Step 1:** Append to `.env.example`:
```bash
# Cloudflare R2 (document/photo storage) — Phase 6A
R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET=savvy-documents
```

- [ ] **Step 2: Full gate** (DB up, env exported): `pnpm typecheck && pnpm lint && pnpm test` — all green (pre-existing lint WARNINGS ok; 0 errors).

- [ ] **Step 3: Commit + push + PR (BASE MAIN — the repo default was historically misconfigured; ALWAYS pass `--base main`):**
```bash
git add .env.example
git commit -m "chore: document R2 env vars for Phase 6A"
git push -u origin feat/phase6a-production-spine
gh pr create --base main --head feat/phase6a-production-spine \
  --title "Phase 6A: Production spine — R2 storage + photo upload + completion gating" \
  --body "Implements docs/superpowers/specs/2026-06-15-phase6a-production-spine-design.md: presigned direct-to-R2 document/photo upload, per-job-type required-photo checklist, and a gate blocking ->complete until required photos are present. Deferred: customer sharing, CompanyCam, DocuSeal, change orders (later 6 slices)."
```

---

## Self-Review (plan author)
**Spec coverage:** §4.1 label → T2; §4.2 production config → T1; §5 StorageGateway → T3; §6 actions → T6; §7 gate (pure + recordStageChange + caller) → T1/T4/T5; §8 UI → T7; §10 testing (unit/integration/storage/RLS/e2e) → T1/T3/T4/T8/T9; §11 done → T8/T9/T10. ✅
**Open verifications flagged inline** (engineer confirms vs live code, not guess): exact tenant/job test helper names (T2,T4,T8); `board.tsx` notification mechanism (T5); `page.tsx` data-flow into `JobTabs` (T7); whether the app can fake R2 for the e2e upload leg (T9). Each names the fallback.
**Type consistency:** `parseProductionConfig`/`missingRequiredPhotos` (T1) match the gate (T4); `IncompletePhotosError.missing: string[]` (T4) matches `moveJobToStage`'s `{errorःmissing_photos, missing}` (T5) and the board (T5); `StorageGateway` (T3) matches the actions (T6). ✅
