# Phase C — Instant contact + speed-to-lead + cadence + compliance (design)

**Date:** 2026-06-24
**Branch:** `feat/instant-contact` (worktree `~/Sites/savvy-phasec`, off `origin/main` @ `b2f6086`)
**Pipeline context:** Phase C of the Lead Intake Pipeline — **Stage 5** (instant contact + 3-min guardrail + multi-touch cadence) plus the compliance layer and the first-touch slice of **Stage 7** (terminal-state guardrail). Builds on Phase A (assignment/slots) + Phase B (scoring/lanes/dedupe). The 3-min guardrail emits an event the **Phase D** AI voice agent will consume.

---

## Goal

Speed-to-lead with intelligence: acknowledge a new lead in <60s, start a 3-minute clock for the assigned rep, escalate if they don't make contact, and run a compliant multi-touch cadence until the lead is contacted or disqualified — so every lead ends in exactly one terminal state (booked / disqualified / in-nurture), no orphans.

Deterministic triggers and timers; the only LLM is an optional, fail-open copy personalization that never delays or gates a send.

---

## Decisions locked (from brainstorming)

- **3-min breach** → emit `lead/contact-overdue` (Phase D voice hook) + human escalation; at ~10 min still-no-contact → **reassign + agentRun audit** (no rep push channel exists, so "manager alert" = reassign + audit).
- **Contact signal** = new `lead.first_rep_contact_at`, set by a rep **"Log contact"** action **and** by an inbound customer reply.
- **Cadence** = a **dedicated lead cadence workflow** (not the drip engine).
- **Compliance** = quiet-hours (tenant tz) on proactive sends + **consent capture** at intake + honor existing opt-out. **DNC registry deferred.**
- **Quiet-hours split:** the immediate ack (transactional response to the lead's own submission) sends immediately; only **proactive cadence** touches honor quiet-hours.

---

## What exists (reuse)

| Piece | Location | Use |
|---|---|---|
| Intake `send-sms` step (booking SMS, no-phone skip) | `packages/agents/src/functions/lead-intake.ts` | **Enhance** → ack SMS **+ email**, template-first + optional personalization |
| Email senders (Resend/Gmail) | `packages/integrations/src/email.ts` (`getEmailSender`) | ack + cadence email |
| SMS senders (Twilio/RingCentral) | `sms`/`smsFrom` (`@savvy/integrations`) | ack + cadence SMS |
| `renderTemplate({{var}})` (never throws) | `packages/core/src/render-template.ts` | template-first copy |
| `draftMessage` (template vs AI capability, injectable) | `packages/agents/src/functions/drip.ts` | pattern to mirror for personalization |
| `nextAllowedSendTime(date, tz, quietHours)` | `packages/core/src/quiet-hours.ts` | cadence quiet-hours gate |
| tenant timezone | `parseFinanceConfig(settings.finance).timezone` | the tenant tz source (dunning uses it) |
| Inbound SMS handler (matches customer by phone; reply path) | `apps/web/src/lib/inbound-sms.ts` | hook the **reply** path → contact signal |
| `runLeadAssignment` / `pickAssignee` / candidates | Phase A | reassign on escalation |
| `recordAgentRun` | `@savvy/db` | escalation/overdue audit |
| Cron pattern (TZ Phoenix) | `cold-archive.ts` / `lead-rescore.ts` | optional daily exception report |
| `smsOptOut` / `emailOptOut` on `customer` | `packages/db/src/schema/crm.ts` | honored on every send |

---

## Events (add to `packages/agents/src/client.ts`)

- `lead/contacted` `{ leadId, tenantId }` — first rep contact made (rep action OR inbound reply). Cancels the SLA timer **and** the cadence.
- `lead/contact-overdue` `{ leadId, tenantId }` — 3-min SLA breached. **Phase D voice agent subscribes.** No-op consumer in Phase C beyond the audit.
- `lead/disqualified` `{ leadId, tenantId }` — lead moved to lost/disqualified. Cancels the cadence.

---

## Component 1 — Instant ack rework (enhance intake `send-sms` step)

- Rename/extend the step to send **both** an ack **SMS and email** (when each channel is present + not opted out), <60s, in parallel within the durable step.
- **Template-first:** `renderTemplate` an ack template with merge fields `{{name}}`, `{{address}}`, `{{stormContext}}`, `{{repName}}` (rep name once assigned; storm context from the scored features). Optional cheap-model personalization (`draftMessage`-style, capability `"workhorse"`) runs with a **short timeout**; on any error/timeout it **falls open to the rendered template**. The send never waits past a small bound.
- **Quiet-hours bypass:** the ack is a transactional reply to the lead's own submission → sent immediately regardless of hour. (Cadence honors quiet-hours; the ack does not.)
- Logs a `communication` per channel (existing pattern). Consent (Component 5) is checked before the SMS ack.

## Component 2 — Contact signal (`lead.first_rep_contact_at`)

- **Migration:** `lead.first_rep_contact_at timestamptz` (nullable).
- **Rep action** (`apps/web/src/lib/lead-actions.ts`): `logLeadContact(leadId)` — sets `first_rep_contact_at = now()` if null, emits `lead/contacted`. Idempotent (no-op if already set). A **"Log contact"** button on the lead detail calls it.
- **Inbound reply hook** (`inbound-sms.ts`): on the ordinary **reply** path (`reason === "reply"`), find the customer's open lead(s) and set `first_rep_contact_at` (if null) + emit `lead/contacted`. (A customer reply counts as contact, per decision.) STOP/opt-out path is unchanged.

## Component 3 — Speed-to-lead clock + 3-min guardrail (`packages/agents/src/functions/lead-speed-to-lead.ts`, new)

- Inngest function on `lead/created`, `cancelOn: [{ event: "lead/contacted", match: "data.leadId" }]`.
- `step.sleep("first-touch-sla", cfg.firstTouchSlaMin)` → reload lead; if `first_rep_contact_at` still null **and** the lead is assigned: emit `lead/contact-overdue` + `recordAgentRun("lead.sla.overdue")`.
- `step.sleep("escalate", cfg.escalateMin - cfg.firstTouchSlaMin)` → reload; if still no contact: **reassign** to a different candidate (`reassignLead` — `pickAssignee` over candidates excluding the current owner; round-robin fallback) + `recordAgentRun("lead.sla.escalated")`.
- If contact happens at any point, `cancelOn` tears the workflow down (no further sends/escalation).
- Config `tenant.settings.speedToLead { firstTouchSlaMin: 3, escalateMin: 10 }` (zod-defaulted).

## Component 4 — Lead cadence workflow (`packages/agents/src/functions/lead-cadence.ts`, new)

- Inngest function on `lead/created`, `cancelOn: [{ event: "lead/contacted", match: "data.leadId" }, { event: "lead/disqualified", match: "data.leadId" }]`.
- Steps at **Day 0 (×2), 1, 3, 5, 7, 14** (config `cadence: { dayOffset, hourOffset, channel }[]`). For each touch, in a durable `step.run` after a `step.sleepUntil`:
  1. reload lead/customer; if contacted/lost → exit (belt-and-suspenders with cancelOn).
  2. **consent + opt-out gate:** skip SMS if no `sms_consent_at` or `smsOptOut`; skip email if `emailOptOut`.
  3. **quiet-hours gate:** compute `nextAllowedSendTime(now, tenantTz, cfg.quietHours)`; if the touch falls in quiet hours, send at the next allowed time (the step already controls timing).
  4. render booking-link template (template-first + optional personalization, fail-open), send, log `communication`.
- Cadence exhaustion with no contact = **in-nurture** terminal state.
- Config `tenant.settings.leadCadence { steps: [...], quietHours: { startHour: 21, endHour: 8 } }`; tenant tz from finance config.

## Component 5 — Compliance

- **Consent capture:** `customer.sms_consent_at timestamptz` (migration). Set in `createLeadForTenant` when a phone is present at intake (a web/API submission with a phone number = TCPA prior express consent). Reused customers (dedupe) keep their earliest consent; set it if currently null.
- **Quiet-hours:** enforced on all **proactive** (cadence) SMS via `nextAllowedSendTime` + tenant tz. Ack is exempt (transactional).
- **Opt-out:** every send checks `smsOptOut` / `emailOptOut` (already honored by inbound STOP).
- **`lead/disqualified`:** emit from the lead-lost path (`setLeadLost`) so the cadence cancels. (Disqualified-by-score from Phase B's gate can also emit it at intake — optional; the lost action is the primary trigger.)
- DNC registry: **out of scope** (documented).

## Stage 7 sliver

- The SLA workflow is the **first-touch guardrail**; cadence + cancel events guarantee every lead ends booked / disqualified / in-nurture.
- **Optional minimal exception cron** (`lead-exceptions.ts`): nightly, count open leads with no `first_rep_contact_at` past SLA and leads with no terminal movement; `recordAgentRun` a summary. (Lightweight; surfaced via agentRun. Include only if it doesn't bloat the phase — otherwise defer.)

---

## Data flow

```
lead/created ──┬─ leadIntake (enhanced): ack SMS+email (<60s, template-first, quiet-hours EXEMPT, consent-gated)
               ├─ leadSpeedToLead: sleep 3m → overdue? emit lead/contact-overdue + audit
               │                    sleep→10m → still none? reassign + audit   [cancelOn lead/contacted]
               └─ leadCadence: Day0×2/1/3/5/7/14 touches, quiet-hours + consent + opt-out gated
                                                                 [cancelOn lead/contacted | lead/disqualified]

rep "Log contact"  → logLeadContact → set first_rep_contact_at → emit lead/contacted ─┐
inbound reply (inbound-sms reply path) → set first_rep_contact_at → emit lead/contacted ┘→ cancels SLA + cadence

setLeadLost → emit lead/disqualified → cancels cadence
```

---

## Error handling

- **Ack personalization** times out / errors → template (fail-open); send never blocked.
- **SMS/email send** errors → logged, comm row still written with a mock/empty sid (existing pattern); workflow continues.
- **Inngest** timers are durable; `cancelOn` guarantees no sends after contact. Each touch step is idempotent (re-check state before send).
- **Reassign** with no alternate candidate → audit "no-candidate", leave as-is (don't drop the lead).
- **Config** missing/invalid → zod defaults (SLA 3/10, standard cadence, 21–08 quiet hours).

---

## Testing

Pure unit (local-gated):
- ack copy: `renderTemplate` merge fields; personalization fail-open returns the template on a throwing AI client.
- cadence schedule: the `cadence` config expands to the right offsets; consent/opt-out gating decisions (a pure `shouldSend(channel, customer, consent)` helper).
- quiet-hours: a touch in quiet hours resolves to `nextAllowedSendTime`.
- `parseSpeedToLeadConfig` / `parseLeadCadenceConfig` defaults + overrides.
- reassign picker: excludes the current owner; round-robin fallback.

CI-gated (DB / workflow):
- `logLeadContact` sets `first_rep_contact_at` once + emits `lead/contacted`; inbound reply path sets it.
- speed-to-lead: no contact → `lead/contact-overdue` emitted + audit; contact → canceled (no escalation). (Use Inngest test stepping / a `runSpeedToLead(tenantId, leadId)` pure-ish core where possible.)
- cadence: opted-out customer gets no SMS touch; consent-less customer skipped; contacted lead cancels.
- consent: intake with phone sets `sms_consent_at`.

---

## Migration

```sql
ALTER TABLE "lead" ADD COLUMN "first_rep_contact_at" timestamptz;
ALTER TABLE "customer" ADD COLUMN "sms_consent_at" timestamptz;
```
Both nullable. Config in `tenant.settings.speedToLead` + `tenant.settings.leadCadence` jsonb (no migration). Ship SQL + drizzle meta together.

---

## Out of scope

- The AI voice call at the 3-min mark (Phase D consumes `lead/contact-overdue`).
- DNC registry scrubbing; double-opt-in flows.
- Per-rep push/notification channel (escalation = reassign + agentRun audit).
- Reworking the drip engine (a separate, dedicated lead cadence is built).
- Rich exception dashboard (only the minimal agentRun audit / optional cron).

---

## Self-review

- **Placeholders:** none; every component names its file + signature + event.
- **Consistency:** `lead/contacted` cancels BOTH the SLA workflow and the cadence; `first_rep_contact_at` is the single contact signal written by both the rep action and the inbound hook; the ack's quiet-hours exemption vs cadence's enforcement is stated once and applied per component.
- **Scope:** large but one coherent Stage-5 slice; voice deferred to D, exception dashboard minimal, DNC deferred.
- **Ambiguity:** SLA thresholds (3/10), cadence offsets (0×2/1/3/5/7/14), quiet-hours default (21–08), consent rule (phone-at-intake = consent), and the ack-exempt/cadence-gated split are all pinned.
