# Lead Pipeline: Speed-to-Lead, Cadence & Compliance

This document covers how Savvy handles the critical first-contact window after a lead is created, the follow-up cadence, the compliance guard-rails, and how operators tune the defaults.

---

## 1. Instant Acknowledgment (lead/created)

When a lead is created, the `lead-intake` Inngest function fires an immediate acknowledgment **before** any quiet-hours check. Acknowledgment is quiet-hours-EXEMPT — if someone just submitted a form at 11 PM they expect confirmation now.

- **SMS** (if consent is recorded — see section 4) and **email** (always, unless opt-out) are sent.
- Content comes from tenant message templates. If no tenant template is configured, Savvy falls back to the built-in defaults.
- The ack is NOT part of the numbered cadence steps; it is a pre-step fired unconditionally.

---

## 2. Speed-to-Lead SLA

The 3-minute / 10-minute SLA is tracked against `lead.first_rep_contact_at`.

| Window | Trigger | Action |
|--------|---------|--------|
| **3 min** (`firstTouchSlaMin`) | No rep contact logged | Fire `lead/contact-overdue` (Phase-D hook) — alert assigned rep + notify manager |
| **10 min** (`escalateMin`) | Still no contact logged | Escalation: reassign lead to next available rep, alert manager |

`lead.first_rep_contact_at` is stamped by the **"Log contact" button** on the lead detail page (or by any future automated channel that calls `markLeadContacted`). Once set it never resets — idempotent.

The `lead/contact-overdue` event is emitted by the `lead-speed-to-lead` Inngest step after a durable sleep of `firstTouchSlaMin` minutes. If `first_rep_contact_at` is already set when the step wakes, it no-ops.

> **Phase-D note:** The `lead/contact-overdue` consumer (reassignment escalation, manager alert push) is a Phase-D deliverable. The event emission and SLA timer are live now; the consumer function is stubbed.

---

## 3. Follow-up Cadence

After the ack, Savvy schedules a drip sequence. Steps run relative to lead creation time, offset by `dayOffset` days + `hourOffset` hours, subject to quiet-hours. The **ack SMS owns t=0** (it is the first Day-0 touch), so the cadence does NOT fire a second SMS at t=0 — its first step is the +4h email. "Day 0×2" = ack (t=0) + the +4h email.

### Default schedule (from `packages/core/src/lead-followup.ts`)

| Step | Day | Hour offset | Channel |
|------|-----|-------------|---------|
| 1 | 0 | +4 h | email |
| 2 | 1 | +0 h | SMS |
| 3 | 3 | +0 h | email |
| 4 | 5 | +0 h | SMS |
| 5 | 7 | +0 h | email |
| 6 | 14 | +0 h | SMS |

Cadence stops automatically when `lead/contacted` or `lead/disqualified` is received (see section 5).

---

## 4. Tuning via Tenant Settings

All values are stored on `tenant.settings` (JSONB). Savvy reads them at workflow-start with safe parsing — missing keys fall back to the documented defaults.

### `tenant.settings.speedToLead`

```json
{
  "firstTouchSlaMin": 3,
  "escalateMin": 10
}
```

| Key | Default | Meaning |
|-----|---------|---------|
| `firstTouchSlaMin` | `3` | Minutes after lead creation before `lead/contact-overdue` fires |
| `escalateMin` | `10` | Minutes after lead creation before reassignment escalation |

### `tenant.settings.leadCadence`

```json
{
  "steps": [
    { "dayOffset": 0, "hourOffset": 4, "channel": "email" },
    { "dayOffset": 1, "hourOffset": 0, "channel": "sms" },
    { "dayOffset": 3, "hourOffset": 0, "channel": "email" },
    { "dayOffset": 5, "hourOffset": 0, "channel": "sms" },
    { "dayOffset": 7, "hourOffset": 0, "channel": "email" },
    { "dayOffset": 14, "hourOffset": 0, "channel": "sms" }
  ],
  "quietHours": { "startHour": 21, "endHour": 8 }
}
```

| Key | Default | Meaning |
|-----|---------|---------|
| `steps` | 7-step sequence above | Array of `{ dayOffset, hourOffset, channel }` |
| `quietHours.startHour` | `21` (9 PM) | No outbound sends from this hour onward |
| `quietHours.endHour` | `8` (8 AM) | Sends resume at this hour |

Quiet-hours are evaluated in the **tenant's timezone** (sourced from `tenant.settings.finance.timezone`). A send scheduled inside quiet-hours is deferred to `endHour` of the next allowed day.

To add more aggressive follow-up, push additional steps (e.g., day 21, day 30). To lighten cadence, remove steps or reduce channels. Empty `steps` array → falls back to default.

---

## 5. Consent Model

**Phone number collected at intake = SMS consent recorded.**

When a lead is created with a phone number, `customer.sms_consent_at` is stamped to the current timestamp. This represents the homeowner's consent given at the point of submitting their contact information.

- SMS cadence steps are gated on `sms_consent_at != null && !sms_opt_out` (`shouldSendChannel` in `lead-followup.ts`).
- Email cadence steps are gated on `!email_opt_out` only (CAN-SPAM — no prior consent required for transactional/business-relationship email).

---

## 6. Opt-Out Handling

- **SMS opt-out:** Twilio webhook sets `customer.sms_opt_out = true`. All subsequent SMS cadence steps for that customer are skipped. The Inngest drip worker checks `shouldSendChannel` before each send.
- **Email opt-out:** Similar — `customer.email_opt_out = true` blocks email steps.

> **DNC (Do Not Call) registry:** Out of scope for v1. Tenants are responsible for DNC compliance on voice calls. Savvy does not call; it sends SMS/email only.

---

## 7. Cancel Events

The drip cadence Inngest workflow listens for two cancellation events:

| Event | Meaning | Effect |
|-------|---------|--------|
| `lead/contacted` | Rep logged first contact (or contact auto-detected) | Cadence terminates — no further drip steps fire |
| `lead/disqualified` | Lead marked lost/disqualified | Cadence terminates immediately |

Both events carry `{ leadId, tenantId }` and use `leadId` as the Inngest cancellation correlation key.
