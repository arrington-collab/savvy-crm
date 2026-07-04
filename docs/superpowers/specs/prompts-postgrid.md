# Claude Code Prompt: Direct-Mail Machine (PostGrid) → Savvy Orchestrator

Paste everything below this line into a fresh Claude Code session at `~/Sites/savvy-crm`.

---

Build the direct-mail machine for Savvy: a PostGrid-backed print/mail capability wired into the agent + task-registry architecture. This is a background op — it runs on triggers and crons, proves its own execution, and surfaces only spend approvals and failures to a human. No CRUD frontend beyond a read-only mail log and a spend-approval exception card.

## Before you write any code

1. Read `docs/superpowers/specs/task-registry.md` (task_registry / job_task / task_health / evidence-check framework) and `docs/superpowers/specs/phase0-demand-generation.md` (tasks #213–#248). This build implements the mail-dependent slices of Phase 0: **#215 (storm mailer), #219 (claim-deadline ladder sends), #225 (neighbor radius mail), #227 (permit-watch mail)** — plus the shared mail infrastructure they all use.
2. Verify merge state: PRs #81/#82/#83 must be on `main`. Check `packages/db/drizzle/meta/_journal.json` for the true next migration number — do NOT assume. (A `0037` collision bit us before.)
3. Follow the established process: one worktree per slice off `origin/main`, spec in `docs/superpowers/specs/`, TDD, PR per slice, watch CI. Run prod migrations manually from the worktree that contains the new migration, then verify the column exists (see `savvy-crm.md` memory for the gotcha).
4. Study existing patterns and reuse them exactly:
   - **Credential storage:** `integration_connection` + secret-box from PR #77 (Twilio BYO creds). PostGrid API keys are per-tenant, stored the same way, managed on `/settings/integrations`. Support test + live keys (PostGrid issues both).
   - **Vendor seam:** `EmailFinder` in `packages/integrations/src/email-finder.ts` — interface + dormant default. Do the same: `PrintMailProvider` interface, `makePostGridProvider` as the first real adapter, `makeDormantPrintMailProvider` (always no-op, logs skip) as default so nothing sends until a tenant connects a key.
   - **Attempt discipline:** the `enrichment_attempt` ledger (#81) — same anti-hammer thinking applies to sends and webhook retries.
   - **Per-tenant crons:** mirror `enrichment-sweep` fan-out; all schedules computed from `tenant.timezone`.

## PostGrid specifics

- Base: `https://api.postgrid.com/print-mail/v1/` — `postcards`, `letters` endpoints; HTTP basic auth with API key. Templates live in PostGrid (`frontTemplate`/`backTemplate` IDs) with `mergeVariables` for personalization — including `qr_code_url`, which we use for StormProof verification links.
- Track order status via their list/search API and webhooks; statuses progress through printing → mailed → out for delivery. 2-business-day print SLA.
- Also expose their **address verification API** (`/v1/addver/verifications`, CASS-certified) behind the same provider: `verifyAddress(address) → {deliverable, standardized}`. Register it as an **enricher** in the #81 registry (after geocode) so mailability becomes a property attribute — never buy postage for an undeliverable address.

## Data model (one migration)

- `mail_piece`: id, tenant_id, campaign_id, lead_id/property_id nullable, postgrid_id, type (postcard·letter), template_key, status (draft·pending_approval·submitted·printing·mailed·delivered_est·returned·failed·cancelled), cost_cents, merge_vars jsonb, created_at, status_updated_at. RLS. This is the evidence table.
- `mail_campaign`: id, tenant_id, kind (storm_event·claim_deadline·neighbor_radius·permit_watch·resurrection·adhoc), trigger_ref (e.g. storm event id, job id), audience_count, est_cost_cents, approved_by nullable, approved_at nullable, status. RLS.
- `tenant` params (in `tenant_task_config.params`, not new columns): `mail_auto_approve_cents` (campaigns under this cost auto-send; default 0 = everything needs approval until trust is earned), `mail_monthly_cap_cents` (hard stop), `mail_from_address` (the tenant's return address, verified via PostGrid AV at setup).

## Behavior

1. **Campaign creation** (by SCOUT/REMY logic per Phase 0 triggers): build audience → dedupe against `mail_piece` history (**suppression invariant: same address + same campaign kind within 60d = skip**) → verify addresses (drop undeliverable, record why) → estimate cost → if `est_cost > auto_approve` or monthly cap would be exceeded, create a **spend-approval exception** (one card: audience size, cost, sample rendered piece, one-tap approve/deny) — else submit.
2. **Submission:** create PostGrid orders with idempotency keys (campaign_id + address hash) so retries never double-mail. Record `agent_run` per campaign (shows in command center feed).
3. **Status sync:** webhook receiver + a reconciling poll in the nightly sweep (webhooks are fail-soft, poll is truth). Returned mail → mark address undeliverable on the property (enrichment write-back) and suppress future sends.
4. **Attribution:** every piece's QR/tracking URL goes through the existing short-link system (`/b/` pattern) with a per-piece token → scans create/attach to a lead with `source='direct_mail'` and the campaign ref. This feeds task #236 (CAC attribution) for free.

## Registry wiring (this is what makes it part of the orchestrator)

Register/bind these evidence checks per the task-registry framework:

- `mail.suppression` — invariant: zero duplicate sends (same address + kind < 60d). 
- `mail.reconcile` — reconciled: PostGrid order list == `mail_piece` rows for the window; cost totals match; monthly spend ≤ cap.
- `mail.deliverability` — invariant: undeliverable rate < 8% per campaign; breach ⇒ amber + exception (bad list quality).
- `mail.approval_policy` — invariant: zero submitted campaigns above threshold without `approved_by`. **This is the compliance guarantee that money can't move without a human.**
- `mail.attribution` — invariant: every mail-sourced lead carries campaign ref.
- #215/#219/#225/#227 get their Phase 0 bindings as specced (e.g. every completed job has a radius send within 7d or an exclusion reason).

Instantiate `job_task` writes where mail is job-triggered (#225): completion of the radius send marks the job's task with evidence `{type:'mail_campaign', ref: campaign_id}`.

## Slices (one PR each)

1. **Provider seam + creds + AV enricher** — `PrintMailProvider`, PostGrid adapter (test-key integration tests, mocked in CI), dormant default, `/settings/integrations` card, address-verification enricher registered. Tests: seam contract, cred round-trip, enricher fail-soft.
2. **Schema + campaign engine** — migration, audience build, suppression, cost estimation, approval exception card, idempotent submission. Tests: suppression window, idempotency (double-submit = one order), cap enforcement, approval gating (the red-path test matters most).
3. **Status sync + write-backs** — webhook + nightly reconcile poll, returned-mail write-back, short-link QR attribution. Tests: webhook replay safety, poll-vs-webhook disagreement resolves to PostGrid truth, scan → lead with source.
4. **Registry bindings + first campaign kind** — the five evidence checks above wired into the health sweep; implement `neighbor_radius` (#225) end-to-end as the proving campaign (it needs no external data feeds). Tests: each check green-path + red-path; e2e: complete a job in a test tenant → campaign created → pending approval → approve → mock-submitted → job_task evidence written.
5. **Storm + deadline campaigns** (#215/#219) — StormProof event trigger → swath audience; monthly deadline-ladder sweep. Copy templates come from the Library with the no-public-adjusting rubric; template IDs configured per tenant.

## Guardrails (non-negotiable)

- Dormant by default; nothing sends without a tenant PostGrid key AND a configured from-address AND template IDs.
- Every dollar of spend traceable: campaign → pieces → PostGrid orders → reconciled nightly.
- No customer PII in URLs; QR tokens are opaque short-link ids.
- All times/schedules per `tenant.timezone`. No hardcoded TZ anywhere in this build.
- Definition of done: PR answers "which task IDs does this execute, and what proves it ran and ran correctly?" If a slice can't answer, stop and fix the spec first.

Start with slice 1. Before coding, restate the plan, confirm the migration number from the journal, and list which existing files you'll touch.
