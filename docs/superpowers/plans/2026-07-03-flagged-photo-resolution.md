# Flagged-Photo Resolution (Photo QC Slice 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user look at a flagged job-site photo on the job page and **Keep** it — flipping `qc_status` from `flagged` to `passed` (so it drops out of the Needs-you queue) and writing a `photo_qc_kept` audit-log entry.

**Architecture:** A new `@savvy/db` reader (`listFlaggedPhotosForJob`) and mutation (`keepFlaggedPhoto`, which flips status **and** writes the audit row atomically in one `withTenant` tx). A thin `apps/web` server action wraps the mutation and revalidates. A `FlaggedPhotosPanel` client component (reusing the existing `presignDocumentView` thumbnail pattern) renders on the job page with a per-photo **Keep** button. The exception queue is untouched — `listFlaggedPhotos` already filters `qc_status='flagged'`, so a kept photo disappears automatically.

**Tech Stack:** TypeScript, Drizzle + Postgres (RLS), Next.js 16 App Router (server actions + `revalidatePath`), Cloudflare R2 (presigned views), Vitest (db integration), pnpm monorepo.

## Global Constraints

- **Tenant isolation (non-negotiable):** every DB access via `withTenant`; the mutation additionally guards with an explicit `tenant_id` predicate (mirrors `setPhotoQc`).
- **No new migration:** reuse `document.qc_status`/`qc_reasons` (Slice 1 columns) and the existing `audit_log` table.
- **Idempotent + safe Keep:** the UPDATE guards `AND kind='photo' AND qc_status='flagged' AND job_id IS NOT NULL`; a second Keep (or a keep on a non-flagged/missing/other-tenant doc) updates zero rows → returns `null`, writes **no** audit row (no partial mutation).
- **Audit shape (exact):** `audit_log` row = `{ tenantId, userId, entityType: "document", entityId: <documentId>, action: "photo_qc_kept", diff: { from: "flagged", reasons: <prior qc_reasons> } }`. `agent` column is omitted (this is a user action).
- **Current-user id:** the server action resolves `getCurrentUser()`; in TEST_MODE that returns the non-UUID sentinel `"test-user"` — normalize it to `null` before passing to the audit (the `audit_log.user_id` FK is nullable).
- **Test command (db):** `cd packages/db && pnpm exec vitest run <file>` (the `pnpm --filter … vitest` form fails — there is no `vitest` script). Local Postgres test DB (`postgres://postgres:postgres@localhost:5432/savvy`) is already running; db tests run serially (`fileParallelism:false`).
- **Commit trailer:** `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

---

### Task 1: `@savvy/db` — flagged-photo reader + keep mutation

**Files:**
- Modify: `packages/db/src/lifecycle/photos.ts` (append two functions; extend the schema import to include `auditLog`)
- Modify: `packages/db/src/index.ts` (extend the `photos.ts` barrel export line)
- Create: `packages/db/src/lifecycle/photos-keep.test.ts`

**Interfaces:**
- Consumes (already in `photos.ts`): `withTenant`, `document`, drizzle `eq, and, desc, isNotNull`; the private `reasonText(raw: unknown): string` helper (Slice 2). Also the `auditLog` and `user` tables from `../schema/index`.
- Produces:
  ```ts
  listFlaggedPhotosForJob(tenantId: string, jobId: string): Promise<{ documentId: string; label: string | null; reason: string }[]>
  keepFlaggedPhoto(input: { tenantId: string; userId: string | null; documentId: string }): Promise<{ jobId: string } | null>
  ```

- [ ] **Step 1: Write the failing tests**

Create `packages/db/src/lifecycle/photos-keep.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { adminDb, tenant, customer, property, job, document, user, auditLog, withTenant, eq, and } from "../index";
import { listFlaggedPhotosForJob, keepFlaggedPhoto } from "../index";

async function seed() {
  const [t] = await adminDb.insert(tenant).values({ name: "K", publicKey: `pk-${crypto.randomUUID()}`, clerkOrgId: `org-${crypto.randomUUID()}` }).returning();
  const [c] = await adminDb.insert(customer).values({ tenantId: t!.id, name: "C" }).returning();
  const [p] = await adminDb.insert(property).values({ tenantId: t!.id, customerId: c!.id, address: "1 A St" }).returning();
  const [j] = await adminDb.insert(job).values({ tenantId: t!.id, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "production" }).returning();
  const [u] = await adminDb.insert(user).values({ tenantId: t!.id, name: "U", email: `u-${crypto.randomUUID()}@x.com` }).returning();
  return { tenantId: t!.id, customerId: c!.id, propertyId: p!.id, jobId: j!.id, userId: u!.id };
}

async function addPhoto(tenantId: string, jobId: string | null, opts: { qcStatus: string; qcReasons?: unknown; label?: string }) {
  const [d] = await adminDb.insert(document).values({
    tenantId, jobId, kind: "photo", label: opts.label ?? "ridge", r2Key: `r2-${crypto.randomUUID()}`,
    qcStatus: opts.qcStatus, qcReasons: opts.qcReasons ?? null,
  }).returning({ id: document.id });
  return d!.id;
}

describe("listFlaggedPhotosForJob", () => {
  it("returns only this job's flagged photos with a derived reason; excludes passed + other-job", async () => {
    const { tenantId, jobId, customerId, propertyId } = await seed();
    const flaggedA = await addPhoto(tenantId, jobId, { qcStatus: "flagged", qcReasons: { quality: "blurry" }, label: "ridge" });
    await addPhoto(tenantId, jobId, { qcStatus: "passed" }); // excluded: passed
    // another job in the same tenant, also flagged → excluded
    const [j2] = await adminDb.insert(job).values({ tenantId, customerId, propertyId, type: "retail", stage: "production" }).returning();
    await addPhoto(tenantId, j2!.id, { qcStatus: "flagged", qcReasons: { quality: "dark" } });

    const rows = await listFlaggedPhotosForJob(tenantId, jobId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ documentId: flaggedA, label: "ridge", reason: "blurry" });
  });
});

describe("keepFlaggedPhoto", () => {
  it("flips flagged→passed, writes one photo_qc_kept audit row, returns jobId", async () => {
    const { tenantId, jobId, userId } = await seed();
    const docId = await addPhoto(tenantId, jobId, { qcStatus: "flagged", qcReasons: { quality: "blurry", wrongCategory: true } });

    const res = await keepFlaggedPhoto({ tenantId, userId, documentId: docId });
    expect(res).toEqual({ jobId });

    const [d] = await withTenant(tenantId, (tx) => tx.select({ qcStatus: document.qcStatus }).from(document).where(eq(document.id, docId)));
    expect(d!.qcStatus).toBe("passed");

    const audits = await withTenant(tenantId, (tx) => tx.select().from(auditLog).where(and(eq(auditLog.entityId, docId), eq(auditLog.action, "photo_qc_kept"))));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.userId).toBe(userId);
    expect(audits[0]!.diff).toMatchObject({ from: "flagged", reasons: { quality: "blurry", wrongCategory: true } });
  });

  it("is a no-op returning null on an already-passed doc (no second audit row)", async () => {
    const { tenantId, jobId, userId } = await seed();
    const docId = await addPhoto(tenantId, jobId, { qcStatus: "flagged", qcReasons: { quality: "blurry" } });
    await keepFlaggedPhoto({ tenantId, userId, documentId: docId });         // first keep
    const again = await keepFlaggedPhoto({ tenantId, userId, documentId: docId }); // second
    expect(again).toBeNull();
    const audits = await withTenant(tenantId, (tx) => tx.select().from(auditLog).where(and(eq(auditLog.entityId, docId), eq(auditLog.action, "photo_qc_kept"))));
    expect(audits).toHaveLength(1);
  });

  it("returns null for a missing document id", async () => {
    const { tenantId, userId } = await seed();
    expect(await keepFlaggedPhoto({ tenantId, userId, documentId: crypto.randomUUID() })).toBeNull();
  });

  it("accepts a null userId (unauthenticated/TEST_MODE) and still writes the audit row", async () => {
    const { tenantId, jobId } = await seed();
    const docId = await addPhoto(tenantId, jobId, { qcStatus: "flagged", qcReasons: { duplicateOf: "doc-9" } });
    const res = await keepFlaggedPhoto({ tenantId, userId: null, documentId: docId });
    expect(res).toEqual({ jobId });
    const audits = await withTenant(tenantId, (tx) => tx.select().from(auditLog).where(and(eq(auditLog.entityId, docId), eq(auditLog.action, "photo_qc_kept"))));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.userId).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/db && pnpm exec vitest run src/lifecycle/photos-keep.test.ts`
Expected: FAIL — `listFlaggedPhotosForJob` / `keepFlaggedPhoto` not exported.

- [ ] **Step 3: Extend the schema import in `photos.ts`**

At the top of `packages/db/src/lifecycle/photos.ts`, change:

```ts
import { property, job, document } from "../schema/index";
```
to:
```ts
import { property, job, document, auditLog } from "../schema/index";
```

(The `import { eq, and, desc, sql, isNull, isNotNull, ne } from "drizzle-orm";` line already has every operator this task needs — no change.)

- [ ] **Step 4: Implement both functions**

Append to `packages/db/src/lifecycle/photos.ts` (after the existing `listFlaggedPhotos` / `reasonText`):

```ts
/** Flagged photos on ONE job, for the job page's resolution panel. reason via reasonText. */
export async function listFlaggedPhotosForJob(
  tenantId: string,
  jobId: string,
): Promise<{ documentId: string; label: string | null; reason: string }[]> {
  return withTenant(tenantId, async (tx) => {
    const rows = await tx
      .select({ id: document.id, label: document.label, qcReasons: document.qcReasons })
      .from(document)
      .where(and(eq(document.jobId, jobId), eq(document.kind, "photo"), eq(document.qcStatus, "flagged")))
      .orderBy(desc(document.createdAt));
    return rows.map((r) => ({ documentId: r.id, label: r.label, reason: reasonText(r.qcReasons) }));
  });
}

/**
 * Accept a flagged photo: flip qc_status flagged→passed AND record a photo_qc_kept
 * audit entry, atomically. The WHERE guard (flagged + non-null job + tenant) makes this
 * idempotent and safe — a non-flagged/missing/other-tenant doc updates 0 rows → null, no audit.
 */
export async function keepFlaggedPhoto(input: {
  tenantId: string;
  userId: string | null;
  documentId: string;
}): Promise<{ jobId: string } | null> {
  return withTenant(input.tenantId, async (tx) => {
    const [updated] = await tx
      .update(document)
      .set({ qcStatus: "passed" })
      .where(
        and(
          eq(document.id, input.documentId),
          eq(document.tenantId, input.tenantId),
          eq(document.kind, "photo"),
          eq(document.qcStatus, "flagged"),
          isNotNull(document.jobId),
        ),
      )
      .returning({ jobId: document.jobId, qcReasons: document.qcReasons });
    if (!updated || !updated.jobId) return null;
    await tx.insert(auditLog).values({
      tenantId: input.tenantId,
      userId: input.userId,
      entityType: "document",
      entityId: input.documentId,
      action: "photo_qc_kept",
      diff: { from: "flagged", reasons: (updated.qcReasons ?? {}) as Record<string, unknown> },
    });
    return { jobId: updated.jobId };
  });
}
```

- [ ] **Step 5: Extend the barrel export**

In `packages/db/src/index.ts`, find the photos export line (it lists `resolvePhotoJob, … , getPhotoForQc, getJobPhotoHashes, setPhotoQc, listFlaggedPhotos`) and add the two new names to it:

```ts
export { resolvePhotoJob, resolveTenantByIngestKey, recordSiteSnapPhoto, listUnmatchedPhotos, matchPhotoToJob, getPhotoForQc, getJobPhotoHashes, setPhotoQc, listFlaggedPhotos, listFlaggedPhotosForJob, keepFlaggedPhoto } from "./lifecycle/photos";
```

- [ ] **Step 6: Run tests + typecheck**

Run: `cd packages/db && pnpm exec vitest run src/lifecycle/photos-keep.test.ts` → PASS (5 tests).
Run: `pnpm --filter @savvy/db typecheck` → clean.

- [ ] **Step 7: Commit**

```bash
git add packages/db/src/lifecycle/photos.ts packages/db/src/index.ts packages/db/src/lifecycle/photos-keep.test.ts
git commit -m "feat(db): listFlaggedPhotosForJob + keepFlaggedPhoto (status flip + audit)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `apps/web` — Keep server action + FlaggedPhotosPanel + job-page wiring + KIND_LABEL fix

**Files:**
- Modify: `apps/web/src/lib/document-actions.ts` (add `keepFlaggedPhoto` server action)
- Create: `apps/web/src/app/(app)/jobs/[id]/FlaggedPhotosPanel.tsx`
- Modify: `apps/web/src/app/(app)/jobs/[id]/page.tsx` (load flagged photos + render the panel)
- Modify: `apps/web/src/app/(app)/exceptions/page.tsx` (`KIND_LABEL` additions)

**Interfaces:**
- Consumes: `keepFlaggedPhoto`, `listFlaggedPhotosForJob` (`@savvy/db`); `getCurrentUser` (`@/lib/current-user`); `getTenantId` (`@/lib/tenant`); `presignDocumentView` (`@/lib/document-actions`, existing).
- Produces:
  ```ts
  // server action
  keepFlaggedPhoto(documentId: string): Promise<{ ok: true } | { error: "not_found" }>
  // client component
  <FlaggedPhotosPanel jobId={string} documents={{ documentId: string; label: string | null; reason: string }[]} />
  ```

**Note on testing:** all business logic (status flip, audit, filtering) is proven by Task 1's db integration tests. This task is thin glue: the server action's `getCurrentUser()`/`revalidatePath()` cannot run outside the Next runtime, and the client component reuses the already-shipped `presignDocumentView` + `<img>` pattern from `DocsPanel`. Verify it via **typecheck + lint** (both must be clean) and a manual smoke; do **not** invent a heavy mock harness for the wrapper. If adding a Playwright e2e later, assert: a job with a flagged photo shows the panel, clicking **Keep** removes the row.

- [ ] **Step 1: Add the `keepFlaggedPhoto` server action**

Append to `apps/web/src/lib/document-actions.ts`. Add these imports at the top (next to the existing `getTenantId` import):

```ts
import { keepFlaggedPhoto as dbKeepFlaggedPhoto } from "@savvy/db";
import { getCurrentUser } from "./current-user";
```

Then add the action:

```ts
/**
 * Accept a flagged photo ("Keep"). Flips qc_status flagged→passed + writes an audit row
 * (via the db layer), then revalidates the job page and the exceptions queue so the
 * photo_quality exception clears. Idempotent — a non-flagged/foreign doc returns not_found.
 */
export async function keepFlaggedPhoto(
  documentId: string,
): Promise<{ ok: true } | { error: "not_found" }> {
  const { tenantId, userId } = await getCurrentUser();
  // TEST_MODE's getCurrentUser returns the non-UUID sentinel "test-user"; the audit
  // user_id FK is nullable, so record null rather than a fake id.
  const auditUserId = userId === "test-user" ? null : userId;
  const res = await dbKeepFlaggedPhoto({ tenantId, userId: auditUserId, documentId });
  if (!res) return { error: "not_found" };
  revalidatePath(`/jobs/${res.jobId}`);
  revalidatePath("/exceptions");
  return { ok: true };
}
```

(`revalidatePath` and `getTenantId` are already imported in this file. `getCurrentUser` also exposes `tenantId`, so we take it from there rather than a second `getTenantId()` call.)

- [ ] **Step 2: Create the `FlaggedPhotosPanel` client component**

Create `apps/web/src/app/(app)/jobs/[id]/FlaggedPhotosPanel.tsx`:

```tsx
"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { presignDocumentView, keepFlaggedPhoto } from "@/lib/document-actions";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

export interface FlaggedPhoto {
  documentId: string;
  label: string | null;
  reason: string;
}

// Presigns a view URL on mount and renders the thumbnail (mirrors DocsPanel's DocThumb).
function Thumb({ docId, alt }: { docId: string; alt: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    presignDocumentView(docId).then((res) => {
      if (cancelled) return;
      if ("ok" in res) setSrc(res.url);
      else setFailed(true);
    });
    return () => { cancelled = true; };
  }, [docId]);
  if (failed) return <div className="flex h-24 w-24 items-center justify-center rounded-md border border-border bg-muted text-xs text-muted-foreground">unavailable</div>;
  if (!src) return <div className="h-24 w-24 animate-pulse rounded-md bg-muted" aria-label="Loading photo" />;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt={alt} className="h-24 w-24 rounded-md border border-border object-cover" />;
}

function KeepButton({ docId }: { docId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  function onKeep() {
    startTransition(async () => {
      const res = await keepFlaggedPhoto(docId);
      if ("ok" in res) {
        toast.success("Photo kept");
        router.refresh();
      } else {
        toast.error("Could not keep photo");
      }
    });
  }
  return (
    <Button size="sm" variant="outline" onClick={onKeep} disabled={pending} data-testid="keep-flagged-photo">
      {pending ? "Keeping…" : "Keep"}
    </Button>
  );
}

export function FlaggedPhotosPanel({ jobId: _jobId, documents }: { jobId: string; documents: FlaggedPhoto[] }) {
  if (documents.length === 0) return null;
  return (
    <Card data-testid="flagged-photos-panel">
      <CardHeader><CardTitle>Flagged photos</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        {documents.map((d) => (
          <div key={d.documentId} className="flex items-center gap-3" data-testid="flagged-photo-row">
            <Thumb docId={d.documentId} alt={d.label ?? "flagged photo"} />
            <div className="flex-1">
              <div className="text-sm font-medium">{d.label ?? "Photo"}</div>
              <div className="text-xs" style={{ color: "var(--text-faint)" }}>{d.reason}</div>
            </div>
            <KeepButton docId={d.documentId} />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 3: Wire the panel into the job page**

In `apps/web/src/app/(app)/jobs/[id]/page.tsx`:

1. Add imports near the other `@/lib` + local-component imports:
```ts
import { listFlaggedPhotosForJob } from "@savvy/db";
import { FlaggedPhotosPanel } from "./FlaggedPhotosPanel";
```
2. After the main `withTenant(...)` data load resolves (where other per-job lib queries like `listEstimatesForJob` are already awaited), load the flagged photos:
```ts
const flaggedPhotos = await listFlaggedPhotosForJob(tenantId, id);
```
(`tenantId` and `id` are already in scope in this component — `tenantId` from `getTenantId()` at the top, `id` the route param used in the docs query.)
3. In the returned JSX, render the panel just before `<JobTabs …/>`:
```tsx
<FlaggedPhotosPanel jobId={id} documents={flaggedPhotos} />
```
The component returns `null` when there are no flagged photos, so it is safe to always render.

- [ ] **Step 4: Fix `KIND_LABEL` on the exceptions page**

In `apps/web/src/app/(app)/exceptions/page.tsx`, add the two missing kinds to the `KIND_LABEL` map (currently they render as raw kind strings):

```ts
  photo_incomplete: "Photos",
  photo_quality: "Photo QC",
  photo_unmatched: "Unmatched photo",
```

(Add the `photo_quality` and `photo_unmatched` lines; leave the existing entries as-is.)

- [ ] **Step 5: Typecheck + lint**

Run: `pnpm --filter @savvy/web typecheck` → clean.
Run: `pnpm --filter @savvy/web lint` → 0 errors (warnings OK).

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/document-actions.ts "apps/web/src/app/(app)/jobs/[id]/FlaggedPhotosPanel.tsx" "apps/web/src/app/(app)/jobs/[id]/page.tsx" "apps/web/src/app/(app)/exceptions/page.tsx"
git commit -m "feat(web): keep flagged photos on the job page + exception label fix

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- "Keep" action, single verb → Task 2 (`KeepButton` + server action) + Task 1 (`keepFlaggedPhoto`). ✓
- Lives on the job page with a thumbnail → Task 2 (`FlaggedPhotosPanel` + page wiring, reuses `presignDocumentView`). ✓
- Set `qc_status='passed'` → Task 1 (`keepFlaggedPhoto` UPDATE). ✓
- Write `audit_log` `photo_qc_kept` with `{from:'flagged', reasons}` → Task 1 (audit insert) + Task 2 (real userId, TEST_MODE→null). ✓
- Drops from Needs-you automatically → no queue change needed; `listFlaggedPhotos` filters `flagged` (verified in Slice 2). ✓
- Reader `listFlaggedPhotosForJob` → Task 1. ✓
- Audit surfaces in job Timeline → free (job page already renders `audit_log`); no task needed. ✓
- `KIND_LABEL` fix for `photo_quality`/`photo_unmatched` → Task 2 Step 4. ✓
- No migration → confirmed (reuses Slice 1 columns + existing `audit_log`). ✓
- Tenant isolation + idempotent guard → Task 1 WHERE clause + tests. ✓

**Placeholder scan:** No TBD/TODO. The "manual smoke / optional e2e" note in Task 2 is a deliberate, justified test-strategy statement (all logic is proven at the db layer in Task 1; the wrapper cannot run outside Next), not a skipped requirement. All code blocks are complete.

**Type consistency:** `keepFlaggedPhoto` (db) `{ tenantId; userId: string|null; documentId } → { jobId } | null` is consistent between Task 1 (def + tests) and Task 2 (server action call). The server action `keepFlaggedPhoto(documentId) → { ok:true } | { error:"not_found" }` matches its `FlaggedPhotosPanel` caller (`"ok" in res`). `listFlaggedPhotosForJob → { documentId; label; reason }[]` matches the `FlaggedPhoto` interface and the page's `documents` prop. `reasonText` reused unchanged.

## Out of scope / follow-ups
- Request-re-take (crew comms), delete-photo, bulk-clear, cross-job `/photos/flagged` tray.
- Wiring `matchPhotoToJob` to re-emit `photo/ingested` (independent Slice 1 follow-up).
