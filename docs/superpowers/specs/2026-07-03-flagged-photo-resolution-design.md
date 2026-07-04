# Flagged-Photo Resolution (Photo QC Slice 3) — Design

**Date:** 2026-07-03
**Status:** Approved (design)
**Depends on:** Photo QC Slice 2 (PR #122, `b8e6295`) — the `photo_quality` exception + `qc_status`/`qc_reasons` columns.

## Problem

Slice 2 detects bad job-site photos and surfaces them as `photo_quality` "Needs-you" exceptions (derived from `listFlaggedPhotos`, which filters `document.qc_status = 'flagged'`). But nothing can move a photo **out** of the `flagged` state, so the exception queue can only grow — the detect-and-surface loop never closes. A flag is often a false positive (a "blurry" call on a photo that's actually fine), and the user needs a way to accept it.

## Goal

Let a user look at a flagged photo **on the job page** and **Keep** it (accept as fine). Keeping:
1. Sets `qc_status = 'flagged' → 'passed'`, so the photo drops out of the Needs-you queue automatically (no queue code changes — the marker-column vector pattern already filters on `'flagged'`).
2. Writes an `audit_log` entry (`photo_qc_kept`) that surfaces in the existing job Timeline, giving a paper trail and a QC false-positive signal.

**Scope is deliberately minimal: one verb, "Keep."** Re-take (crew comms), delete-photo, bulk-clear, and a cross-job flagged tray are explicitly future slices.

## Decisions (resolved during brainstorming)

| Question | Decision |
|---|---|
| Which resolution actions? | **Just "Keep"** (mark passed). No re-take/delete this slice. |
| Where does the action live? | **Job-page photo-QC section** with a thumbnail of the actual photo (you see it before deciding), reached via the exception's existing `href` (`/jobs/{jobId}`). Not inline on the text-only exceptions row. |
| What to record on Keep? | **Set `qc_status='passed'` + write an `audit_log` row** (`{ userId, entityType:'document', entityId:documentId, action:'photo_qc_kept', diff:{ from:'flagged', reasons } }`). Reuses `'passed'` (no new status value); the human-override distinction is derivable from the audit action. |

## Architecture & Data Flow

```
Job page (server component, apps/web/src/app/(app)/jobs/[id]/page.tsx)
  └─ loads listFlaggedPhotosForJob(tenantId, jobId) → [{ documentId, label, reason }]
     └─ renders <FlaggedPhotosPanel documents=… />   (only when the job has ≥1 flagged photo)

FlaggedPhotosPanel (client component)
  per photo: thumbnail (reuses presignDocumentView(documentId) → <img>) + reason text + [Keep] button
  [Keep] → keepFlaggedPhoto(documentId) server action → router.refresh()

keepFlaggedPhoto (server action, apps/web/src/lib/document-actions.ts)
  resolves tenantId + current userId → calls db keepFlaggedPhoto({ tenantId, userId, documentId })
  on success → revalidatePath('/jobs/{jobId}') + revalidatePath('/exceptions')

db keepFlaggedPhoto({ tenantId, userId, documentId })  (packages/db/src/lifecycle/photos.ts)
  withTenant tx:
    UPDATE document SET qc_status='passed'
      WHERE id = documentId AND kind='photo' AND qc_status='flagged'   ← idempotency + safety guard
      RETURNING job_id, qc_reasons
    if no row updated → return null   (already passed / not a flagged photo / wrong tenant)
    INSERT audit_log { tenantId, userId, entityType:'document', entityId:documentId,
                       action:'photo_qc_kept', diff:{ from:'flagged', reasons } }
    return { jobId }

Exception queue: UNCHANGED. listFlaggedPhotos filters qc_status='flagged';
a kept photo (now 'passed') simply no longer appears.
```

## Components / Units

| Layer | Change | Interface |
|---|---|---|
| `@savvy/db` | **New** `listFlaggedPhotosForJob` reader (reuses the existing `reasonText` helper from Slice 2). | `listFlaggedPhotosForJob(tenantId: string, jobId: string): Promise<{ documentId: string; label: string \| null; reason: string }[]>` — only `kind='photo'`, `qc_status='flagged'`, this job. |
| `@savvy/db` | **New** `keepFlaggedPhoto` lifecycle mutation — atomic status-flip **+** `audit_log` insert in one `withTenant` tx. Barrel-export both new names on the `photos.ts` export line. | `keepFlaggedPhoto(input: { tenantId: string; userId: string \| null; documentId: string }): Promise<{ jobId: string } \| null>` |
| `apps/web` | **New** `keepFlaggedPhoto` server action in `document-actions.ts`: resolves tenant + current user, calls the db mutation, revalidates the job + exceptions pages. | `keepFlaggedPhoto(documentId: string): Promise<{ ok: true } \| { error: "not_found" }>` |
| `apps/web` | **New** `FlaggedPhotosPanel` client component — mirrors `DocsPanel`'s `DocThumb` (presign-on-mount → `<img>`); a **Keep** button per photo runs the server action in a transition, then `router.refresh()`. | props: `{ jobId: string; documents: { documentId: string; label: string \| null; reason: string }[] }` |
| `apps/web` | **Wire** the panel into the job page (render when `flaggedPhotos.length > 0`); **load** `listFlaggedPhotosForJob` in the page's tenant tx. | — |
| `apps/web` | **Fix** `KIND_LABEL` on the exceptions page to add `photo_quality: "Photo QC"` and `photo_unmatched: "Unmatched photo"` (both currently render as raw kind strings — a Slice 1/2 gap). | — |

## Non-negotiables honored

- **Tenant isolation:** every DB access via `withTenant`; the mutation's `WHERE qc_status='flagged'` guard makes Keep idempotent and prevents touching an already-passed doc or crossing tenants (RLS + explicit predicate).
- **No new migration:** reuses `qc_status`/`qc_reasons` (Slice 1 columns) and the existing `audit_log` table.
- **Auditable:** the `photo_qc_kept` entry appears in the job Timeline, which already renders `audit_log` rows — no extra timeline UI.
- **Events:** none emitted; this slice only mutates DB state and reads it back.

## Testing

- `@savvy/db` integration (`packages/db/src/lifecycle/photos-qc.test.ts` or a sibling):
  - `listFlaggedPhotosForJob` returns only this job's `flagged` photos; excludes `passed` photos and other-job flagged photos; `reason` derives from `qc_reasons`.
  - `keepFlaggedPhoto` flips `flagged → passed`, writes exactly one `audit_log` row with `action='photo_qc_kept'` and the prior reasons in `diff`, and returns `{ jobId }`.
  - `keepFlaggedPhoto` on a non-flagged doc (already `passed`) or a missing/other-tenant id returns `null` and writes **no** audit row (idempotency + safety).
- `apps/web`: the UI is thin (reuses `presignDocumentView` + button→action→`router.refresh()`); covered by the db layer plus a light render assertion that a flagged job shows the panel and a clean job does not. Follow existing job-page test conventions.

## Open implementation detail (settle in the plan)

- **Current-user id for the audit `userId`:** match however existing server-action mutations resolve the acting user (e.g. the helper used alongside `getTenantId`, consistent with how `record-stage-change` callers pass `userId`). If no clean per-request user id is available, `userId` is nullable in `audit_log` — pass `null` rather than block, and note it as a follow-up.

## Out of scope (future slices)

- **Request re-take** — notify crew/homeowner to reshoot; needs a comms path + a "awaiting new photo" state.
- **Delete photo** — remove the bad `document` from the job entirely.
- **Bulk-clear** — keep all flagged photos on a job at once.
- **Cross-job flagged tray** — a `/photos/flagged` review surface across jobs (parallels the planned `/photos/unmatched` tray).
- Wiring `matchPhotoToJob` (manual match) to re-emit `photo/ingested` so QC fires on manually-matched photos (a Slice 1 follow-up, independent of this).
