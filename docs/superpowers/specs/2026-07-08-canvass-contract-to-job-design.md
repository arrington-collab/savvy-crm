# Canvass Signed Contract → Lead → Contract Doc → JOB — Design

**Date:** 2026-07-08
**Worktree/branch:** `worktree-canvass-contract-to-job` (off `origin/main`; won-fix `3b7ced2` present; journal at 0067)

## Goal

A signed door-to-door (canvass) contract is the authorization for work. Make the existing
canvass path go **end-to-end**: signed contract → lead → contract document **lead-scoped +
viewable + carried onto** → **JOB** (idempotently), with a **rescission hold** on
production until the statutory cancel window passes, fail-soft so a signed contract never
silently fails to become a job.

## Context (verified)

- **Intake** `apps/web/src/app/api/canvass/contract/route.ts` already creates
  customer+property+lead (`createLeadForTenant`) and emits `canvass/contract.signed` with
  `{ tenantId, leadId, contract, customerEmail, customerName }`. `contract.rep` (a name
  string) is in the payload. No change needed here.
- **Workflow** `packages/agents/src/functions/canvass-contract.ts` stores the signed
  contract JSON in R2 + a `document` row (kind `"contract"`), idempotent on the r2Key
  derived from `contract.integrityHash`. **Gaps:** the document row sets `customerId` but
  **not `leadId`**, and the workflow **never converts the lead to a job**.
- **`convertLeadToJob({ manualJob: true })`** (`packages/db/src/lifecycle/appointments.ts`)
  is idempotent (keys off `job.lead_id`), carries lead-scoped documents (by `leadId`,
  non-archived), the lead claim, and the accepted estimate onto the job, carries
  `lead.assignedUserId` as owner, and **sets `lead.status='won'`** (the landed Josh-bug
  fix). `manualJob` bypasses the accepted-estimate requirement — a door sale has no estimate.
- **License gate** is only in `bookAppointment` (scheduling), never in conversion.
- **Rescission window / job hold**: greenfield. Only static email text exists today.
  `canvass_rep` is a per-tenant identity, **not a Clerk user** (no `userId`).
- **Appointment types**: `["inspection","cm","crew","adjuster"]` — **`crew`** is the
  install/production appointment.
- **Evidence**: `evidenceChecks` in `packages/core/src/verification/checks.ts`;
  `CHECK_BINDINGS` (taskId→checkKey) in `packages/db/seeds/master-task-list.ts`; bound-set
  asserted in `packages/db/tests/master-task-list.test.ts`. Break-glass keys in
  `packages/core/src/verification/break-glass-keys.ts`.

## Decisions (locked with owner)

| Fork | Decision |
| --- | --- |
| Rescission config | **State-default map + tenant override.** Days = `tenant.settings.rescissionDays[state]` ?? statutory default `{ CO: 10, AZ: 3, default: 3 }`. Release = **00:00 in the tenant timezone** on `(signing civil date + N calendar days)`. |
| Cancel scope | **Hold + auto-release only.** Customer-cancel / chargeback reversal is out of scope (separate flow). |
| Claim-from-canvass | **Defer.** `convertLeadToJob` carries a lead claim if one exists; canvass does not create one this slice. |
| Rep attribution | **Denormalized rep name on the job** (`job.canvass_rep_name`), from `contract.rep`. No FK, no `repId` threading. |
| Convert-failure handling | **Let-throw + Inngest retry.** `store-document` commits first (doc persists); a persistent convert failure surfaces as the `canvass.contract_to_job` evidence violation → break-glass. |

## Non-negotiables honored

- **Tenant isolation** — all reads/writes through `withTenant` (RLS).
- **Durable workflow** — conversion + metadata are Inngest steps; store commits before
  convert so the doc always persists (fail-soft).
- **Integrate commodities** — reuse `convertLeadToJob`, the 17b template gate, the license
  gate, tenant-timezone helpers; no rebuilds.
- **Tests + typecheck + lint** before commit; migration only after checking the journal.

## Architecture

### 1. Lead-scope the contract document — `storeCanvassContract`

Add `leadId: input.leadId` and `propertyId: l.propertyId` to the `document` insert (keep
`customerId`). kind stays `"contract"`. Effect: the contract renders in `LeadDocsCard`, is
click-viewable via the viewer (PR #167), and **carries onto the job** at conversion
(`stampCerts` updates docs where `leadId = lead.id AND archivedAt IS NULL`).

### 2. Auto-convert — workflow `canvassContractSigned`

After the existing `store-document` step:

- **`convert-to-job`** step: `convertLeadToJob({ tenantId, leadId, manualJob: true })`.
  Runs on every invocation (idempotent; self-heals a crash between store and convert).
  Sets `lead.status='won'` and carries docs/claim/estimate/owner. Returns `{ jobId }`.
- **`apply-canvass-job-metadata`** step: compute `releaseAt` from `contract.signedAt` +
  the tenant/jurisdiction rescission days, in the tenant timezone; `update job set
  rescission_hold_until = releaseAt, canvass_rep_name = contract.rep where id = jobId`.
  Idempotent (plain set). Resolves the job's `state` from its property for the day map.

`email-homeowner-copy` is unchanged (first-store only).

### 3. Ordering + fail-soft

- `store-document` (committed) → `convert-to-job` (retries) → `apply-canvass-job-metadata`.
- The 17b template gate stays inside `storeCanvassContract` (fail-closed before storage).
- Conversion is **not** license-gated. If convert throws, Inngest retries; a persistent
  failure leaves the doc stored and the `canvass.contract_to_job` invariant flags it →
  break-glass. No imperative exception-raising (state-derived, "#82 pattern").

### 4. Rescission hold — migration `0068`

- **Migration** (`packages/db/src/schema/jobs.ts` → `pnpm db:generate` → `0068_*`): add to
  `job`: `rescission_hold_until timestamptz` (nullable), `canvass_rep_name text` (nullable).
- **Pure core** `packages/core/src/rescission.ts`:
  - `RESCISSION_DAYS_DEFAULT = { CO: 10, AZ: 3 }`, `RESCISSION_DAYS_FALLBACK = 3`.
  - `rescissionDaysFor(state, config?)` → number.
  - `rescissionReleaseAt({ state, signedAt, timezone, config? })` → `Date` — start of day
    (00:00) in `timezone` on the civil date `N` calendar days after the signing civil date.
    Uses the existing tz helpers (`packages/core/src/tz.ts` / `datetime.ts`).
  - `isRescissionHeld(holdUntil: Date | null, now: Date)` → boolean (`holdUntil != null &&
    now < holdUntil`).
- **Enforcement — 2 gates** (share `isRescissionHeld`):
  1. **Production scheduling** — `bookAppointment` (`appointments.ts`): when booking a
     `type === "crew"` appointment for a job whose `rescission_hold_until` is in the future,
     throw `RescissionHoldError(releaseAt)` (new error class, mirrors `LicenseRequiredError`).
     `inspection`/`cm`/`adjuster` are unaffected.
  2. **Material ordering** — the material-order entry point
     (`packages/db/src/lifecycle/material-order.ts`): a held job **defers** (no order
     placed) and returns a `{ held: true, releaseAt }` marker.
- **Auto-release**: both gates read the predicate against `now`; once `now ≥ holdUntil`
  they pass. No cron.
- **Surface**: a hold banner on the job page — "Production held until \<date\> —
  rescission window" (reads `job.rescission_hold_until`, shown only while in the future).

### 5. Evidence — `canvass.contract_to_job`

Add to `checks.ts`:

```
canvass.contract_to_job: a canvass contract document older than 15 minutes whose lead is
                         not won or has no job.
select d.id
  from document d
  join lead l on l.id = d.lead_id and l.tenant_id = d.tenant_id
 where d.tenant_id = $1
   and d.kind = 'contract'
   and d.r2_key like '%/canvass/contract-%'
   and d.created_at < now() - interval '15 minutes'
   and (l.status <> 'won'
        or not exists (select 1 from job j where j.lead_id = l.id and j.tenant_id = l.tenant_id))
```

`toRef` → `{ type: "document", ref: id }`. Bind to the canvass task in `CHECK_BINDINGS`
(taskId resolved from `master-task-list.raw.json` during planning), update the bound-set
array in `master-task-list.test.ts`, add a per-id assertion, and add the key to
`break-glass-keys.ts` so a stored-but-unconverted contract pages the owner.

## Files

- `packages/agents/src/functions/canvass-contract.ts` — lead-scope the doc; add
  `convert-to-job` + `apply-canvass-job-metadata` steps.
- `packages/db/src/schema/jobs.ts` — two new columns; generate migration `0068`.
- `packages/db/src/lifecycle/appointments.ts` — `RescissionHoldError` + `crew`-booking gate.
- `packages/db/src/lifecycle/material-order.ts` — defer-if-held.
- `packages/core/src/rescission.ts` (new) + barrel export.
- `packages/core/src/verification/checks.ts` — `canvass.contract_to_job` invariant.
- `packages/core/src/verification/break-glass-keys.ts` — add the key.
- `packages/db/seeds/master-task-list.ts` — `CHECK_BINDINGS` entry.
- `packages/db/tests/master-task-list.test.ts` — bound-set + per-id assertion.
- Job page (`apps/web/src/app/(app)/jobs/[id]/…`) — rescission hold banner.

## Testing (TDD, red-first)

**Unit (core)**
- `rescissionReleaseAt`: AZ (3d) and CO (10d) from a signedAt, correct 00:00-in-tz release;
  tenant override wins; unknown state → fallback 3.
- `isRescissionHeld`: null → false; now<hold → true; now≥hold → false (auto-release).

**Integration (db)**
- `storeCanvassContract` sets `leadId` (+ propertyId) on the contract doc.
- **Red #1 — replay ⇒ one job**: run store+convert twice → exactly one job; lead `won`.
- **Red #3 — material order blocked while held**: a job with a future
  `rescission_hold_until` → material order defers (`held:true`, no order row); once
  `rescission_hold_until` is in the past → order proceeds. And `bookAppointment('crew')`
  on a held job throws `RescissionHoldError`; a non-crew type does not.
- Contract doc carries onto the job (`jobId` stamped) via `convertLeadToJob` — because it
  now has `leadId`.

**Evidence (db, real DB green+red)**
- **Red #2 — conversion failure ⇒ exception**: a canvass contract doc (leadId set, >15m
  old) with no won job → `canvass.contract_to_job` **fails**; a converted+won one passes.
- `master-task-list.test.ts` bound-set includes the new taskId; binding resolves.

**Workflow (agents)**
- Handler: store → convert (manualJob) → metadata; convert runs even when store returns
  `already_stored`; metadata sets `rescission_hold_until` + `canvass_rep_name`.

## Live verification (stated in the PR)

Sign a **TEST** contract via the canvass field app against a **test lead** (never a real
customer number). Confirm: lead → `won`; a job exists with the contract document viewable
on it; the job card shows the rescission hold with its release date. Report the outcome in
the PR.

## Out of scope

- Customer-cancel / chargeback reversal (separate flow).
- Creating a claim from freeform contract fields (carryover still works if a claim exists).
- Migrating `canvass_rep` to a Clerk user / a `canvass_rep_id` FK (denormalized name only).
