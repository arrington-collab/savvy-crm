# Demo Tenant + Full-Pipeline Seeder — Design

**Date:** 2026-07-11
**Branch / worktree:** `demo-seeder`
**Status:** Approved design, pre-implementation

## Goal

Stand up a dedicated **demo tenant** — "Demo Roofing (Savvy)" — populated with **one realistic
job at every pipeline stage**, so the owner can walk the board end-to-end and audit each stage's
evidence, ledger, timeline, and docs. Every row is produced by the **real lifecycle functions**
(through the stage gates), never inserted directly. The demo tenant is **comms-hard-muted**: no
outbound SMS/email/voice ever reaches a real provider.

This is a demo/sales/QA asset. It is NOT a new product feature except for the one piece of durable
product code it requires: a **tenant-level comms kill switch** (`comms.demo_mute`).

## Non-negotiable guardrails (from the task)

1. Provision a **NEW** tenant via the real runbook; never seed into Bloom or any real tenant.
   Tenant flag `demo=true`.
2. **Comms hard-muted** for demo tenants: every outbound SMS/email/voice path checks the flag and
   writes a mock-delivery record instead of sending. Invariant `comms.demo_mute` — **zero real
   provider calls** for `demo=true` tenants, proven by a red-path test. **Built FIRST.**
3. Seeder is **idempotent** (re-run = same state, no dupes) with `--reset` teardown. All data flows
   through lifecycle functions so stage events, `job_task` ledgers, `agent_run` rows, and evidence
   links are REAL.

---

## Codebase survey (established facts this design relies on)

### Provisioning
- Canonical entry: `provisionTenant(config, secrets, { dryRun })` — `packages/db/src/lifecycle/provision-runbook.ts:135`.
  Idempotent, dry-run-first. Steps: tenant → owner → price book → licenses → contract templates →
  task registry → message templates → Twilio (dormant unless a secret is passed).
- `ensureTenantForOrg({clerkOrgId, name})` (`provisioning.ts:11`) and `ensureUser({tenantId, clerkUserId, name, email, role})`
  (`provisioning.ts:38`) are find-or-create. **The db layer never calls the Clerk API** — `clerkOrgId` /
  `clerkUserId` are opaque strings. Synthetic IDs work for seed staff; the *owner* needs a REAL Clerk
  org so it can be switched to in the app.
- `tenant` table (`schema/tenancy.ts:9`) has **no `demo` column** today; it has a `settings` jsonb,
  `stripeAccountId`, `timezone` (default `America/Phoenix`), `telephonyMode` (default `platform`).
- RLS: `withTenant(tenantId, tx => …)` (`packages/db/src/tenant.ts:11`) sets `app.tenant_id` on the
  `savvy_app` role. `adminDb` (`admin-client.ts`) bypasses RLS (superuser) — used by the runbook for
  tenant/user/license rows. Price-book seeding uses `withTenant`.

### Lifecycle (the funnel — a job's stage is DERIVED from evidence)
- `recordStageChange(tx, {tenantId, jobId, toStage, byUserId?, byAgent?, reason?})` — `lifecycle/record-stage-change.ts:53`
  — the **only** writer of `job.stage` + `job_stage_event`. Gates: evidence gate (`StageEvidenceError`),
  backward-needs-reason, `complete` needs production photos, per-stage required-docs. On success it also
  **activates** that stage's `job_checklist_item` rows (sets `dueAt`).
- Evidence is read from real tables by `gatherStageEvidence` (`stage-evidence-db.ts:14`);
  `deriveContiguousStage` (`core/stage-evidence.ts:27`) = highest stage with an unbroken evidence chain.
  Ladder: inspected←inspection appt done OR any photo; estimate←an estimate exists; approved←accepted
  estimate OR contract doc; production←crew appt scheduled OR material order ordered; closeout←closeout
  photos; billing←invoice; complete←paid invoice.
- Lead intake: `createLeadForTenant(tenantId, input)` — `apps/web/src/lib/intake.ts:34` — dedupes
  customer/property, inserts `lead` (`status:"new"`), calls `instantiateLeadTasks` in-tx.
- Lead status transitions are **sparse**: `new→contacted` in the AI-qualify step; `→won` only in
  `convertLeadToJob`; `→lost` via `setLeadLost` (**no reason column**). `qualified` / `booked` have
  **no lifecycle setter** — must be set directly for the seed.
- Appointments: `bookAppointment(input)` — `lifecycle/appointments.ts:61` (license gate + rescission
  gate for `crew`); `bookLeadSlot(...)` for inspections; `setAppointmentStatus(...)` → `done`.
  Reminders: `appointmentReminders` Inngest fn.
- Lead → Job: `convertLeadToJob(args)` — `lifecycle/appointments.ts:217`. Requires an **accepted
  estimate** OR `manualJob:true` (+ contract doc OR reason). Auto-resolves open lead tasks; open MANUAL
  tasks without a supplied `resolutions` entry throw `ConversionBlockedError`. Creates the job, seeds
  both task systems, and lands it at its evidence-supported stage.
- Estimate path: `saveSketchMeasurement(input)` (`lifecycle/measurement.ts:39`, DIY `provider:"diy",
  source:"sketch"`) → `draftLeadEstimateIfReady({tenantId, leadId})` (`estimate.ts:92`, gated on a done
  inspection + a measurement, idempotent) → `setEstimateStatus(...,"sent")` → `advanceJobForAcceptedEstimate(tenantId, estimateId)`
  (`agents/functions/estimate-sign.ts:73` — accepts, converts to job, advances to `approved`).
- Invoices/payments (`lifecycle/invoices.ts`): `createInvoice` / `createInvoiceFromEstimate` (draft) →
  `sendInvoice` (**requires `tenant.stripeAccountId` but makes NO live Stripe call** — just assigns a
  number + status) → `recordStripePayment` (pure DB insert; accrues `amountPaid`, flips `paid` when
  `>= amountDue`). Depreciation: `draftDepreciationInvoice` / `sendDepreciationInvoice`
  (`lifecycle/depreciation-recovery.ts`). Dunning ladder: `dunningRun` Inngest fn off `invoice/sent`.
- Tasks: `instantiateJobTasks` / `instantiateLeadTasks` (registry-backed `job_task`/`lead_task`
  ledgers) + `seedJobTasks` (`job_checklist_item` templates). Open task = `status IN ('pending','in_progress')`;
  that is the "punch item" representation.
- Agent runs: `recordAgentRun({tenantId, agent, taskKey, status, jobId?, leadId?})` — `lifecycle/agent-run.ts:14`.
- Claims: `attachClaim` / `upsertClaim` / `attachOrCreateLeadClaim` (`lifecycle/claim.ts`) populate
  `acvCents`/`rcvCents`/`deductibleCents`. `detectDepreciationRecovery` / `draftDepreciationInvoice`.
- Canvass: `convertCanvassContractToJob(input)` — `lifecycle/canvass-conversion.ts:16` — stamps
  `rescissionHoldUntil` + `canvassRepName`, stores a signed-contract `document` row.
- Landed cost: `recomputeJobActualCost(tenantId, jobId)` — `lifecycle/supplier-invoice.ts:7`;
  `selectLandedWinner(quotes)` — `core/landed-cost.ts:36`.
- Exceptions / Today: `buildExceptionQueue` (`core/exception-queue.ts:65`), `getTodayDigest(now)`
  (`apps/web/src/lib/today-queries.ts:59`).
- Health sweep: `taskHealthSweep` Inngest fn (`agents/functions/task-health-sweep.ts:15`);
  `recomputeTaskHealth(...)` / `spotVerifyDoneTasks(...)` (`lifecycle/task-health.ts`).
- Homeowner status: `getHomeownerStatusByToken(token)` (`apps/web/src/lib/homeowner-actions.ts:5`),
  token signed with `signPayloadToken` (`UNSUBSCRIBE_SECRET`).

### Comms send paths (for the kill switch)
- Three provider primitives (where real HTTP fires): Twilio `twilio.ts:35` (`client.messages.create`),
  RingCentral `ringcentral.ts:43`, Resend `email.ts:12` / Gmail `email.ts:59`, Vapi `vapi.ts:21`/`:53`.
- Tenant-aware resolvers exist for SMS/voice: `getTenantSms(tenantId)` (`agents/telephony.ts:37`),
  `getTenantVoice(tenantId)` (`telephony.ts:102`). **Email has none** — every site builds
  `getEmailSender({gmailConnectionId})` directly (no `tenantId`): confirmed at `drip.ts:208`,
  `dunning.ts:127`, `canvass-contract.ts:234`, plus ~12 inline sites.
- `communication` table (`schema/comms.ts:11`): `tenantId`, `channel`, `direction`, `to`, `from`,
  `body`, `twilioSid`, `deliveryStatus`, `deliveryErrorCode`, `dedupeKey`, … Rows are written inline
  at each send site (no `recordComm()` helper).

### Flavor-feature reality (drives what the seeder exercises vs. fakes)
| Feature | Verdict |
|---|---|
| Landed cost | EXISTS — `recomputeJobActualCost` |
| Insurance parse | Pipeline EXISTS but **no PDF fixtures** and it calls a **live AI model** → seed the ledger via `attachClaim`/`draftDepreciationInvoice` (what the parser calls post-extraction) |
| Canvass → contract → job + rescission | EXISTS — `convertCanvassContractToJob` |
| Spanish crew (`language=es`) | **DOES NOT EXIST** — no `language` field. Skip. |
| Stuck / exceptions / Today | EXISTS — `buildExceptionQueue`, `getTodayDigest` |
| Health sweep | EXISTS — `taskHealthSweep`, `recomputeTaskHealth` |
| Homeowner status page | EXISTS — `getHomeownerStatusByToken` |
| Warranty / review-request events | **Not runtime events** — only seed task-catalog rows (task 153). Seed rows, don't fire events. |
| Good/better/best estimate tiers | Price book is **flat single-price**; no tier feature. Draft the one real estimate. |

---

## Architecture — three parts, one PR

### Part 1 — `tenant.demo` flag + comms demo-mute *(BUILT FIRST, TDD)*

**1a. Migration.** Add `demo boolean not null default false` to `tenant`. Drizzle migration generated
locally; applied to prod Supabase via MCP `apply_migration` at prod-run time (local drizzle numbering
is one behind prod — reconcile the number when applying).

**1b. Mock senders + demo-aware resolvers.** New module `packages/agents/src/demo-mute.ts`:
- `makeMockSms(tenantId)`, `makeMockEmail(tenantId)`, `makeMockVoice(tenantId)` — each implements the
  provider interface (`SmsSender`/`EmailSender`/`VoiceGateway`) but, instead of the provider call,
  writes a mock-delivery `communication` row (`deliveryStatus:'mock'`, `twilioSid:'mock:<uuid>'`,
  `direction:'outbound'`) inside `withTenant(tenantId, …)`, and returns a synthetic provider id
  (`mock:<uuid>`). Zero provider calls.
- `isDemoTenant(tenantId)` — cached read of `tenant.demo` (the SMS/voice resolvers already SELECT the
  tenant row, so this is a zero-extra-query addition there).

Wire the demo branch into:
- `getTenantSms` / `getTenantVoice` — return the mock sender when `demo`.
- **New `getTenantEmail(tenantId, { gmailConnectionId })`** mirroring `getTenantSms`; returns the mock
  email sender when `demo`, else `getEmailSender(...)`. **Migrate ALL email send sites** off
  `getEmailSender(...)` onto `getTenantEmail(tenantId, …)`: lead-intake, lead-cadence,
  appointment-reminders, homeowner-notify, homeowner-crew-notify, homeowner-delivery-notify,
  weather-reschedule, retail-cadence, dunning, supplier-invoice-guard, canvass-contract, drip,
  break-glass, ops-digest. (This also removes scattered `getEmailSender` construction — a net cleanup.)

**1c. The invariant (red-path test).** Vitest integration test: provision a `demo=true` tenant, then
drive each channel's real send path (`getTenantSms(...).sendSms`, `getTenantEmail(...).sendEmail`,
`getTenantVoice(...).placeOutboundCall`, plus one Inngest-function send e.g. dunning/drip). Assert:
- a mock `communication` row exists per attempt (`deliveryStatus='mock'`);
- provider primitives are **NEVER** called — spies/mocks on Twilio `client.messages.create`,
  RingCentral POST, `fetch` to `api.resend.com` and `api.vapi.ai`. Any call fails the test.
A negative control (non-demo tenant) asserts the provider *is* invoked, so the switch is real.

### Part 2 — The seeder *(idempotent, `--reset`, through the gates)*

`packages/db/src/scripts/seed-demo-tenant.ts`, pnpm `db:seed:demo` (and `db:seed:demo -- --reset`).

**Target selection.** Runs against whatever `DATABASE_URL` / `DATABASE_ADMIN_URL` point at (local by
default). Prod run uses the correct Supabase creds (see Part 3). The script prints the resolved DB host
+ tenant name and refuses to run against a tenant that isn't `demo=true` (except the initial create).

**Provision.** `provisionTenant({ name:"Demo Roofing (Savvy)", clerkOrgId:<real or DEMO_CLERK_ORG_ID
env>, timezone:"America/Phoenix", owner:{…}, licenses:[{ state:"AZ", authority:"ROC", licenseNumber:"ROC-DEMO-0001" }],
… }, {}, { dryRun:false })`. Then `adminDb.update(tenant).set({ demo:true, stripeAccountId:'acct_demo' })`.
Twilio stays dormant (no secret).

**Demo staff** (`ensureUser`): 1 office admin (`role:"office"`), 2 reps (`role:"rep"` — Rep B owns the
stuck job), 1 crew (`role:"crew"`; no language field → English only). Synthetic deterministic
`clerkUserId`s (`usr_demo_office`, `usr_demo_repA`, …) so re-runs reconcile.

**Idempotency + reset.** Every seeded entity keys off a deterministic natural key (email, phone,
address, or a `settings`/note sentinel like `demoKey`). Re-run reconciles (find-or-create), never
duplicates. `--reset` deletes all rows scoped to the demo tenant in FK-safe order (children first),
leaving the tenant + staff (or `--reset --hard` to drop the tenant entirely).

**Leads (5).** Phoenix-area addresses, `America/Phoenix`:
- `new` — web source, unenriched.
- `contacted` — drip active (`markLeadContacted` + a running drip enrollment; status→contacted).
- `qualified` — set `lead.status='qualified'` directly (no gate fn) + a lead score.
- `booked` — inspection appt Thu via `bookLeadSlot`, reminder scheduled; status set to `booked`.
- `lost` — `setLeadLost` + reason stored as a `lead_note` (no reason column).

**Jobs, one per stage** — each driven up the funnel so evidence is real:
- **INSPECTED** — lead → `bookLeadSlot`(inspection) → `setAppointmentStatus done` →
  `saveSketchMeasurement` (DIY sketch so the report renders) → roof type confirmed →
  `recordStageChange(toStage:"inspected")`.
- **ESTIMATE** — `draftLeadEstimateIfReady` → estimate drafted from the price book → `setEstimateStatus
  sent` → stage lands at `estimate`.
- **APPROVED** — `advanceJobForAcceptedEstimate` (accept → `convertLeadToJob` → `approved`); deposit
  invoice (`createInvoice` → `sendInvoice`); a `material_order` pending; landed-cost comparison attached
  via supplier quotes + `recomputeJobActualCost`.
- **PRODUCTION** — crew appt scheduled (`bookAppointment type:"crew"`), a material-delivered event, a
  few mid-job photo `document` rows, **one OPEN punch item** (a `job_task` left `pending`), and a
  homeowner status token/link.
- **INVOICED (`billing`)** — completed job, final invoice sent, **partial** payment
  (`recordStripePayment` for part), and **one separate 50-day-old receivable** — an invoice with
  `dueAt`/`createdAt` backdated 50 days, `status:"overdue"`, dunning visibly mid-ladder.
- **COMPLETE/PAID** — fully paid (`recordStripePayment` for the balance → `paid`), warranty + review-request
  **task rows** logged (no runtime event fired), `recordStageChange(toStage:"complete")` (needs
  production photos — supplied).

**Flavor jobs:**
- **INSURANCE** — `attachClaim`/`upsertClaim` ledger (ACV/RCV/deductible) + `draftDepreciationInvoice`
  pending + an insurance-estimate `document` row. No supplement content.
- **CANVASS** — `convertCanvassContractToJob` from a signed-contract fixture → contract `document` on
  the job + `rescissionHoldUntil` set (hold visible if still within the window).
- **STUCK** — estimate sent 12 days ago (backdated), no response → surfaces as a stuck exception in
  Today; owned by Rep B.
- **MANUAL-HATCH** — `convertLeadToJob({ manualJob:true, reason:"…" })` + a contract `document`.

**Backdating.** The seeder runs live, so it uses real `now` minus fixed offsets (12d, 50d, Thu, etc.)
written directly to `createdAt`/`dueAt`/`enteredAt` via `adminDb` where the lifecycle fn doesn't accept
a timestamp. This is the one place we touch rows post-hoc — only to age them, never to fabricate
evidence the gates should have produced.

### Part 3 — Health sweep + e2e + prod verification

- After seeding, run `recomputeTaskHealth` / `taskHealthSweep` for the demo tenant so Today, Coverage,
  and the activity feed populate. Exposed as a `--sweep` step the seeder runs by default after create/refresh.
- **Playwright e2e** (`apps/web/tests/e2e/demo-tenant.spec.ts`): with the demo tenant seeded, assert a
  card renders in **every** pipeline column (lead → complete). (Auth uses the repo's existing e2e Clerk
  stub.)
- **Red-path** stays a **vitest** integration test (Part 1c) — provider spies are far more reliable
  there than in a browser. The Playwright suite covers the board; the vitest suite covers the invariant.
- **Prod (supervised, final step):** you create the Clerk org "Demo Roofing (Savvy)" and add yourself
  as owner; confirm the correct Supabase `DATABASE_URL`/`DATABASE_ADMIN_URL`. I then apply the `demo`
  migration via Supabase MCP, run `db:seed:demo` against prod, run the sweep, and walk LEAD→PAID
  switching to the demo org. State captured in the PR.

## PR contents
- The `demo` migration, the demo-mute module + resolver wiring + email-site migration, the seeder
  script + pnpm command, the vitest red-path invariant test, the Playwright board test.
- PR body lists **what was created per stage** and **the org name to switch to** ("Demo Roofing (Savvy)").
- Live prod state verification (LEAD→PAID walk, every column occupied) recorded in the PR.

## Testing strategy (TDD order)
1. `tenant.demo` column + migration; unit test the flag round-trips.
2. Mock senders write mock `communication` rows (unit).
3. Demo-aware `getTenantSms`/`getTenantEmail`/`getTenantVoice` return mocks for demo tenants (unit).
4. **Red-path invariant** (integration) — zero provider calls, mock rows written; negative control.
5. Email-site migration — existing comms tests stay green.
6. Seeder unit/integration: idempotency (run twice → same counts), `--reset` teardown, each stage's
   evidence present + `recordStageChange` did not throw.
7. Playwright: a card in every column.

## Out of scope
- SupplementIQ / supplement content on the insurance job.
- Good/better/best estimate tiers (no feature).
- Spanish crew comms (no feature).
- Real AI PDF parse of an insurance estimate (no fixtures; would be a live model call).
- Creating the Clerk org programmatically (owner-run, per the existing runbook philosophy).

## Risks / open items
- **Prod creds**: memory notes `.env.prod.secrets.local` points at the wrong (Neon) DB; prod is
  Supabase. The prod run is blocked until the correct Supabase creds are confirmed — hence the
  supervised final step.
- **Migration numbering**: local drizzle is one behind prod Supabase; reconcile at apply time.
- **Email-site migration surface**: ~15 sites change import + call. Mitigated by keeping `getTenantEmail`
  a thin wrapper and leaning on existing comms tests.
- **`recordStageChange` gates** may reject a stage if evidence is subtly missing; the seeder asserts
  each expected stage after driving it, failing loudly rather than silently landing a job short.
