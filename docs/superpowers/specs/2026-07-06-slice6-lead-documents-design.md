# Slice 6 — Lead Documents (upload + parse) — Design

**Date:** 2026-07-06
**Branch base:** stacked on `leads-stage-overhaul` (PR #155, Slice 1 — open at design time)
**Status:** Approved design, ready for implementation planning

## Problem

Leads need document uploads on the lead tile: insurance estimates, Roofr/measurement
reports, and general docs. The point is not storage — **uploads feed the machine**. A
parsed insurance estimate becomes the claim money ledger and the input to scope-vs-
inspection comparison and supplement drafting; a parsed measurement satisfies Slice 1's
measurement step and feeds the estimate auto-draft (and saves the Roofr order fee).

Slice 1 (PR #155) already rescoped `estimate` and `appointment` from job-scoped to
lead/property-scoped, and made a job be born from an *accepted estimate* rather than at
inspection booking. Slice 6 continues that arc: documents and claims become lead-stage
artifacts that carry onto the job at conversion.

## Ground truth (verified against the codebase)

These facts shaped the design; the spec's original vocabulary was aspirational.

- **"SCOUT" is an AI persona label, not a parser.** The real parse pattern (supplier
  invoices #133–135) is: an Inngest event triggers a handler that calls `completeObject`
  (capability `reasoning` → Claude Sonnet) on the raw PDF bytes, extracting into a Zod
  schema with a 0–1 `confidence`, wrapped in try/catch so it is **fail-soft and never
  throws**. Files: `packages/agents/src/functions/supplier-invoice-parse.ts`,
  `packages/ai/src/client.ts` (`completeObject`/`completeObjectWith`),
  `packages/ai/src/capabilities.ts`.
- **Documents** live in one unified `document` table (`packages/db/src/schema/ops.ts`),
  **job-scoped** (`job_id` nullable) with a free-text `kind` discriminator. There is **no
  `uploaded_by_user_id`, no size/mime cap, and no supersede pattern** (only an `archivedAt`
  soft-archive column). Upload plumbing is presigned-PUT to R2 via
  `apps/web/src/lib/document-actions.ts` (`presignDocumentUpload` → client PUT →
  `recordDocument`). Existing upload UI is a plain file input on the job detail
  (`.../jobs/[id]/DocsPanel.tsx`). Media policy #341 is spec-only, not implemented.
- **Measurement** (`packages/db/src/schema/ops.ts`) has only a `provider` text column
  (`roofr|diy`) — **no `source`/`uploaded_report`**. Auto-order suppression already keys
  off `!hasMeasurement` (property-scoped) in
  `packages/agents/src/functions/auto-order-measurement.ts`. Slice 1's estimate auto-draft
  (`draftLeadEstimateIfReady`, `packages/db/src/lifecycle/estimate.ts`) consumes the
  *newest* measurement on the lead's property.
- **Claim** (`packages/db/src/schema/insurance.ts`) is **1:1 with a job** (`job_id` UNIQUE,
  required) and holds only ACV/RCV/deductible totals — **no line-item table**. This is the
  core tension: the spec parses insurance estimates at *lead* stage, where no job exists.
- **Lead timeline**: there is **no lead-timeline table and no `recordLeadEvent` helper**;
  `communication` has no `lead_id`, and the lead page fakes a timeline by joining comms on
  `customer_id`. Generic `audit_log` (`packages/db/src/schema/agents.ts`) exists.
- **Evidence system**: add an `invariant(name, sql, opts)` to `evidenceChecks`
  (`packages/core/src/verification/checks.ts`) and bind `taskId → check_key` in
  `CHECK_BINDINGS` (`packages/db/seeds/master-task-list.ts`). `lead.doc_parse` and
  `estimate.lead_stage` do **not** exist yet — we create them, modeled on `lead.score`.

## Decisions (locked)

| # | Decision | Choice |
|---|----------|--------|
| 1 | Branch base | Stack Slice 6 on `leads-stage-overhaul` |
| 2 | Scope | One spec, phased build 6a→6b→6c→6d, each its own PR |
| 3 | Claim at lead stage | Rescope `claim` to lead (mirror Slice 1: add `lead_id`/`property_id`, `job_id` nullable) |
| 4 | Doc type | Extend the existing free-text `kind` (add `insurance_estimate`, `measurement_report`) — no parallel `doc_type` column |
| 5 | Uploader + timeline | Add `uploaded_by_user_id` to `document`; write an `audit_log` row; surface uploader+timestamp in the lead Documents card |
| 6 | Measurement source | New `source` column (`ordered|uploaded_report|sketch`), orthogonal to `provider`; precedence-ranked selector |
| 7 | Insurance line items | jsonb `line_items` on `claim` (mirrors `estimate.lineItems`, `supplier_invoice.lines`) |
| 8 | Supersede | Reuse `archivedAt` to mark prior same-kind doc superseded; no hard delete exposed |

## Architecture & data flow

```
Lead tile → upload (presigned PUT → R2) → recordDocument (kind, lead_id, uploader)
   │                                            │
   │                                    emit lead-document/received
   │                                            ▼
   │                             parseLeadDocument (Inngest, Claude-Sonnet, fail-soft)
   │                        ┌───────────────────┴───────────────────┐
   │              kind=measurement_report              kind=insurance_estimate
   │                        ▼                                        ▼
   │        measurement row (source=uploaded_report)     claim (lead-scoped) + line_items
   │        → suppresses Roofr auto-order                → attach to lead's claim or create shell
   │        → emit measurement/ready (Slice 1 draft)     → input to scope-vs-inspection (later)
   │                        │
   └── at convertLeadToJob: carryover stamps job_id onto all lead docs + claim
```

The parser reuses the invoice pattern exactly: `completeObject` with capability
`reasoning` on the raw PDF file part, Zod schema with `confidence`, try/catch fail-soft.
Below the confidence floor (`finance.highConfidence`, default 0.8) the upload is **carded,
not silently written** — `parse_status='unparsed_low_confidence'` plus a Today exception
card, with nothing written to `claim`/`measurement`.

## Phase 6a — Storage, upload UI, timeline

**Migration 0063:**
- `document` gains: `lead_id` (FK → lead, nullable), `property_id` (FK → property,
  nullable), `uploaded_by_user_id` (FK → user, nullable), `parse_status` text default
  `'pending'` (`pending|parsed|parse_failed|unparsed_low_confidence`), `parse_confidence`
  real (nullable). New index `document_tenant_lead_idx` on `(tenant_id, lead_id)`.
- `kind` extended (free text — no enum migration) with `insurance_estimate`,
  `measurement_report`.

**Upload plumbing:**
- Extend `presignDocumentUpload`/`recordDocument` (`apps/web/src/lib/document-actions.ts`)
  to accept `leadId` (and derive `propertyId` from the lead) in addition to the existing
  `jobId` path. Forged-key defense: key prefix becomes `${tenantId}/lead/${leadId}/…` for
  lead uploads; `recordDocument` re-validates the prefix.
- Set `uploaded_by_user_id` from the authenticated session on record.

**Media policy (implements #341):**
- 25 MB/doc cap + mime allow-list `[application/pdf, image/jpeg, image/png, image/webp,
  image/heic]`, **enforced server-side in `recordDocument`** (reject oversize/disallowed),
  with a client `accept` hint. Typed `insurance_estimate`/`measurement_report` uploads
  accept **PDF only** in the UI; the parser runs only on `application/pdf`.

**Lead tile UI:**
- New `LeadDocsCard` component in `apps/web/src/app/(app)/leads/[id]/`, rendered alongside
  the Slice 1 `LeadArtifactsSections`. Drag/drop + file picker, doc-type selector
  (`insurance_estimate | measurement_report | photo | contract | other`). Lists each doc
  with uploader + timestamp + parse-status chip; "View" presigns a GET. Superseded docs
  (archivedAt set) render with a muted "replaced" state.

**Timeline + supersede:**
- Each upload writes an `audit_log` row (`entityType='lead'`, `entityId=leadId`,
  `action='document.uploaded'`, `diff` = { kind, filename }).
- Supersede: uploading a newer same-`kind` typed doc stamps the prior doc's existing
  `archivedAt`. No delete action is exposed on the lead UI ("no delete of others'
  uploads").

**Carryover:**
- `convertLeadToJob` (`packages/db/src/lifecycle/appointments.ts`) stamps `job_id` onto all
  the lead's `document` rows (and the lead-scoped `claim`, once 6c lands) inside the same
  transaction as job creation.

## Phase 6b — Measurement-report parse

**Migration 0064:**
- `measurement` gains `source` (`ordered|uploaded_report|sketch`). Backfill:
  `provider='roofr' → 'ordered'`, `provider='diy' → 'sketch'`. `provider` stays (it is the
  tool: roofr/diy/eagleview-later).

**Parse (`packages/agents/src/functions/`):**
- New `parseLeadDocument` Inngest function on event `lead-document/received`, per-tenant
  concurrency limit, retries 2, fail-soft. Switches on `document.kind`.
- `measurement_report` branch: parse squares/pitch/waste/facets into a `measurement` row
  with `source='uploaded_report'`, `provider` inferred (default `roofr`), `reportUrl` =
  the uploaded doc. On success set `document.parse_status='parsed'` and emit
  `measurement/ready` (feeds Slice 1's estimate auto-draft identically).

**Auto-order suppression:**
- An uploaded measurement makes `hasMeasurement` true, so `shouldAutoOrderMeasurement`
  already short-circuits — no new gate needed.
- **Accepted caveat:** suppression only applies if the upload lands *before*
  `appointment/booked` fires. A report uploaded after booking cannot un-order an
  already-placed Roofr order. Documented, not solved in this slice.

**Precedence selector:**
- New `selectPreferredMeasurement(measurements)` helper: rank `ordered(3) >
  uploaded_report(2) > sketch(1)`, then `createdAt` desc within a source. Replace Slice 1's
  "newest measurement on property" in `draftLeadEstimateIfReady` and in the `LeadArtifacts`
  Measurement tile display. The tile's "Source" label gains an "Uploaded report" branch.

## Phase 6c — Insurance-estimate parse + claim rescope

**Migration 0065:**
- `claim` rescoped to lead: add `lead_id` (FK, nullable), `property_id` (FK, nullable),
  make `job_id` nullable, change the `job_id` UNIQUE constraint to a **partial unique**
  (unique only when `job_id IS NOT NULL`), add `line_items` jsonb, add `parse_confidence`
  real. Backfill `lead_id`/`property_id` from the existing job for current claims.

**Parse:**
- `insurance_estimate` branch of `parseLeadDocument`: parse carrier, claim number,
  ACV/RCV/deductible (integer cents), and line items into `claim.line_items`. **Attach** to
  the lead's existing claim if one exists; else **create a lead-scoped claim shell**
  (`lead_id`/`property_id` set, `job_id` null). On success set `parse_status='parsed'`.
- Parsed values **never overwrite inspection-confirmed data** — standard precedence guard;
  a confirmed field on the claim wins over a parsed one.

**Carryover** (extends 6a): the lead-scoped claim gets `job_id` stamped at
`convertLeadToJob`.

## Phase 6d — Evidence

**`packages/core/src/verification/checks.ts` + `CHECK_BINDINGS`:**
- **`lead.doc_parse`** — `invariant`: violation rows = documents where `kind IN
  ('insurance_estimate','measurement_report')` AND `created_at < now() - interval '1 hour'`
  AND `parse_status = 'pending'`. (`parse_failed` and `unparsed_low_confidence` are valid
  *carded* terminal states → pass; only stuck-in-`pending` fails.) Binding: during 6d,
  inspect `packages/db/seeds/master-task-list.ts` and bind to the doc-parse/measurement-SLA
  task id (the "measurement auto-order" cell 9 / "estimate drafted < 1h" cell 10 lineage);
  if no suitable task exists, add one to the master list rather than binding to an
  ill-fitting id. Set `sla_hours = 1` on that registry row.
- **`estimate.lead_stage`** — stamp `measurement_source` onto the estimate at draft time
  (in `insertEstimateFromMeasurementTx`, from the selected measurement's `source`).
  `invariant`: lead-scoped estimates (`lead_id` set) with `measurement_id` set but no
  `measurement_source` recorded = violation, so estimates cite their pricing-inputs
  measurement source (ordered/uploaded/sketch).

## Testing (red-path, per spec)

1. **Low-confidence parse ⇒ card, not silent garbage** — confidence < 0.8 sets
   `parse_status='unparsed_low_confidence'` + a Today exception card; **no** claim/
   measurement row is written from the low-confidence extract.
2. **Uploaded measurement suppresses auto-order** — with an `uploaded_report` measurement
   on the property, `shouldAutoOrderMeasurement` returns false (no `roofr/order.requested`).
3. **Insurance parse attaches to the right claim** — existing lead claim → attach (no
   duplicate); no claim → lead-scoped shell created with `job_id` null.
4. **Carryover** — `convertLeadToJob` stamps `job_id` onto the lead's documents and claim.
5. **Precedence** — `selectPreferredMeasurement` returns `ordered` over `uploaded_report`
   over `sketch`, newest within a source.

## Out of scope (YAGNI / later slices)

- A unified lead-timeline surface (we reuse `audit_log` + the doc card; a real
  `lead_event` table is deferred).
- Scope-vs-inspection comparison and supplement drafting (6c only produces the *input*).
- HEIC preview/transcoding (HEIC is stored; only PDFs are parsed).
- EagleView and other measurement providers (the `source`/`provider` split leaves room).
- Un-ordering an already-placed Roofr order when a report is uploaded post-booking.

## Migration numbering

Stacked on `leads-stage-overhaul` (which ends at 0062): 6a = **0063**, 6b = **0064**,
6c = **0065**. 6d adds no migration (seed re-run for `CHECK_BINDINGS`).
