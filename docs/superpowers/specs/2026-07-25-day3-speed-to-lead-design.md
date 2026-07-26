# Day 3 — Speed-to-Lead, Missed-Call Text-Back & the Compliance Spine (Design)

**Date:** 2026-07-25
**Status:** Approved (Brett). Builds on Day 1 (`packages/orchestrator`, merged #259) + Day 2
(`packages/command-center`, merged #261/#263).
**Decision:** **Option B** — gap-fill Savvy's existing live **Inngest** comms layer + a bridge that
publishes canonical DomainEvents into the standalone `orchestrator_event` log. Chosen after a code
audit (see below). This supersedes the original greenfield-on-standalone-bus Day-3 prompt.

## Why Option B (audit-grounded)
- **Inngest already implements ~6 of Day 3's 11 items durably, in production:** SLA timer
  (`lead-speed-to-lead.ts`, real `step.sleep`/`sleepUntil`/`cancelOn`), territory + round-robin +
  load-balanced assignment (`pick-assignee.ts`), self-scheduling→booked (`createBookingLink` →
  booking route), confirmation + 24h/1h reminders (`appointment-reminders.ts`), reply-cancelling
  drip (`lead-cadence.ts`), idempotent first touch (`lead-intake.ts`).
- **The standalone Day-1 bus cannot safely host this:** synchronous single-tick in-memory FIFO, no
  durable timer/scheduler, no retries/crash-redelivery, telephony is mock seams only, not wired
  into any live route. Day 3's SLA-breach timer, reminders, and 7–14 day drip are definitionally
  durable-async — Inngest's domain. Also honors `CLAUDE.md` non-negotiable #3.
- **Day-1's role is reframed, not demoted:** the standalone orchestrator is the **canonical event
  log + escalation sink + contract registry** (the system of record for *what happened / what needs
  a human*) — Days 2 & 4 consume it. Inngest is the **execution engine**. The bridge connects them.

## Codebase grounding (what exists; verified)
- **Consent/opt-out today** = per-customer columns `smsOptOut`/`emailOptOut`/`smsConsentAt` +
  `shouldSendChannel` (`packages/core/src/voice-persona.ts`) + `touch-governor` (cadence caps) +
  `comms.ts` STOP keywords + signed unsubscribe tokens + the Twilio inbound webhook
  (`apps/web/src/app/api/twilio/inbound/route.ts`). **These exist but are applied inconsistently —
  `drip.ts` bypasses them.** That is the live TCPA hole to close.
- **The send chokepoint** = `interface SmsSender.sendSms()` (`packages/integrations/src/twilio.ts`),
  resolved per-tenant via `getTenantSms` (`packages/agents/src/telephony.ts`); a mock sender
  (`mock-comms.ts`) exists for offline tests.
- **Events emit** via `inngest.send` / `step.sendEvent` → the bridge is a `publishDomainEvent()`
  called inside `step.run`.

## Key decision — the global suppression store is ADDITIVE
Appendix A.2's global `contact_suppression` table is a NEW cross-agent source of truth. It does
**not** replace the existing per-customer consent columns or `shouldSendChannel`. The single comms
gateway enforces **both**: the global suppression list (phone/email, any agent, any campaign) AND
the existing per-customer consent. No migration or removal of existing consent logic — everything
is just funneled through one gate that checks both, in order.

## Architecture — 4 slices (subagent-driven, TDD, mock Twilio)

### Slice A — the compliance spine (highest-risk; everything depends on it)
- **Global suppression store** (Appendix A.2): `contact_suppression` table (core/db, RLS) +
  frozen API `isSuppressed(...)`/`suppress(...)` (idempotent; `suppress` emits `contact.opted_out`).
- **Single comms gateway** — one chokepoint every outbound SMS/email passes through, **no bypass
  path**. Enforcement order: global `isSuppressed` → per-customer consent (`shouldSendChannel`) →
  quiet hours in the lead's local tz (8am–9pm; queue to window open, never drop) → A2P/10DLC
  campaign-status gate (unapproved ⇒ **fail closed**, never silent-send) → cadence cap → send.
  Every send + every suppression writes an auditable record.
- Refactor `drip.ts`, `lead-intake.ts`, `lead-cadence.ts`, `appointment-reminders.ts` to route
  through the gateway. Add the missing **HELP** handler; keep/verify **STOP** → `suppress()` +
  `contact.opted_out`, wired in the inbound webhook.
- **Acceptance-critical:** structurally impossible to send SMS without traversing the gate.

### Slice B — the bridge + the numbers that light up the Command Center
- `publishDomainEvent()` exported from `packages/orchestrator`, called **inside `step.run`** (so
  publication is durable + retried + idempotent via the Day-1 unique index) at the Appendix-A.1
  emission points: `lead.first_touch` (with `latencySeconds`, and `slaLatencySeconds` +
  `quietHoursDeferred` when deferred), `lead.assigned`, `appointment.set`/`appointment.no_show`,
  `reminder.sent`, `drip.step.sent`, `message.inbound`.
- Complete the **real durable `speed-to-lead-breach` timer** (extend `lead-speed-to-lead.ts`) +
  `assignment-failure` + the new **`compliance-block`** escalation → into `exception_queue`
  (surfaces the mock-Twilio/unregistered-A2P reality instead of hiding it).

### Slice C — the new touchpoints
- **Missed-call text-back** (Gap 1, doesn't exist today): Twilio inbound-call/no-answer webhook →
  emit `call.missed` → handler auto-texts "sorry we missed you" + booking link within seconds;
  match `fromNumber` to a lead or create one (source `missed-call`).
- **No-show customer re-engagement** (Gap 4): on `appointment.no_show`, customer-facing reschedule
  message (not just the internal queue flag), then hand back to cadence.
- **Bilingual EN/ES + per-`locationId` branding** (Gap 5): templates by lead language; branding /
  sending number / quiet-hours tz resolved per `locationId` (nullable until locations are modeled,
  but the field exists end-to-end now).

### Slice D — the acceptance test (all 11 §8 checks)
Proves: gateway can't be bypassed (every path blocked when suppressed); global STOP suppresses
across a *different* agent; quiet-hours deferral sets `slaLatencySeconds`/`quietHoursDeferred`;
A2P-unapproved SMS fails closed + `compliance-block` in `exception_queue`; missed-call text-back;
first-touch `lead.first_touch` lands in `orchestrator_event` with correct latency **and the Command
Center Speed panel populates** (bridge end-to-end); durable breach timer survives a restart; no-show
reschedule sent; ES templates + per-location resolution; idempotent (one first touch, one bridge
row); and a **regression pass** that the existing Inngest behaviors (assignment, scheduling, 24h/1h
reminders, reply-cancelling drip) still pass their current tests.

## Frozen contracts (Appendix A — from the v2 build prompt; downstream depends ONLY on these)
Additive changes only; never rename/reshape/relocate.
- **A.1 canonical DomainEvents** (into `orchestrator_event`, standard Day-1 envelope): `lead.first_touch
  { leadId, locationId, channel, latencySeconds, occurredAtLeadCreated }` (+ `slaLatencySeconds`,
  `quietHoursDeferred` when deferred); `lead.assigned { leadId, locationId, repId, territory }`;
  `appointment.set { leadId, locationId, appointmentId, apptAt, repId, selfBooked }`;
  `appointment.no_show { leadId, locationId, appointmentId, apptAt }`;
  `call.missed { leadId|null, locationId, fromNumber, toNumber }`;
  `contact.opted_out { contactId, locationId, channel, reason }`;
  `message.inbound { contactId, leadId|null, locationId, channel, isOptOut }`;
  `reminder.sent { leadId, locationId, appointmentId, offset, channel }`;
  `drip.step.sent { leadId, locationId, step, channel }`. `locationId` on every payload (null OK).
- **A.2 global suppression** (`contact_suppression`, single source of truth in core/db): `{ id,
  tenantId, locationId?, contactId?, phoneE164?, email?, channel: 'sms'|'email'|'all', reason:
  'stop'|'manual'|'bounce'|'complaint', createdAt, source }`, unique `(tenantId,
  coalesce(phone,email), channel)`. Frozen API: `isSuppressed({tenantId, contactId?, phoneE164?,
  email?, channel}): Promise<boolean>`; `suppress({..., reason, source}): Promise<void>`
  (idempotent, emits `contact.opted_out`). **Scope: global per tenant across all agents/campaigns**
  — a STOP anywhere suppresses reviews/referrals/collections/reactivation too.
- **A.3 read-model shapes** (`daily_metrics`, `exception_queue`) — UNCHANGED from Day 2; Day 3 only
  feeds them. New escalations: `speed-to-lead-breach`, `assignment-failure`, `compliance-block`.
- **A.4 bridge** — `publishDomainEvent()` in `packages/orchestrator`, called in `step.run`,
  idempotent via the Day-1 unique index. **Implementation detail** — no downstream prompt references
  it; downstream reads the events, never the mechanism.

## Non-functional
- **Fail closed on compliance** — unknown consent / unapproved A2P / suppression store unavailable ⇒
  do not send SMS; log + escalate. Never "assume allowed."
- **Idempotent** — one first touch per lead; retries never double-text; bridge dedupes on
  `idempotencyKey` (Day-1 unique index).
- **Multi-location now** — `locationId` in every A.1 payload (nullable until modeled).
- **Minimal PII** in events/logs (ids + facts, not sensitive bodies).

## Scope
All code + the 11-check acceptance test built against **mock Twilio** now (offline-testable). Real
Twilio creds + local-presence numbers + A2P/10DLC campaign wired as the supervised integration once
carrier approval clears. **A2P 10DLC registration is a start-today, days-to-weeks external blocker
on real SMS** (Twilio is mock-only on prod today) — not code, needs Brett's Twilio account.

## Out of scope
Predictive dialer, AI voice receptionist, migrating any working Inngest function onto the standalone
bus.

## Downstream impact (Appendix B)
Day 4 (weekly scorecard + dashboards) and the later comms agents (reviews / referrals / collections /
reactivation) depend ONLY on Appendix A: they read `daily_metrics`/`exception_queue`, the A.1 events,
and — critically — the A.2 `isSuppressed` API. No later prompt needs a bespoke artifact from Day 3.
