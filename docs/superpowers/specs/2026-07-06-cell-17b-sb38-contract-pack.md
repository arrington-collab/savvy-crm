# Cell 17b — SB38 Contract Pack + Template-Version Invariant

**Date:** 2026-07-06
**Contract:** First-20-Cells, Cell 17 remainder (Wave D, SB38 templates #293). Completes Cell 17 with 17a (license matrix + scheduling block, #143).
**Migration:** 0055 (next after 0054; confirmed in `_journal.json`).
**Branch:** `cell-17b-contract-pack` (fresh off current `origin/main` — NOT the stranded `cell-17b-sb38-contracts` branch, which is based on pre-`f3e82fe` main and would regress the canvass rescission email + Alta prompts if merged).

## Why

Colorado SB38 requires roofing contracts to carry consumer-protection language: a right to rescind, **no waiver of the insurance deductible** (C.R.S. § 6-22-105), and a **10-day** insurer-decision window. Signing a CO homeowner onto a non-compliant contract is legal exposure. Per 17a's principle — **blocking beats reminding** — it must be impossible to send/store a CO contract that isn't on a compliant, versioned template.

## Scope (what THIS PR delivers)

Three parts. The first two mirror the (stranded) prior design; the third + fourth are **net-new** to satisfy this session's prompt, which the prior design explicitly deferred/never had:

1. **Contract-template compliance machinery** — versioned `contract_template` registry (migration 0055), a pure clause-compliance resolver in `@savvy/core`, and a fail-closed blocking gate on **both** CO contract paths (estimate e-sign + canvass field contract), each stamping the resolved template id.
2. **Rescission notice on ALL CO contract paths** — the estimate (retail) path carries the SB38 provisions structurally via the gated compliant template; the canvass signed-copy email's rescission notice is made **state-aware and CO-complete** (adds the no-deductible-waiver + 10-day provisions for CO). **AZ / non-CO door-to-door keeps its existing generic 72-hour right-to-cancel notice unchanged.**
3. **Template-version sweep invariant** (`compliance.contract_template`) — a nightly evidence check bound to registry task **44 "Contract / authorization signing"**: every stamped contract must sit on a template that is *currently* compliant, and every sent/accepted **CO estimate** must be stamped. Catches **drift** the send-time gate cannot (a template compliant at signing that is later retired or has a clause removed).
4. **Red-path test** — a contract stamped with a now-stale (retired / clause-missing) template makes the invariant fail.

## Schema (migration 0055)

`contract_template` (tenant-scoped RLS, unique `(tenant_id, state, version)`): `id, tenant_id, state, version, name, docuseal_template_id (nullable), clauses jsonb default [], status (active|draft|retired), effective_at, created_at, updated_at`.

Stamp columns (nullable FK → `contract_template.id`): `estimate.contract_template_id`, `document.contract_template_id`.

## Pure resolver — `packages/core/src/contract-compliance.ts`

DB-free. `REQUIRED_CLAUSES = { CO: ["right_to_rescind","no_deductible_waiver","ten_day"] }`. Helpers: `requiredClausesFor`, `isJurisdictionGated`, `isTemplateCompliant`, `resolveCompliantTemplate` (highest compliant version wins), `resolveOrThrowContractTemplate` (returns stamp id, `null` when ungated, throws `ContractTemplateRequiredError` when gated but no compliant template). Only gated states (CO) require a template; blank/null jurisdiction is the escape valve.

## The gate (data layer, inside `withTenant`)

- **Estimate:** `createEstimateSubmission` — resolve `job.propertyId → property.state`; gate before the DocuSeal call; stamp `estimate.contract_template_id`.
- **Canvass:** `storeCanvassContract` — resolve `lead.propertyId → property.state`; gate; stamp `document.contract_template_id`. `emailSignedCopy` **retained** (only the prior stranded branch deleted it); its notice becomes state-aware.

## The sweep invariant — `compliance.contract_template`

`invariant()` builder, non-windowed (scans current state). Violations (any row = fail):
- a sent/accepted **CO estimate** with a NULL `contract_template_id` (unstamped);
- an **estimate** stamped with a template not currently compliant (drift);
- a **contract document** stamped with a template not currently compliant (drift).

"Currently compliant" = `status='active'` AND (for a gated state) `clauses ⊇ REQUIRED_CLAUSES[state]`. The required-clause predicate is generated from `REQUIRED_CLAUSES` (single source of truth). Bound via `CHECK_BINDINGS[44] = "compliance.contract_template"`; the guarded bound-set test updates to include 44.

Documented limitation: an *unstamped* canvass contract document's jurisdiction is not recoverable in SQL (the document row carries no state/lead link), so drift detection there is stamp-keyed. New CO documents can't be unstamped — the send-time gate fails closed.

## Seed + e2e tenant

Seed one **active CO** `contract_template` v1 (the three SB38 clause keys, `docuseal_template_id: null`) for the demo tenant (`seed.ts`) and the isolated e2e tenant (`create-tenant.ts`), idempotently — else any CO contract flow throws.

## Out of scope
- Real CO SB38 legal wording / the actual DocuSeal template (owner/lawyer attaches later via `docuseal_template_id` + `clauses` attestation). No AI-authored legal text.

## House rules
Fresh worktree off origin/main, TDD, PR per cell, watch CI. Data-layer enforcement inside `withTenant`. No real tenant keys tracked. Migration 0055 confirmed from `_journal.json`.
