# Rep Alert + 1-Minute Speed-to-Lead Escalation — Design

**Date:** 2026-06-26
**Status:** Approved (design), pending spec review
**Builds on:** the existing `lead-speed-to-lead` Inngest workflow + `voice-fallback` (AI call), `lead/contacted` / `lead/contact-overdue` events.

---

## 1. Problem

When a lead arrives **not** via a phone call (web form, manual entry, etc.), nobody is alerted to call it fast. Today the only escalation is a silent 3-minute first-touch timer that, if no rep logs contact, has the AI (Riley) call the homeowner. Speed-to-lead is the company's motto, and a human should get the first shot — immediately, with a one-tap way to dial.

**Goal:** the moment a non-call lead lands, text the assigned rep "call now" with a tap-to-call link to the homeowner. If the rep doesn't react within **1 minute**, the AI places the call. Reps don't have a phone number stored today, so we add one.

## 2. Decisions (locked with the user)

- **Timer:** 1 minute from rep alert to the AI call. This rep-alert flow **replaces** the old 3-minute first-touch trigger for non-call leads.
- **No rep / no phone on file:** still wait the 1 minute, then the AI calls (uniform timing). The rep SMS is simply skipped.
- **Both messages fire:** the homeowner still gets the booking SMS at intake **and** the rep gets the "call now" alert.
- **"Rep reacted" (v1):** detected via the existing `lead/contacted` event — the rep hits **Log Contact** or the homeowner replies by SMS. If the rep only taps the `tel:` link and dials, that isn't detected yet (the AI may still call ~1 min later). Twilio "rep actually dialed" detection is a deliberate later add.
- **Scope:** applies to **non-call leads only** (lead `source !== "inbound-call"`). Inbound callers already engaged a human/Riley, so they don't get the rep-alert path.

## 3. Non-goals

- Twilio outbound-dial detection (auto-cancel when the rep actually calls) — later.
- Rep-alert quiet-hours gating — the rep alert sends any time (internal staff); the *AI call* to the homeowner remains quiet-hours-guarded by the existing `voice-fallback` check.
- Push/app notifications to the rep — SMS only for v1.
- Changing the ~10-minute reassign-to-another-rep escalation (stays as-is).

## 4. Approach — extend `lead-speed-to-lead` (one workflow owns speed-to-lead)

Rather than a second function racing the existing one, add a rep-alert step to the workflow that already owns this lifecycle. It already triggers on `lead/created`, cancels on `lead/contacted` / `lead/disqualified`, checks the assigned rep, and hands off to the AI call. We insert one step and shorten one timer.

### 4.1 Modified flow (`packages/agents/src/functions/lead-speed-to-lead.ts`)

1. **New step `alert-rep`** (runs first, best-effort): load the lead's assigned rep + the lead's `source`, customer name/phone, and property city. If `source !== "inbound-call"` **and** the assigned rep has a `phone`, send the rep an SMS (see §6). If no rep or no phone, do nothing and continue.
2. **First-touch wait:** sleep for the first-touch SLA, now **1 minute** (was 3). (Implemented by changing the `firstTouchSlaMin` default to `1`.)
3. **Escalate to AI:** if the lead is still uncontacted (`firstRepContactAt == null`) and has an assigned rep, emit `lead/contact-overdue` → the existing `voice-fallback` places the AI call (already guards open-status, consent, quiet hours).
4. **(unchanged)** Reassign-to-another-rep escalation around the ~10-minute mark.

The function's existing `cancelOn` (`lead/contacted`, `lead/disqualified`) already aborts the whole thing if the rep reacts in the 1-minute window — no new cancel logic needed.

### 4.2 Why not a new function

A separate `lead-rep-alert` function would duplicate the trigger, the cancel-on-contact wiring, and the assigned-rep lookup, and would race the existing timer. Extending the existing one is DRY and removes the double-fire risk.

## 5. Data model + UI

- **`user.phone`** — new nullable column (E.164 string), one migration. Reuse `@savvy/core` `normalizePhone` for storage.
- **Rep self-service:** add a phone field to the rep's own profile/settings page.
- **Admin:** allow setting a rep's phone in team settings (admin-gated, same pattern as existing team management).

## 6. The rep-alert SMS

A pure builder in `@savvy/core` (e.g. `buildRepAlertSms`), so it's unit-testable and consistent:

```
New lead: {firstName}{ in {city}} — call now, speed to lead matters. Tap to call: {tel:+1XXXXXXXXXX}
```

- `{tel:…}` is the **homeowner's** number as a `tel:` link so the rep taps once to dial.
- City is included only when known.
- Kept under one SMS segment.
- Sent through the existing `sms` gateway (RingCentral/Twilio, env-selected), best-effort (a send failure must not fail the workflow).

## 7. Edge cases

| Situation | Behavior |
|---|---|
| No assigned rep | Skip the rep SMS; still wait 1 min → AI call (if a rep gets assigned later, the lead is no longer "unassigned" at escalation; existing assigned-rep check governs). |
| Assigned rep has no phone | Skip the rep SMS; still wait 1 min → AI call. |
| Inbound-call lead | No rep-alert step (gated by source); existing behavior. |
| Rep reacts within 1 min | `lead/contacted` fires → workflow cancels; no AI call. |
| Quiet hours | Rep SMS still sends; AI call suppressed by the existing `voice-fallback` guard. |
| SMS send fails | Logged, swallowed; the timer + AI escalation still run. |

## 8. Testing

- **Unit (`packages/core`):** `buildRepAlertSms` — name/city/tel formatting, city-omitted case, segment length.
- **Integration (`packages/agents`):** the modified `lead-speed-to-lead` — (a) non-call lead with a rep+phone sends the rep SMS then escalates after the wait; (b) no-phone rep skips the SMS but still escalates; (c) inbound-call lead skips the rep SMS; (d) `lead/contacted` within the window cancels (no escalation). Mirror the existing speed-to-lead test setup; inject a fake SMS sender to assert the rep message.
- **DB:** migration applies the `user.phone` column; no RLS change (column on an existing tenant-scoped table).

## 9. Sequencing

1. `user.phone` migration + `@savvy/core buildRepAlertSms` (+ unit test).
2. Modify `lead-speed-to-lead`: rep-alert step + 1-minute SLA (+ agents test).
3. Rep-phone UI (self-service profile + admin team settings).

## 10. Open questions

None blocking. (Twilio dial-detection and rep-alert quiet-hours gating are explicitly deferred — §3.)
