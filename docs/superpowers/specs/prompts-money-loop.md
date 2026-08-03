# Claude Code Prompt: The Money Loop (First-20-Cells Wave C + D remainder)

Paste everything below this line into a fresh Claude Code session at `~/Sites/savvy-crm`. Covers contract cells **7, 9, 10, 11, 12, 13, 14, 19, 20** from `docs/superpowers/specs/first-20-cells.md`. Requires the task-registry build (cells 1–5) on `main`. Cell 6 (10DLC) and cells 15–18 run from Prompt 2 of the strike-list prompt file per its alignment banner.

---

Build the money loop: lead → measurement → estimate → financing → optimal material order → invoice-verified job cost → customer visibility — with no manual links in the chain. House rules apply: background by default, checker ≠ doer, evidence-bound, exceptions batched, no CRUD frontends. **A cell is done when its evidence check runs green in production.**

## Before you write any code

1. Read `docs/superpowers/specs/first-20-cells.md` (the contract — one cell in progress at a time, in order), `docs/superpowers/specs/task-registry.md`, and `docs/superpowers/specs/expansion-phases.md` Phase 23 (supplier economics, tasks #335–#340).
2. Check `packages/db/drizzle/meta/_journal.json` for the true next migration number. Worktree per cell, TDD, PR per cell, watch CI, prod migrations from the owning worktree.
3. Reuse: secret-box + `integration_connection` for vendor creds; seams with dormant defaults; per-tenant crons on `tenant.timezone`; the AI-call plumbing + spend meter for any model use.

## Cell 7 — Comms hygiene (finish what #79 started)

Short links (`/b/` tokens) in **sent SMS bodies**, not just display; all customer-facing datetimes rendered in `tenant.timezone` as "Tomorrow, 2:00 PM" style; root-cause and fix the duplicate-reminder send (idempotency key on template+recipient+event). Done when the `comms.body_quality` and `comms.no_double_send` invariants (already seeded) run green 14 days.

## Cell 9 — Roofr measurement auto-order + ingest

`MeasurementProvider` seam, Roofr adapter first (their API: order report by address, webhook/poll for completion). Auto-order on inspection booking; ingest squares, pitch, waste factor, facets, linear features onto `property.measurement` (jsonb + key columns). Fail-soft: order failure ⇒ exception card, never a blocked booking. Idempotent (one order per property per 12mo unless roof changed). Evidence: invariant — every booked inspection has measurement data before appointment time, or a logged exclusion.

## Cell 10 — Estimate auto-draft

Pure function: measurement × price book (+ tenant margin floors, good/better/best tiers) → draft estimate line items. Triggered on inspection completion (roof type now confirmed). Over `approval_limit` ⇒ existing approval card; under ⇒ auto-send per tenant config. Store the pricing inputs snapshot (price book version, measurement ref) on the estimate — auditability is the point. Evidence: every completed inspection produces a draft < 1h; invariant that estimate math == price book version cited.

## Cell 11 — Financing seam

`FinancingProvider` interface, dormant default; first adapter per owner's vendor choice (GreenSky-class; confirm with owner via a card/note before wiring creds). Every retail estimate ≥ configurable floor carries an apply link; webhook ingests application status onto the job; approved financing surfaces in the pipeline card. No credit data stored — status enums only. Evidence: invariant — 100% of qualifying retail estimates carry the option; application statuses reconcile with vendor.

## Cell 12 — Supplier cost sheets + landed-cost selector (#335, #337)

Cost sheets as versioned Library documents per supplier (unit prices by SKU/category, delivery fees, fuel surcharges, minimums). Selector: given the estimate's material list (from cell 10 takeoff), compute **landed cost per supplier** and attach the comparison artifact to the PO draft; auto-pick the winner when savings exceed a confidence margin, card otherwise. Track predicted vs actual (fed by cell 13). Evidence: every material order carries the comparison; `supplier.sheet_freshness` invariant (< 90d).

## Cell 13 — Supplier invoice ingestion + price-guard (#336)

Inbound invoice capture (email forwarding address per tenant → AI parse to line items; PDF attachments handled). Match to PO/job. **Every line checked against the supplier's cost sheet; overage ⇒ auto-generated credit-request email with line-level evidence (invoice line vs agreed price), tracked to resolution; recovered credits logged as money events and reported in the digest.** Parse confidence below threshold ⇒ human card, never silent acceptance. Evidence: invariant — 100% of ingested lines price-checked; no overage without an open or resolved credit request.

## Cell 14 — Job costing actuals → true GM

Material actuals (cell 13) + labor/sub costs (sub invoices via the same ingestion path; simple manual entry card as fallback) roll into per-job cost. GM per job = collected revenue − actuals. Estimate-vs-actual variance report; feeds the existing commissions math (collected GM) and the Money view. Evidence: reconciliation — job cost totals == sum of matched invoice lines + labor entries; GM MTD on dashboard now sourced from actuals (delete the fictional number).

## Cell 19 — Customer status page

Tokenized per-job route (reuse the `/b/` short-link infrastructure): schedule + crew ETA, job stage, curated photos (CompanyCam, flagged customer-safe only), payment status + pay link, documents (contract, COC, warranty), contact button that routes to comms (not a rep's cell). Read-only; no login. Link included in booking confirmation and reminder templates. Evidence: invariant — every active job has a live status page; link present in outbound templates; page uptime check.

## Cell 20 — Northwind provisioning runbook (scripted, then executed)

A single idempotent script + checklist doc: create tenant (timezone `America/Denver`), telephony numbers + 10DLC, templates cloned from a golden set, price book import, license matrix entries, registry seed + tenant_task_config, digest times, break-glass rules, integration placeholders (dormant seams listed with what activating each requires). Dry-run mode that reports what it would create. Then EXECUTE it for Northwind with the owner, logging wall-clock provisioning time as the baseline-to-beat. Evidence: Northwind live as tenant #2 via the script; a `provisioning.complete` checklist artifact with timings.

## Guardrails

- Cells in order, one at a time. If a cell is blocked, surface why and stop — do not skip ahead to wave-2 work under any circumstances (see the alignment banner in the strike-list prompt file).
- Vendor seams dormant by default; no vendor creds in code; owner confirms financing vendor before that adapter is wired.
- Money math is invariant-proven nightly; anything parsed by AI (invoices) has a confidence gate with human-card fallback.
- Every PR: which cells/task IDs, and what proves it ran correctly?

Start with cell 7. Restate the plan, confirm the migration number, and list files you'll touch.
