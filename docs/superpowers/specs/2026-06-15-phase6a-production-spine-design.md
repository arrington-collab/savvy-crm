# Phase 6A — Production Spine (Design Spec)

**Date:** 2026-06-15
**Parent:** Phase 6 (Production & close-out) is delivered as sequenced slices — **6A (this spec): the production spine (file storage + photo/doc upload + completion gating)**, then 6B (DocuSeal lien waivers/certs), 6C (change orders), 6D (CompanyCam + crew check-in). Roadmap Phase 6 done-when: "a job goes approved → produced → closed with documents attached."

## 1. Summary

6A makes a job's documentation real: crews/reps attach photos and documents to a job, files live in Cloudflare R2 (uploaded **directly** from the browser via short-lived presigned URLs — never through the Next server), and **a job cannot be marked `complete` until every required photo label for its job type has at least one photo.** Required labels are configured per job type in tenant settings. This delivers the core of the roadmap's "produced → closed with documents attached" spine.

The `document` table already exists (`kind`, `r2Key`, `source`, `sizeBytes`, `sharedWith`) but nothing populates `r2Key` — there is no storage code yet. 6A builds that.

## 2. Scope decisions (locked during brainstorming)

| Decision | Choice |
|---|---|
| Required-photo model | Configurable checklist **per job type** (`tenant.settings.production.requiredPhotos`) |
| Gate point | Block the transition **into `complete`** (any source stage); other transitions unaffected |
| Upload mechanism | **Presigned direct-to-R2** PUT (browser → R2), then record metadata |
| Default required labels | `["before","after"]` per type; `insurance` also `"permit"` |

### Out of scope (deferred to later 6 slices)
- **Sharing** photos/docs with the customer (`document.sharedWith`) → 6D (CompanyCam + sharing).
- **CompanyCam** import (`source:"companycam"`) → 6D.
- **DocuSeal** lien waivers / certs e-sign → 6B.
- **Change orders** → 6C.
- **Storage metering / billing** (sum `sizeBytes` per tenant) → Phase 8. 6A records `sizeBytes` so the data exists.
- **Thumbnail generation / image resizing** — display uses the original via a presigned GET; no server-side image processing.

## 3. Architecture approach

Reuse established patterns:
- **Storage** is an injectable gateway (`StorageGateway`) mirroring `StripeGateway`/`QboGateway` — real R2 impl + `makeFakeStorage` fake for tests. Files move browser↔R2 directly; the server only signs URLs and records metadata.
- **Gating** is pure logic in `@savvy/core` (`missingRequiredPhotos`) invoked inside the existing `recordStageChange` transaction (Phase 2). A blocked transition throws a typed error the `moveJobToStage` server action turns into a result the UI renders.
- **Config** lives in `tenant.settings.production` (jsonb), parsed once by a `@savvy/core` zod schema with defaults — same pattern as `parseFinanceConfig`.
- **No AI, no Inngest** — uploads and gating are synchronous request/response; nothing here is a durable workflow.

## 4. Data model changes (migration `0006`)

### 4.1 `document` (table exists in `schema/ops.ts`)
- Add `label text` (nullable) — the checklist category for a photo (e.g. `"before"`, `"after"`, `"permit"`). Only meaningful when `kind = "photo"`. All existing columns unchanged.

### 4.2 `tenant.settings.production` (jsonb, no new table)
Parsed by a `@savvy/core` zod schema with defaults:
```jsonc
{ "requiredPhotos": {
    "retail":     ["before", "after"],
    "insurance":  ["before", "after", "permit"],
    "repair":     ["before", "after"],
    "commercial": ["before", "after"]
} }
```
- Keys are the `JOB_TYPE` values (`retail|insurance|repair|commercial`); each value is a string[] of required labels. Empty array = no requirement.
- The zod schema fills every job-type key with the defaults above so existing tenants (settings `{}`) parse cleanly. Label strings are free-form (lowercased, trimmed by the parser).

### 4.3 No enum changes
`document.kind` and `document.label` stay free `text` (kind already documents its valid set in a comment; label is open-ended by design).

## 5. Storage gateway (`packages/integrations/src/storage.ts`)

```ts
export interface StorageGateway {
  presignUpload(o: { key: string; contentType: string }): Promise<{ url: string }>;   // short-lived PUT
  presignDownload(o: { key: string }): Promise<{ url: string }>;                        // short-lived GET
}
```
- **`r2Storage`** — real impl using `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` (R2 is S3-compatible). Client configured with `endpoint: https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com`, `region: "auto"`, credentials from env. `presignUpload`/`presignDownload` use `getSignedUrl` with `PutObjectCommand`/`GetObjectCommand`, expiry ~300s.
- **`makeFakeStorage()`** — returns deterministic `https://fake-r2/<key>?sig=...` URLs and records calls (unit/e2e), same shape as `makeFakeStripe`/`makeFakeQbo`.
- Env (documented in `.env.example`): `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`. **Prerequisite:** a provisioned R2 bucket; until creds are set the real impl throws on use (fake is used in tests), and the app surfaces a "storage not configured" error rather than crashing.
- New dependency on `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` in `@savvy/integrations`.

## 6. Upload flow (server actions, `apps/web/src/lib/document-actions.ts`)

All actions resolve `getTenantId()` and operate under `withTenant`.

1. **`presignDocumentUpload({ jobId, kind, label?, filename, contentType })`** → verify the job belongs to the tenant; build a tenant-scoped key `${tenantId}/${jobId}/${uuidLikeFromCryptoRandom}-${safeFilename}`; return `{ uploadUrl, r2Key }`. (UUID: use `crypto.randomUUID()` server-side — allowed in Next server runtime; NOT the workflow-script-banned `Math.random`.)
2. Browser `PUT`s the file bytes directly to `uploadUrl` with the matching `Content-Type`.
3. **`recordDocument({ jobId, r2Key, kind, label?, filename, mime, sizeBytes })`** → insert the `document` row (`source:"savvy"`, `tenantId`, `customerId` resolved from the job). Reject if `r2Key` doesn't match the `${tenantId}/${jobId}/` prefix (defense-in-depth against a forged key). Returns the row. `revalidatePath('/jobs/[id]')`.
4. **`presignDocumentView(documentId)`** → load the document (tenant-scoped), return a short-lived GET URL for display/download.

## 7. Completion gating

### 7.1 Pure core (`packages/core/src/production.ts`)
```ts
export function missingRequiredPhotos(required: string[], present: string[]): string[];
// returns the required labels with no matching present label (case-insensitive, trimmed). [] = complete.
```
Plus `parseProductionConfig(raw) -> { requiredPhotos: Record<JobType,string[]> }` with the §4.2 defaults.

### 7.2 Gate in `recordStageChange` (`packages/db/src/lifecycle/record-stage-change.ts`)
At the **top** of `recordStageChange`, before any mutation: if `opts.toStage === "complete"`, read the job's `type`, the tenant's `settings.production.requiredPhotos[type]`, and the **distinct non-null `label`s** of the job's `kind='photo'` documents; compute `missingRequiredPhotos(required, presentLabels)`. If non-empty, **throw `IncompletePhotosError(missing: string[])`** (a typed error exported from `@savvy/db`) — this aborts the surrounding transaction, so no stage move / event / audit row is written. All other `toStage` values skip the check entirely.

### 7.3 Caller handling (`moveJobToStage` server action — Phase 2, in `apps/web/src/lib`)
Wrap the `recordStageChange` call: catch `IncompletePhotosError` and return `{ error: "missing_photos", missing }` (typed) instead of throwing. The drag board + job detail render the block with the missing labels. (Find the existing action — Phase 2 `/jobs` board calls it synchronously; do not change its happy-path contract, only add the catch.)

## 8. UI (`apps/web/src/app/(app)/jobs/[id]`, existing "Docs" tab)

- **Required-photo checklist widget**: for the job's type, list each required label with ✓ (≥1 photo present) or ✗ (missing), reading the same data the gate uses. Shows the rep exactly what blocks completion *before* they try to close.
- **Photo/doc grid**: thumbnails (an `<img>` whose `src` is a `presignDocumentView` URL), grouped by label; non-photo kinds listed with filename + download link.
- **Upload control**: a client component with `<input type="file" accept="image/*" capture="environment">` (opens the rear camera on mobile) + a label `<select>` (the job type's required labels + "other"); plus a generic document upload (kind selector: photo/measurement/contract/evidence/other). On select: call `presignDocumentUpload` → `PUT` to R2 with an upload-progress state → `recordDocument` → refresh.
- **Gate surfacing**: if a `complete` move returns `missing_photos`, show a toast/inline error listing the missing labels (on both the board and the detail page).

## 9. Error handling
- **Presign**: job not found / not tenant's → typed error result, no URL issued.
- **Upload**: a failed direct PUT to R2 is surfaced in the client (retry); no `document` row is recorded unless `recordDocument` is called after a successful PUT. An orphaned R2 object (PUT succeeded, `recordDocument` never called) is harmless (just unreferenced storage) — acceptable for 6A; a sweep is a later concern.
- **`recordDocument`**: rejects keys not under the caller's `${tenantId}/${jobId}/` prefix.
- **Gate**: `IncompletePhotosError` is the only new throw; every other stage transition behaves exactly as Phase 2.
- **Storage not configured** (no R2 env): real gateway throws a clear "storage_not_configured" error the actions translate to a result; app does not crash.

## 10. Testing
- **Unit (`@savvy/core`):** `missingRequiredPhotos` (case-insensitive, trims, empty-required, all-present, some-missing); `parseProductionConfig` defaults + partial-override merge.
- **Integration (`@savvy/db`):** `recordStageChange` throws `IncompletePhotosError` on `→complete` with a missing label and writes NO stage event/audit (tx aborted); allows `→complete` when all present; non-`complete` transitions never check photos. Reuse the test helpers (tenant/job/document inserts).
- **Storage (`@savvy/integrations`):** `makeFakeStorage` returns deterministic URLs + records calls.
- **RLS:** extend the isolation test to cover `document` (it is not currently covered) — cross-tenant read returns zero.
- **e2e (Playwright):** on a job missing a required photo, attempting to move to `complete` is blocked with the missing label shown; upload the photo (fake storage) → checklist flips ✓ → move to `complete` succeeds.
- **Static gate:** `pnpm typecheck && pnpm lint && pnpm test` green.

## 11. Definition of done (per repo CLAUDE.md)
- [ ] `document.label` + `tenant.settings.production` added; migration `0006`; `document` covered by the RLS isolation test.
- [ ] Files upload **directly** to R2 via presigned PUT (never through the server); presign actions verify job/tenant ownership; `recordDocument` validates the key prefix.
- [ ] Gate logic is pure (`@savvy/core`) + enforced transactionally in `recordStageChange`; blocked move writes nothing.
- [ ] No hard-coded provider strings; storage via the `StorageGateway` wrapper; no secrets committed (R2 creds via env, documented in `.env.example`).
- [ ] Unit + integration + e2e tests pass; typecheck + lint clean.
- [ ] One reviewed PR (base **main**) with a clear summary.

## 12. Tracked follow-ups (deferred)
- Customer sharing of documents (`sharedWith`) — 6D.
- CompanyCam import (`source:"companycam"`) — 6D.
- Orphaned-R2-object sweep (PUT succeeded but `recordDocument` never called).
- Server-side thumbnail generation (display currently loads originals).
- Storage metering / cold-archive (Phase 8).
- Per-job-type required-photo config **UI** in settings (6A reads config from `settings.production`; editing it in the UI is deferred — seed/admin-set for now).
