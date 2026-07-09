# Lead Document Viewer + Parse Result Panel + Re-parse — Design

**Date:** 2026-07-07
**Branch/worktree:** `worktree-lead-doc-viewer`
**Builds on:** Slice 6 (#156–#159) — lead-scoped documents, parse pipeline, `lead.doc_parse` evidence.

## Goal

Make lead (and carried-onto-job) documents **viewable on click** and make what the
parser extracted **visible and trustworthy** next to the source file, so an owner can
eyeball the PDF against the extracted values in one place — and re-run a parse safely.

Three capabilities:

1. **Click-to-view** every document (PDF inline, images in a lightbox, other types
   download), with a header showing filename + uploader + date.
2. **Parse Result panel** beside each parsed `insurance_estimate` / `measurement_report`
   showing the extracted fields, confidence, and a link to the entity it populated;
   un-parsed / low-confidence docs show their status instead.
3. **Re-parse** action per doc — idempotent, and never clobbers human-confirmed data.

## Non-negotiables honored

- **Tenant isolation:** every read/route goes through `withTenant` (RLS). The view route
  loads the doc under the tenant context; cross-tenant ids resolve to 404.
- **No secrets / no public URLs:** the browser never receives an R2 URL or key. Views are
  served same-origin, gated by the Clerk session.
- **AI via gateway:** re-parse reuses the existing `completeObject` capability path — no
  new model wiring.
- **Durable workflow:** re-parse re-emits the existing `lead-document/received` Inngest
  event; the fail-soft handler owns retries + idempotency.
- **Tests + typecheck + lint** before commit.

## Decisions (locked with owner)

| Fork | Decision |
| --- | --- |
| View URL delivery | **Same-origin proxy route** — path carries only the doc UUID; server streams the R2 object inline. No PII/key in the browser URL; also hardens the currently-weak IDOR scoping. |
| Parse-panel data source | **Live-join** the `claim` (via lead) / `measurement` (via property) the parse populated + `document.parseConfidence`. No migration. Unambiguous because parseable docs are single-slot. |
| Scope | **Upgrade the job `DocsPanel` too** — the viewer + parse panel are shared components used by both `LeadDocsCard` and the job docs surface. |

## Architecture

### 1. View route (proxy stream) — NEW

`GET apps/web/src/app/api/documents/[documentId]/view/route.ts`

- Resolve tenant (`getTenantId`). `withTenant` → load `{ r2Key, mime, filename }` by id
  (RLS enforces tenant isolation).
- **404** when: doc not found, `r2Key` is null (CompanyCam `externalUrl` docs are not
  R2-backed), or storage is unconfigured.
- Stream: presign an R2 GET server-side (`r2Storage.presignDownload`, 300s, internal
  only), `fetch` it, and return `new Response(upstream.body, { headers })` — no full
  buffering.
- Headers: `Content-Type: mime`, `Content-Disposition: inline; filename="<safe>"`
  (`attachment` when `?download=1`), `Cache-Control: private, no-store`.
- SSRF-safe: the presigned key comes only from a DB-loaded doc, never a user-supplied
  URL. The `documentId` is the only user input and is used solely as a lookup key.

### 2. `DocViewer` lightbox — NEW `apps/web/src/components/DocViewer.tsx`

Client component, shared by `LeadDocsCard` and job `DocsPanel`.

- Controlled by an open document (`{ id, filename, uploaderName, createdAt, mime } | null`).
- Modal: `role="dialog"`, `aria-modal`, Escape + backdrop click close, focus moved to the
  dialog, theme-aware CSS vars (no hardcoded colors).
- **Header bar:** `filename · uploader · date · [Download] · [×]`.
- Body by mime:
  - `application/pdf` → `<iframe src="/api/documents/{id}/view">` (same-origin → clean embed).
  - `image/*` → `<img src="/api/documents/{id}/view">`.
  - else → centered **Download** button → `/api/documents/{id}/view?download=1`.

### 3. Parse Result panel — NEW db reader + presentational component

**db:** `getDocumentParseSummaries(tenantId, documentIds[]) → Record<id, ParseSummary>`
(packages/db). For each parseable doc, live-join by kind:

- `insurance_estimate` → newest `claim` where `leadId = doc.leadId`:
  `{ kind, status, confidence, claim: { id, carrierName, claimNumber, acvCents, rcvCents,
  deductibleCents, lineItemCount } | null }`.
- `measurement_report` → newest `measurement` for `doc.propertyId` with
  `source='uploaded_report'`: `{ kind, status, confidence, measurement: { id, squares,
  pitch, ridgeLf, hipLf, valleyLf, eaveLf, rakeLf, facets, penetrations } | null }`.

`status`/`confidence` always come from the `document` row (accurate to *this* doc).

**Waste note:** waste % is an *estimate* concept (field-shingle cutting only), **not** a
measurement-report field. The measurement panel shows squares / pitch / LF totals; it does
**not** invent a waste value. (Owner-confirmed.)

**Render (presentational, e.g. `DocParseSummary.tsx`), status-driven:**

- `parsed` → the extracted summary + confidence badge + a link ("View claim" — inline
  values are themselves the eyeball surface; "View measurement" → `/leads/[id]/measure`).
- `unparsed_low_confidence` → **"Stored, unparsed — card open"** + confidence, no summary.
- `parse_failed` → "Parse failed — re-run to retry."
- `pending` → "Parsing…".
- Non-parseable kinds → no panel (view only).

### 4. Re-parse action — NEW server action

`reparseDocument(documentId)` in `apps/web/src/lib/document-actions.ts`:

- `getCurrentUser()` → tenant. `withTenant` load doc; reject if not found (`not_found`)
  or kind not in `PARSEABLE_KINDS` (`not_parseable`).
- Set `parseStatus='pending'`, clear `parseConfidence` (instant "Parsing…" feedback).
- Re-emit `inngest.send("lead-document/received", { tenantId, documentId, leadId, kind })`.
- `revalidatePath` the lead (and job, when job-scoped).
- **Idempotency + confirmed-field guard:** re-run flows through the existing fail-soft
  handler. Insurance `attachOrCreateLeadClaim` is coalesce-only
  (`existing.carrierName ?? input.carrierName`) — confirmed money/carrier fields are never
  overwritten; `lineItems` + `parseConfidence` refresh.

**Measurement idempotency fix:** today `insertUploadedMeasurement` INSERTs a new row every
parse, so re-parsing a measurement litters rows. Change it to
**`upsertUploadedMeasurement`** — update the property's newest `uploaded_report`
measurement if one exists, else insert. Re-parse becomes truly idempotent and the
measurement id (thus the parse-panel link and the `measurement/ready` → estimate
auto-draft chain) stays stable. First-parse behavior is unchanged (insert). (Owner-confirmed.)

### 5. Evidence extension — `lead.doc_viewable`

Add an invariant to `packages/core/src/verification/checks.ts`:

```
lead.doc_viewable: no document with kind in ('insurance_estimate','measurement_report')
                   and parse_status = 'parsed' and r2_key is null
```

Every parsed doc must have a resolvable storage object (no orphaned parse with nothing to
view). Wire the new invariant into the CHECK_BINDINGS registry and update the
master-task-list bound-set test (adding a binding changes the bound set).

## Files

**New**
- `apps/web/src/app/api/documents/[documentId]/view/route.ts`
- `apps/web/src/components/DocViewer.tsx`
- `apps/web/src/components/DocParseSummary.tsx` (presentational)

**Edited**
- `apps/web/src/lib/document-actions.ts` — add `reparseDocument`.
- `apps/web/src/app/(app)/leads/[id]/LeadDocsCard.tsx` — view buttons, parse summary,
  re-parse button, mount `DocViewer`.
- `apps/web/src/app/(app)/leads/[id]/page.tsx` — fetch parse summaries; pass to card.
- `apps/web/src/app/(app)/jobs/[id]/DocsPanel.tsx` (+ job `page.tsx`) — adopt `DocViewer`
  + parse summary.
- `packages/db/src/lifecycle/lead-documents.ts` — `getDocumentParseSummaries`,
  `upsertUploadedMeasurement` (replace `insertUploadedMeasurement`); barrel export.
- `packages/agents/src/functions/parse-lead-document.ts` — call `upsertUploadedMeasurement`.
- `packages/core/src/verification/checks.ts` + CHECK_BINDINGS registry + bound-set test.

## Testing (TDD — red first)

**Unit / integration (vitest)**
- **db** `getDocumentParseSummaries`: insurance doc → claim summary w/ lineItemCount;
  measurement doc → measurement summary; low-confidence doc → status only, null entity.
- **db** `upsertUploadedMeasurement` idempotency: two calls for the same property update
  one row (id stable), don't create two.
- **db/agents** re-parse **cannot clobber confirmed claim fields** (red-path #3): existing
  claim with human `carrierName`/`acvCents`; re-parse with different values → confirmed
  fields unchanged, `lineItems`/`parseConfidence` refreshed.
- **route** view route rejects **cross-tenant / unknown doc → 404** (red-path #1, adapted:
  with the proxy there is no browser-facing presigned URL to expire; the real boundary is
  session + tenant scoping on the route). Storage presign expiry ≤300s stays covered by
  the existing `storage.test.ts`.
- **component/unit** parse panel renders the **low-confidence** state (red-path #2).
- **evidence** `lead.doc_viewable`: a parsed doc with null `r2_key` is flagged; a normal
  parsed doc is not.

**E2E (Playwright)** — extend `apps/web/tests/e2e/lead-documents.spec.ts`: upload a
parseable doc, open the viewer, assert the header (filename/uploader/date), trigger
re-parse.

## Live prod verification (stated in the PR)

Sign in as a **Bloom** user, open the test insurance estimate, view the PDF in the
lightbox, confirm extracted values render beside it, click re-parse — report the outcome
in the PR body.

## Out of scope

- A lead activity/timeline component (none exists today; documents render only in
  `LeadDocsCard`). Click-to-view lands where documents are actually listed.
- Retroactively rewriting existing R2 keys to strip filenames (the proxy route already
  keeps keys/PII out of the browser URL).
- Per-doc parse snapshot column (chose live-join).
