# Claude Code Prompt — Move the Roof Drawing from Jobs to Leads

Written 2026-07-07. One worktree → TDD → PR. Read `CLAUDE.md` and the non-negotiables before coding.

---

## Why

A job doesn't exist until there's an accepted estimate, and there's no estimate without a
measurement. So the roof drawing (DIY sketch) must be creatable and editable at the **lead**
stage — today it only lives under `/jobs/[id]/measure`. Reps hit a wall: they need to draw the
roof to produce the measurement that produces the estimate that *creates* the job.

## The key insight (do not add a migration)

The data model is **already correct**. `measurement` (packages/db/src/schema/ops.ts) is scoped to
`property_id NOT NULL` + `tenant_id` — it carries **no `job_id`**. Property is shared across the
lead → job lifecycle, so a measurement created at lead stage is the same row the job later reads.
The async plumbing is already lead-aware too:

- `autoOrderMeasurementOnInspection` fires on `appointment/booked` and already threads
  `leadId` + `propertyId` (jobId optional) → `roofr/order.requested`.
- `roofrOrderMeasurement` carries `propertyId` + `leadId` (jobId optional) → `measurement/ready`.
- The estimate draft gate (`draftLeadEstimateIfReady`) is already lead-based.
- The lead tile already renders a **read-only** Measurement card (`LeadArtifactsSections`), whose
  own comment says: "edits and the DIY sketch link land with the tile reorg."

**So this is a UI + one server-action change. No schema change. No migration.** If you think you
need a migration, stop — you almost certainly don't. (If you somehow do, read
`packages/db/drizzle/meta/_journal.json` from your *own* worktree first; main moves fast and the
next number is well past what any stale checkout shows.)

The only remaining job-coupling is that the sketch **route** and the **save action** resolve
`property_id` by looking up a `job`. Point them at the lead instead.

## Scope (exact files)

1. **Generalize the save action** — `apps/web/src/lib/measurement-actions.ts`
   `saveSketchMeasurementAction` currently takes `{ jobId }`, looks up `job` for `propertyId` +
   `leadId`, and revalidates `/jobs/...`. Change its input to a scope discriminator, e.g.
   `{ scope: { kind: "lead" | "job"; id: string }, sketch, measurementId? }`.
   - `kind: "lead"` → resolve `propertyId` from `lead.propertyId`, set `leadId = lead.id`,
     `jobId = undefined`; revalidate `/leads/${id}` and `/leads/${id}/measure`.
   - `kind: "job"` → existing behavior unchanged (resolve via `job`, revalidate `/jobs/...`).
   - Emit `measurement/ready` with `{ tenantId, measurementId, propertyId, leadId, jobId }` exactly
     as today (leadId set, jobId omitted for the lead path — the estimate gate keys off leadId).
   - If the lead has no `property_id` yet, return a typed error (`{ error: "no_property" }`); the UI
     must surface "add the property address first" rather than 500.

2. **Add the lead-scoped route** — `apps/web/src/app/(app)/leads/[id]/measure/page.tsx`
   Mirror `jobs/[id]/measure/page.tsx` but join `lead → property` (not `job → property`) to get
   `propertyId`, `address`, `lat`, `lng`, and load the most recent `provider = "diy"` measurement
   for that property. Render `<SketchEditor scope={{ kind: "lead", id }} … />`.
   Handle "lead not found" and "no property yet" states.

3. **Make `SketchEditor` scope-agnostic** — `apps/web/src/app/(app)/jobs/[id]/measure/SketchEditor.tsx`
   Replace the `jobId: string` prop with `scope: { kind: "lead" | "job"; id: string }`; pass it
   straight through to `saveSketchMeasurementAction`. Update the "back" `Link` and any
   `router.push` to go to `/leads/${id}` or `/jobs/${id}` based on scope. Keep the editor's drawing
   logic untouched. Update `jobs/[id]/measure/page.tsx` to pass `scope={{ kind: "job", id }}`.

4. **Add the entry point on the lead tile** — `apps/web/src/app/(app)/leads/[id]/LeadArtifacts.tsx`
   In the Measurement card, add a "Draw / edit roof" link to `/leads/${leadId}/measure` (shown as
   "Draw roof" when no measurement, "Edit sketch" when a DIY sketch exists). Disable it with a
   hint when the lead has no property. Keep the read-only summary fields.
   (`LeadArtifactsSections` currently takes only `artifacts`; thread the `leadId` +
   `hasProperty` it needs.)

5. **Optionally reuse the report route** — if reps need the printable measurement report at lead
   stage, add `leads/[id]/measure/report/page.tsx` mirroring the job one (same property lookup).
   Lower priority; gate on whether the read-only tile link is enough.

## Tests (red path first — TDD)

- `measurement-actions` unit/integration: saving a DIY sketch for a **lead with no job** creates a
  `measurement` row on the lead's property (`source: "sketch"`, `provider: "diy"`) and emits
  `measurement/ready` with `leadId` set and `jobId` undefined. Assert the estimate gate can then
  draft once the inspection is complete (mirror the existing slice-1 draft-once test).
- Lead measure page renders the editor for a lead with a property; renders the "add property first"
  state when `lead.propertyId` is null.
- Lead tile shows "Draw roof" (no measurement) / "Edit sketch" (DIY sketch present); disabled with
  hint when no property.
- Regression: the existing **job** path (`scope.kind === "job"`) still creates the measurement and
  revalidates the job paths — keep the current job test green.
- e2e (Playwright): from a lead tile with no job, open the measure route, save a sketch, and see the
  Measurement card populate — no job is created by drawing.

## Non-negotiables (from CLAUDE.md)

- Tenant isolation on every query (`withTenant`); the RLS cross-tenant test stays green.
- `measurement/ready` stays the durable Inngest seam — do not inline the estimate draft.
- Tests + `pnpm typecheck` + `pnpm lint` clean before commit. No secrets. Small, reviewed PR.
- Per-tenant timezone respected anywhere dates render (the sketch itself is geometry, low risk).

## Acceptance / evidence

- Red-path tests above pass; job regression stays green.
- A rep can produce a measurement for a lead that has **no** job, and that measurement drives the
  lead-stage estimate (which is what later creates the job — never the reverse).
- Proposed evidence binding: `measurement.lead_stage` — a DIY-sketch measurement may exist for a
  lead whose property has no job yet (proof the pre-job drawing path executed). Confirm the exact
  check key/semantics with the owner before wiring, consistent with the `estimate.lead_stage`
  binding from slice 1.

## Out of scope

- No `measurement` schema/migration change (it's already property-scoped).
- No change to Roofr auto-order or the estimate engine — both are already lead-aware.
- The broader slice-4 tile reorg (back-to-leads button, score tooltip, calibration) — separate slice.

## Before you branch

Main is moving fast (slices 6b/6c/6d merged 2026-07-07; migrations through 0067). Rebase your
worktree on the latest `origin/main` first, and confirm no other in-flight worktree is touching
`measurement-actions.ts` or the measure route.
