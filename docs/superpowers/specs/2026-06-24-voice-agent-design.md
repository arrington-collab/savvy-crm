# Phase D — AI voice agent (Vapi): inbound receptionist + outbound 3-min fallback (design)

**Date:** 2026-06-24
**Branch:** `feat/voice-agent` (worktree `~/Sites/savvy-phased`, off `origin/main` @ `dc6b5d9`)
**Pipeline context:** Phase D (final) of the Lead Intake Pipeline — **Stage 6**. Closes the loop by consuming the `lead/contact-overdue` event Phase C emits, and adds a 24/7 inbound receptionist. The only fully net-new build of the pipeline.

---

## Goal

An AI voice agent (Vapi) that, in two modes, books the inspection (or warm-hands to a rep):
1. **Outbound fallback** — when the 3-minute speed-to-lead SLA breaches (`lead/contact-overdue`), call the lead.
2. **Inbound receptionist** — 24/7 answer, lightly qualify, book; create a lead-from-call.

Deterministic triggers/guards; the LLM lives entirely inside the Vapi assistant (the conversation). The booking goes **through the scheduling engine** (Phase A) — never invented times. The integration is **fail-open**: no `VAPI_API_KEY` → outbound no-ops, the webhook is inert but deployable.

---

## Decisions locked (from brainstorming)

- **Scope:** BOTH inbound + outbound, built on ONE shared webhook (~80% shared code).
- **Assistant config:** ONE shared Vapi assistant; per-call `assistantOverrides` inject tenant brand + persona + guardrails + tools + lead context. Cleanly multi-tenant.
- **Outcome storage:** `lead.voice_outcome` column (queryable) + full transcript in `communication` (channel `'call'`).
- **Booking authority:** book LIVE via the engine (`getRecommendedSlots` + the `confirmSlot` flow) AND fall back to texting the self-schedule link on no-answer.
- **Quiet-hours:** outbound voice calls **honor quiet-hours** (a 2am breach does not call — TCPA; the cadence still nurtures). Inbound is caller-initiated (always allowed).
- **Vapi is an external "your hands" dependency** (account + assistant + phone number + webhook secret); code fail-open.
- **Persona:** identifies as the **tenant's** company (not a fixed brand); goal = book or warm-hand; guardrails = TCPA/quiet-hours/DNC, no pricing, no deductible/insurance-fraud talk, hand-to-human on anything complex/insurance-heavy.

---

## What exists (reuse)

| Piece | Location | Use |
|---|---|---|
| `lead/contact-overdue` event | Phase C (`client.ts`) | Outbound trigger |
| `getRecommendedSlots(leadId, opts)` → `{slots:[{startsAt,endsAt,driveMinutes}]}` | `apps/web/src/lib/recommended-slots.ts` | The agent's slot tool |
| `confirmSlot(token, startsAt, endsAt)` = `convertLeadToJob` → `bookAppointment` → emit `appointment/booked` | `apps/web/src/lib/booking-action.ts` | Live booking (factor a token-less `bookLeadSlot(leadId, startsAt, endsAt)` from it) |
| `bookAppointment` | `packages/db/src/lifecycle/appointments.ts` | (via confirmSlot flow) |
| `communication` table (channel `'call'`, `transcript`, `recordingUrl`, `durationSeconds`) | `packages/db/src/schema/comms.ts` | Transcript log — **no migration** for this |
| `COMM_CHANNEL = ["call","sms","email"]` | `packages/core/src/enums.ts` | `'call'` already valid |
| `tenantByPhone(to)` | `apps/web/src/lib/intake.ts` | Inbound tenant resolution |
| `createLeadForTenant` (dedupe + consent, Phase B/C) | `apps/web/src/lib/intake.ts` | Inbound lead-from-call |
| Twilio voice route (after-hours voicemail) | `apps/web/src/app/api/twilio/voice/route.ts` | Pattern reference (NOT replaced; Vapi is the new path) |
| quiet-hours `nextAllowedSendTime` / `isWithinQuietHours` + tenant tz (finance config) | `@savvy/core` | Outbound quiet-hours gate |
| `shouldSendChannel`-style consent/opt-out gate | Phase C | Outbound consent/DNC gate |
| External-gateway fail-open pattern | `stormproof.ts` / `distance.ts` / Phase C | Mirror for `vapi.ts` |

---

## Components

### 1. Vapi gateway — `packages/integrations/src/vapi.ts` (new)

Mirrors the env-or-fake fail-open pattern.

```ts
export type AssistantOverrides = {
  firstMessage: string;
  model: { provider: string; model: string; messages: { role: "system"; content: string }[]; tools?: unknown[] };
  variableValues?: Record<string, string>;
};
export interface VoiceGateway {
  // Places an outbound call. Returns the provider call id, or null on no-key/error (fail-open).
  placeOutboundCall(o: { toPhone: string; assistantOverrides: AssistantOverrides; metadata: Record<string, string> }): Promise<{ callId: string } | null>;
}
```
- `httpVapi`: POST `https://api.vapi.ai/call` with `VAPI_API_KEY` (Bearer), `phoneNumberId: VAPI_PHONE_NUMBER_ID`, `assistantId: VAPI_ASSISTANT_ID`, `assistantOverrides`, `customer.number: toPhone`, `metadata`. Returns `{callId}` or `null` on `!ok`/throw.
- `makeFakeVoice()`: records calls, returns a deterministic `{callId:"fake-..."}`. Active when `VAPI_API_KEY` unset.
- Singleton `voice` selects by env. Export from the integrations barrel.

### 2. Persona / overrides builder — `packages/core/src/voice-persona.ts` (new, pure)

```ts
export type VoiceLeadContext = { tenantName: string; leadName: string; address: string; stormContext: string | null; leadId: string; tenantId: string };
export function buildAssistantOverrides(ctx: VoiceLeadContext): AssistantOverrides; // first message + system prompt + tool defs + guardrails
export function parseVoiceOutcome(raw: string | null | undefined): "booked" | "no_answer" | "callback" | "dnc" | "needs_human" | null;
```
- System prompt: identify as **`${tenantName}`'s** scheduling assistant; goal = book a free roof inspection or warm-hand to a rep; cite storm context if present; **guardrails** (verbatim, testable): no pricing/quotes, no deductible or insurance-fraud language, comply with TCPA/quiet-hours/DNC, hand to a human on request or anything complex/insurance-heavy.
- Tool defs: `getRecommendedSlots` (no args; resolves from call metadata leadId) and `bookSlot({ startsAt, endsAt })`.
- Pure + unit-tested (prompt contains tenant name + guardrail phrases; `parseVoiceOutcome` maps Vapi's structured-outcome string → the enum, default `null`).

### 3. Webhook — `apps/web/src/app/api/voice/vapi/route.ts` (new)

- **Auth:** constant-time compare `x-vapi-secret` header to `requireSecret("VAPI_WEBHOOK_SECRET")`. Reject otherwise.
- **`message.type === "tool-calls"` (or `function-call`):** read `metadata.leadId`/`tenantId` from the call; dispatch:
  - `getRecommendedSlots` → call the action, return the top slots as the tool result.
  - `bookSlot` → `bookLeadSlot(leadId, startsAt, endsAt)` (factored from `confirmSlot`), return success/slot-taken.
  Respond synchronously in Vapi's tool-result shape.
- **`message.type === "end-of-call-report"`:** in a tenant-scoped tx:
  - insert a `communication` (channel `'call'`, direction per inbound/outbound, `transcript`, `recordingUrl`, `durationSeconds`, `twilioSid`=Vapi call id).
  - set `lead.voice_outcome = parseVoiceOutcome(report.analysis.structuredData?.outcome)`.
  - **inbound only** (no `metadata.leadId`): resolve tenant by called number (`tenantByPhone`), `createLeadForTenant` from the caller (phone + any captured name/address; source `"inbound-call"`), set its `voice_outcome`.
  - on `no_answer` with a phone: emit a `lead/contacted`-independent SMS with the booking link (reuse the Phase C link builder) — best-effort.
- `runtime = "nodejs"`. All writes tenant-scoped; fail-open on send errors.

### 4. Outbound-fallback workflow — `packages/agents/src/functions/voice-fallback.ts` (new)

- Inngest on `lead/contact-overdue`, `cancelOn: [{event:"lead/contacted", match:"data.leadId"}]`.
- `step.run("guard")`: reload lead+customer+property+tenant; proceed only if lead OPEN + `first_rep_contact_at` null + phone present + `shouldSendChannel("sms"-equivalent consent/opt-out)` true + **not within quiet-hours** (tenant tz). Else return a skip reason.
- `step.run("place-call")`: build `buildAssistantOverrides(ctx)` (tenant name, lead name/address, storm context from `scoreFeatures`), `voice.placeOutboundCall({toPhone, assistantOverrides, metadata:{leadId,tenantId,direction:"outbound"}})`; log a `communication` (channel `'call'`, direction `outbound`) attempt + `recordAgentRun("lead.voice.fallback")`. Fail-open: a `null` (no Vapi key) records a skipped attempt, no throw.
- Register in `packages/agents/src/index.ts`.

### 5. Migration

```sql
ALTER TABLE "lead" ADD COLUMN "voice_outcome" text;
```
Nullable. Transcript reuses `communication` (no migration). Ship `.sql` + drizzle meta together.

### 6. UI sliver (optional, thin)

Surface `lead.voice_outcome` as a small badge on the lead detail (reuse the band-chip styling). Read-only; include only if it doesn't bloat the phase.

---

## Data flow

```
lead/contact-overdue (Phase C)
  → voiceFallback: guard (open + uncontacted + phone + consent + NOT quiet-hours)
       → voice.placeOutboundCall(overrides w/ tenant brand + lead/storm ctx + tools)   [fail-open]
       → log call-attempt comm + agentRun                     [cancelOn lead/contacted]

Vapi (mid-call)  → POST /api/voice/vapi {type:"tool-calls"} → getRecommendedSlots / bookSlot → result
Vapi (call end)  → POST /api/voice/vapi {type:"end-of-call-report"}
       → log transcript (communication channel='call') + set lead.voice_outcome
       → inbound: tenantByPhone → createLeadForTenant → voice_outcome
       → no_answer: text booking link (best-effort)

Inbound caller → tenant Vapi number → shared assistant (server URL = our webhook) → above end-of-call path
```

---

## Error handling

- **No `VAPI_API_KEY`:** gateway returns `null`; fallback records a skipped attempt; webhook still serves (inert). No throw, nothing blocks.
- **Webhook bad/no secret:** 401, no side effects.
- **Tool-call for a missing/closed lead:** return a graceful "no slots / can't book" tool result (the agent warm-hands).
- **Booking race (slot taken):** `bookLeadSlot` surfaces `SlotTakenError` → tool result tells the agent to offer another slot.
- **Quiet-hours at breach time:** skip the call (logged), don't defer-spam; cadence continues.
- **Inngest:** guards + place-call are steps (idempotent); a retry must not double-dial — key the place-call step so a duplicate is memoized.

---

## Compliance

- Outbound honors **quiet-hours** (tenant tz) + **consent/opt-out** (no call to an opted-out/non-consented number) + DNC (reuse the consent gate; external DNC registry still out of scope).
- Persona guardrails (no pricing, no deductible/fraud talk, hand-to-human) are in the system prompt AND should be reinforced by the Vapi assistant's base config.
- Inbound is caller-initiated (quiet-hours N/A).

---

## Testing

Pure unit (local-gated):
- `buildAssistantOverrides`: system prompt contains the tenant name + each guardrail phrase; tool defs present; storm context included when given, omitted when null.
- `parseVoiceOutcome`: each Vapi outcome string → enum; unknown/empty → null.
- `vapi` fake: `placeOutboundCall` returns a callId; null when the gateway is the http one without a key (simulate via the fake's contract).
- the outbound guard predicate (open + uncontacted + phone + consent + not-quiet-hours) as a pure helper.

CI-gated (DB / route):
- webhook auth (bad secret → 401); `end-of-call-report` logs a `communication` + sets `voice_outcome`; inbound report creates a lead.
- `bookLeadSlot` books via convert→bookAppointment and emits `appointment/booked`.
- voiceFallback: a quiet-hours breach skips the call; a daytime breach with consent places it (fake gateway); no phone / opted-out → skip.

---

## Config dependency (Brett's hands — non-blocking, fail-open)

`VAPI_API_KEY`, `VAPI_ASSISTANT_ID`, `VAPI_PHONE_NUMBER_ID`, `VAPI_WEBHOOK_SECRET` — a Vapi account + ONE shared assistant whose **server URL points at `/api/voice/vapi`** + a phone number (per tenant: set `tenant.inboundPhone` and route that number's calls to the assistant). Until set, outbound no-ops and the webhook is inert. Document all four in `.env.example`. (Bresco-legal already runs a Vapi assistant — its webhook/secret pattern is the reference, but Savvy gets its own account/number.)

---

## Out of scope

- External DNC-registry scrubbing (consent/opt-out gating only).
- Per-tenant Vapi assistants (one shared assistant + per-call overrides).
- Voicemail transcription beyond what Vapi returns.
- Real-time call analytics dashboard (outcome badge only).
- Replacing the existing Twilio voicemail route (left as-is).

---

## Self-review

- **Placeholders:** none; every component names its file + signature + the Vapi message types.
- **Consistency:** the outbound `metadata.leadId` is what the webhook's tool-calls read; `lead.voice_outcome` is written by both the end-of-call path and `parseVoiceOutcome`; booking reuses the existing convert→book flow (no invented times); quiet-hours/consent gating matches Phase C's helpers.
- **Scope:** large but one coherent Stage-6 slice; one shared webhook serves both modes; DNC/per-tenant-assistant/dashboard deferred; UI is an optional badge.
- **Ambiguity:** the quiet-hours-skips-outbound rule, the fail-open-on-no-key behavior, the one-shared-assistant + per-call-override model, and the outcome enum values are all pinned.
