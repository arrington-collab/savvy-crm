# C — Document gates (Part 1) — Design

**Date:** 2026-06-27
**Slice:** Jobs build, slice C (Part 1 only). Part 2 (`automationLevel` honored at runtime) is a separate, larger slice — NOT in scope here.

## Problem

Today the pipeline has exactly one document-presence gate: the **photo gate**, which blocks a
job from entering `complete` until the per-job-type required photo *labels* exist as `document`
rows. There is no way to require other document *kinds* (e.g. a signed `contract` before
`production`, a `cert` before `closeout`).

## Goal

Generalize the proven photo-gate pattern into a **config-driven, per-stage document gate**:
require specified `document.kind` values to be present on a job before it may *enter* a given
stage. The canonical use is "a signed contract before production", but the machinery is generic
over `(stage → required kinds)`.

## Approach

Mirror the photo gate end-to-end (config → core helper → DB gate/error → web catch + toast →
workflow skip → tests). **No new table.** The only data dependency is the existing `document`
table (`kind` TEXT column, free-form values `photo|measurement|contract|lien_waiver|cert|...`).

### Config (`tenant.settings.production`, parsed by `parseProductionConfig`)

Add a sibling to `requiredPhotos`:

```ts
requiredDocs: Record<string /* JobStage */, string[] /* doc kinds */>  // default {}
```

- **Keyed by stage**, not job type — the gate is "to ENTER this stage, these kinds must exist".
- **Default `{}` (opt-in).** A default gate would break existing jobs/tests/e2e that advance
  without a contract doc. Ship the machinery + empty default; document
  `{ production: ["contract"] }` as the recommended tenant setting. No settings UI in this slice
  (config-driven, exactly like `requiredPhotos`).
- Values are normalized **case-insensitively + trimmed** (mirror the photo `labels` transform),
  because the gate matches against `document.kind` which is free-form text.

### Core helper (`packages/core/src/production.ts`)

```ts
export function missingRequiredDocs(required: string[], present: string[]): string[]
```

Case/trim-insensitive set-diff — identical contract to `missingRequiredPhotos`. (Kept as a
separate named export for clarity/symmetry, even though the body is the same shape.)

`production.ts` is already re-exported via `export * from "./production"` in
`packages/core/src/index.ts` — **no index edit needed.**

### DB gate (`packages/db/src/lifecycle/record-stage-change.ts`)

- New error `IncompleteDocumentsError extends Error` (`name = "IncompleteDocumentsError"`,
  `missing: string[]`), mirroring `IncompletePhotosError`. Exported from `packages/db/src/index.ts`.
- In `recordStageChange`, **for ANY `toStage`** (not just `complete`): after the existing photo
  block, load `requiredDocs[toStage]` from the parsed production config; if non-empty, select
  **distinct `document.kind`** for the job, compute `missingRequiredDocs`, and **throw before any
  stage/event/task/audit write** (so a blocked move persists nothing — same invariant as the
  photo gate).
- The photo gate stays exactly as-is (still only fires on `→complete`, keyed by job type). The two
  gates are independent and both run before the writes.

### Web (`apps/web`)

- `moveJobToStage` (`src/lib/job-actions.ts`): widen the return type to
  `{ ok: true } | { error: "missing_photos"; missing } | { error: "missing_docs"; missing }`;
  add a `catch (IncompleteDocumentsError)` branch returning `{ error: "missing_docs", missing }`.
- Board drag handler (`src/app/(app)/jobs/board.tsx`): the existing `"error" in result` branch must
  branch on `result.error` — `missing_photos` keeps the photos copy; `missing_docs` shows
  `Can't move — missing documents: <kinds>`. Both revert the optimistic move (unchanged).

### Agents (`packages/agents/src/functions/invoice-stage.ts`)

Add a parallel catch: `IncompleteDocumentsError` → `return { skipped: "doc_gate" }`, mirroring the
existing `IncompletePhotosError → { skipped: "photo_gate" }`. (The error is matched by
`e.name === "IncompleteDocumentsError"`, same style as the photo branch, to avoid an extra import.)

## Testing

- **Core unit** (`packages/core/src/production.test.ts`): `missingRequiredDocs` diff cases; `parseProductionConfig`
  defaults `requiredDocs` to `{}` and normalizes overrides.
- **DB integration** (`packages/db/tests/doc-gate.test.ts`, new — mirror `stage-gate.test.ts`):
  with a tenant configured `requiredDocs: { production: ["contract"] }` — (1) block `→production`
  when no contract doc, writing no stage event; (2) allow once a `kind:"contract"` document exists;
  (3) no-op for a stage with no configured docs.
- **e2e** (`apps/web/tests/e2e/doc-gating.spec.ts`, new — mirror `production-gating.spec.ts` test 1,
  DB-layer): set the e2e tenant's `production.requiredDocs = { production: ["contract"] }`, seed a
  job at `approved`, prove `recordStageChange(→production)` throws `IncompleteDocumentsError`, seed a
  `kind:"contract"` document, prove the move now succeeds. **Restore `tenant.settings` in
  `afterAll`** so the persisted `requiredDocs` does not leak into other e2e specs that move jobs
  through `production`.
- **Docs**: add §2b to `docs/jobs-pipeline.md` next to the photo gate.

## Assumptions / decisions

- **[ASSUMED]** Config home is `tenant.settings.production` alongside `requiredPhotos`.
- **[ASSUMED]** Default `{}` (opt-in) — no default gate, no migration, no e2e/test breakage.
- **[INFERRED]** "Present" = distinct `document.kind` values on the job (mirror photos' distinct
  `document.label`). Signed e-sign docs already land as `document` rows (`kind='lien_waiver'|'cert'`)
  via `finalizeEsign`, so an e-sign gate works with zero extra wiring.
- **[INFERRED]** Gate fires on the transition INTO the configured stage, for any stage, inside
  `recordStageChange`, before the stage write.

## What's missing / out of scope

- **No settings UI** — config is edited directly in `tenant.settings.production` (same as
  `requiredPhotos` today).
- **Part 2** (`automationLevel` honored at runtime) — separate slice, needs its own design.
- **No new `document.kind` enum** — `kind` stays free-form TEXT; the gate trusts the configured
  strings.
