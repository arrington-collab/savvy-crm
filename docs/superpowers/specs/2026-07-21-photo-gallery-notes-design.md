# Job photo gallery (arrow nav) + per-photo notes that feed estimate drafting

**Date:** 2026-07-21
**Status:** Approved (Brett) — gallery = all job photos; notes steer the AI upsell suggestions.

## Problem / goal
A rep reviewing a job's photos can't page through them (the existing
`PhotoAnnotator` opens ONE photo full-screen with markup, no prev/next), and
there's nowhere to jot a free-form observation on a photo. Brett wants to:
1. Click ◀/▶ to move through **all photos on the job** in a full-screen gallery.
2. Write a **note** on each photo.
3. Have those notes **feed AI estimate drafting** so the draft reflects what the
   rep saw in the field.

## Scope decisions (confirmed)
- Gallery pages through **all `kind="photo"` documents on the job** (the Docs tab set).
- "Feed estimate drafting" = the notes are added to the **AI upsell-suggestion**
  prompt (`generateUpsells`). The base estimate line items come from the Roofr
  measurement + price book deterministically and are NOT AI-driven, so photo
  notes cannot change them — they steer the AI's optional-upgrade suggestions,
  which is exactly the judgment-call surface a rep's photo observations inform.

## Architecture

### Data
`document` gains a nullable `notes` text column (free-form, per photo; distinct
from the existing short `label`). Drizzle-generated migration **0116**.

### DB write path (`packages/db`)
`setDocumentNote(tenantId, { documentId, notes })` — one tenant-scoped
`withTenant` update of `document.notes` (trims; empty string → null). Returns
false if the document doesn't exist in the tenant. RLS-safe. Unit-tested.

### Web save action (`apps/web/src/lib/document-actions.ts`)
`saveDocumentNoteAction(documentId, notes): { ok } | { error }` — mirrors the
existing thin server-action pattern: `getTenantId()` → `setDocumentNote` →
`revalidatePath('/jobs/...')` is NOT needed (autosave is client-local; the note
re-reads on next server render). Returns `{ ok }`.

### Gallery UI (`apps/web/src/app/(app)/jobs/[id]/`)
Extend `PhotoAnnotator` into a gallery (keep its markup viewer; add navigation +
notes). `DocsPanel` already computes `photos = documents.filter(kind==="photo")`
and opens the annotator via `annotating` state — change it to pass the **full
photo list + the clicked index** instead of a single doc.

The gallery shows: the current image, ◀/▶ arrow buttons + `ArrowLeft`/`ArrowRight`
keyboard nav (wrapping or clamped — clamped, with disabled arrows at the ends),
a photo counter ("3 / 12"), and a **notes `<textarea>`** beside/under the image
seeded from `document.notes`. Typing **autosaves** debounced (~800ms) via
`saveDocumentNoteAction` with a subtle "Saved" indicator (no save button —
matches the "automatic over manual" preference). The existing markup tools stay.
Notes are per-photo: navigating swaps the textarea to the new photo's note.

`DocRow` (the DocsPanel row type) + `AnnotatorDoc` gain `notes: string | null`.

### AI wiring (`packages/agents/src/functions/estimate-generate.ts`)
`generateUpsells` gains an optional scope so it can fetch the job's photo notes:
`generateUpsells(tenantId, measurementId, scope?: { jobId?: string }, aiClient?)`.
When `scope.jobId` is set, it loads `document` rows (`kind="photo"`, `notes`
non-null) for that job and appends them to the prompt, e.g.:
`"Field notes on inspection photos: - gutters dented, north side\n- 3 aged skylights"`.
Empty/no notes → prompt unchanged (current behaviour preserved). `attachUpsells`
threads the `jobId` it already has at both call sites (lines ~126, ~173) into
`generateUpsells`. A new tiny db helper `listJobPhotoNotes(tenantId, jobId):
string[]` returns the trimmed non-empty notes for that job (tenant-scoped).

The AI call stays gateway-routed by capability (`"reasoning"`) — no model string.

## Data flow
Rep opens a photo → gallery → arrows across the job's photos → types a note →
autosave writes `document.notes`. Later, when an estimate drafts for that job,
`attachUpsells` → `generateUpsells(..., { jobId })` → `listJobPhotoNotes` →
notes go into the upsell prompt → suggestions reflect the field notes.

## Testing
- **db**: migration applies; `setDocumentNote` writes/reads under tenant scope
  and refuses cross-tenant / missing docs; `listJobPhotoNotes` returns only
  non-empty notes for the job.
- **agents**: `generateUpsells` with injected `aiClient` — asserts the prompt
  includes the photo notes when present, and is unchanged when there are none.
- **web/gallery**: no jsdom unit tests (repo convention); optional e2e — open the
  gallery, `ArrowRight` to the next photo, type a note, assert it persists
  (re-open shows it).
- Full `pnpm test` + `typecheck` + `lint` green before each PR.

## Slices
- **Slice 1** — DB (`notes` column + `setDocumentNote`) + gallery UI (arrow nav +
  autosaving notes). The visible win; ships first.
- **Slice 2** — AI wiring (`listJobPhotoNotes` + `generateUpsells` scope + prompt
  + thread `jobId`). The "feed estimate drafting" half.

## Out of scope
Changing core estimate line items from notes (measurement-driven, not AI);
notes on non-photo documents; lead-stage photo notes feeding the lead-draft
upsells (job-scope first — can extend the same seam to `leadId` later).

## Done when
A rep can arrow through a job's photos, write a note on any of them that
autosaves, and a subsequently drafted estimate's AI upsell suggestions reflect
those notes.
