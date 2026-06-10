# Phase 3 — Comms Agent: Design Spec

**Date:** 2026-06-09
**Status:** Approved (design); pending implementation plan
**Depends on:** Phase 0 (foundation + lead→job slice) + Phase 2 (jobs & pipeline) — both merged to `main`

## Scope (approved)

Build the **SMS drip + email core** of the Comms agent: templated + AI-drafted message sequences, durable, all logged to `communication`, with comprehensive stop conditions. **Real AI voice reception is deferred** to its own phase — Phase 3 ships only an after-hours voice **capture stub**. **Inbound email parsing is deferred** — only inbound **SMS** is handled live.

Approved judgment calls:
1. Opt-out modeled as booleans on `customer` (`sms_opt_out`, `email_opt_out`), not a separate table.
2. Inbound email parsing deferred (stub); inbound SMS is real.
3. Real AI voice deferred; Phase 3 voice = after-hours capture stub only.
4. Drip enrollment = one Inngest run with `cancelOn` for stops (idiomatic durable approach, not polling).

## Goal

A roofing company can enrol a contact into a nurture **drip** (a timed sequence of SMS/email messages, templated or AI-drafted); messages send durably on schedule; the sequence **stops** automatically when the contact replies, converts, opts out, or a rep stops it; everything is logged to `communication`, tenant-scoped.

## Existing infrastructure (reuse)
- `communication` table (channel `call|sms|email`, direction, to/from/body/recordingUrl/transcript/twilioSid/aiHandled).
- `packages/integrations`: `SmsSender` interface + `twilioSms` impl (used by `lead.intake`).
- `packages/ai`: capability gateway (`reason`, `summarize`, `cheap-classify`).
- `packages/agents`: Inngest client + workflows. `lead.intake` already sends an SMS + logs it.
- `/api/twilio/inbound`: already creates a lead from an inbound call/SMS.

## Data model additions (new tables — tenant-scoped + `tenant_isolation` RLS)

### `message_template`
`id, tenant_id, key (stable), name, channel (sms|email), subject (email only, nullable), body (with {{vars}}), ai_capability (nullable — if set, body is an AI prompt rendered at send time), created_at, updated_at`.
Index `(tenant_id, key)`.

### `drip`
Sequence definition. `id, tenant_id, key, name, trigger_event (text, e.g. "lead/created"), steps (jsonb), active (bool default true), created_at`.
`steps` shape: `[{ stepNum: number, delayHours: number, channel: "sms"|"email", templateKey?: string, aiPrompt?: string }]` — each step references a template OR an inline AI prompt.

### `drip_enrollment`
`id, tenant_id, drip_id -> drip, customer_id -> customer, job_id? -> job, lead_id? -> lead, status (active|stopped|completed), current_step (int default 0), stopped_reason (nullable: reply|converted|opted_out|manual), inngest_run_id?, enrolled_at, completed_at?`.
Index `(tenant_id, customer_id)`, `(tenant_id, status)`. A partial-unique constraint prevents two `active` enrollments of the same `(drip_id, customer_id)`.

### `customer` — add columns
`sms_opt_out boolean default false`, `email_opt_out boolean default false`. (Migration + the existing RLS policy already covers `customer`.)

## Integrations

### `EmailSender` (Resend)
`packages/integrations/src/email.ts`:
```ts
export interface EmailSender {
  sendEmail(opts: { to: string; from: string; subject: string; html: string }): Promise<{ id: string }>;
}
export const resendEmail: EmailSender; // calls Resend API via RESEND_API_KEY
```
Behind an interface so SES can replace it at scale (one-file change). Env: `RESEND_API_KEY`, `EMAIL_FROM`. Tests inject a mock. Add to `.env.example`.

## The drip engine (core)

### Enrollment
Emit `drip/enroll { tenantId, dripKey, customerId, jobId?, leadId? }`. The `dripRun` Inngest function:
1. Loads the `drip` (by key) + creates a `drip_enrollment` (status `active`, current_step 0). If an active enrollment already exists for `(drip, customer)`, no-op.
2. For each step in `drip.steps`:
   - `await step.sleep("step-N", \`${delayHours}h\`)`.
   - Re-load the enrollment; if `status != active`, exit (stopped mid-sleep).
   - Check the contact's opt-out flag for the channel; if opted out, skip the send (log a suppressed note) and continue.
   - Render the message: template (variable substitution) or AI-draft (gateway). 
   - Send via `SmsSender`/`EmailSender` (mocked in tests; fail-soft logs with a mock id if no creds).
   - Insert a `communication` row (outbound, `ai_handled` if AI-drafted) + an `agent_run` (agent `comms`).
   - Update `current_step`.
3. Set `status = completed`, `completed_at`.

### Stop (cancellation)
`dripRun` is defined with `cancelOn: [{ event: "drip/stop", match: "data.enrollmentId" }]` (and/or by customerId). When cancelled, a short cleanup sets `status = stopped` + `stopped_reason`. Stop sources emit `drip/stop`:
- **Reply** — `/api/twilio/inbound` (inbound SMS) emits `drip/stop {reason: "reply"}` for the contact's active enrollments.
- **Converted** — `lead.booked` (and stage→won) emits `drip/stop {reason: "converted"}`.
- **Opted out** — STOP/UNSUBSCRIBE keyword (SMS) or unsubscribe link (email) sets the opt-out flag and emits `drip/stop {reason: "opted_out"}`.
- **Manual** — a `stopDrip` server action emits `drip/stop {reason: "manual"}`.

Belt-and-suspenders: even without cancellation delivery, the per-step status re-check stops sends.

## Templates & rendering
- `packages/core`: a `renderTemplate(body, vars)` helper — `{{var}}` substitution; unknown vars render empty + are logged (no throw). Unit-tested.
- AI-drafted steps: call the gateway with the step's `aiPrompt` + contact context (name, job stage, etc.); send the returned text. Capability: `reason` for nuanced, `summarize`/cheap for volume (per step config; default `summarize`).
- Seed a starter **nurture drip** (e.g. 3 steps: SMS day 0, email day 2, SMS day 5) + a few `message_template` rows, for demos/e2e.

## Inbound & opt-out
- **Inbound SMS** — extend `/api/twilio/inbound`: log the inbound to `communication`; if body matches `STOP|UNSUBSCRIBE|CANCEL` (case-insensitive) set `customer.sms_opt_out=true` + emit `drip/stop {opted_out}`; otherwise emit `drip/stop {reply}` for the sender's active enrollments. (Lead creation behavior preserved.)
- **Unsubscribe (email)** — email bodies include an unsubscribe URL `/api/unsubscribe/[token]` (token = signed customerId); the route sets `email_opt_out=true` + emits `drip/stop {opted_out}`.
- **Suppression** — every send checks the channel opt-out flag first.
- **Inbound email parsing** — DEFERRED (stub). No inbound-email route.

## Voice stub
- `/api/twilio/voice` — TwiML: after-hours, play a greeting + `<Record>` a voicemail/callback; on the recording callback, insert a `communication` (channel `call`, `ai_handled=true`, recordingUrl/transcript if available) and create a lead/callback note. No LLM conversation — that's a future phase.

## UI
- `/comms` area (tenant-scoped, server components + server actions):
  - **Templates**: list + edit (name, channel, subject, body). 
  - **Drips**: list sequences + active toggle; show the steps.
  - **Enrollments**: who's enrolled, in which drip, status + stopped_reason.
- The existing job-detail **Comms tab** already renders `communication` per job — unchanged.
- Keep each page focused (CRUD over one table). Reuse existing shadcn primitives.

## Testing
- **Unit**: `renderTemplate` (vars, missing-var, no-throw); drip step advancement + completion; stop handling (status re-check exits); opt-out suppression; STOP-keyword detection.
- **RLS**: isolation test extends to `message_template`, `drip`, `drip_enrollment`.
- **Integration**: enroll → first step sends (mocked sender) + `communication` logged; emit `drip/stop` → enrollment `stopped`, no further sends.
- **e2e (Playwright)**: enrol a seeded contact in the starter drip; trigger the first step (short/zero delay in test); assert a `communication` row + the message in the job/contact comms; simulate an inbound STOP → assert enrollment `stopped` + `sms_opt_out`. Reuse the Phase 0/2 harness (ai-stub, inngest dev, TEST_MODE) — Inngest dev is required (drips are Inngest runs).

## Conventions (Phase 0/2 — enforce)
- Imports via `@savvy/db`/`@savvy/core` roots (single instance), no `.js` extensions, `withTenant` for every app DB access, RLS on new tables, server actions `"use server"`, integrations behind interfaces + mocked in tests, AI only via the gateway by capability.

## Out of scope (deferred)
- Real AI voice receptionist (LLM phone conversation) — future phase.
- Inbound email parsing / reply threading.
- Visual drip-sequence builder (Phase 3 = list/edit of seeded + simple drips; a drag builder is later).
- Per-tenant sending-window / quiet-hours config (use sensible fixed defaults; TCPA quiet-hours is a flagged follow-up).

## Open assumptions / follow-ups
- **TCPA/compliance**: STOP handling + opt-out are implemented; quiet-hours (no SMS 9pm–8am local) and explicit consent capture are flagged as a compliance follow-up before real sending.
- Drip step delays use `step.sleep` (Inngest durable timers); tests use near-zero delays via a seeded test drip.
- Resend chosen for best price-to-quality at pilot scale; `EmailSender` interface keeps SES swap-in cheap.
