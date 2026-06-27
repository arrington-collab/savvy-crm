# Voice Agent (Vapi) — Setup

Phase D ships **fail-open**: with no `VAPI_API_KEY`, outbound calls no-op and the
webhook is inert but deployable. To turn it on (Brett's hands):

1. **Vapi account** → create ONE shared assistant. Leave brand/persona generic; Savvy
   injects tenant brand + lead context per call via `assistantOverrides`. This base
   assistant owns the **voice engine** (TTS provider/voice + transcriber + turn-taking) —
   see "Voice quality" below.
2. **Assistant server URL** → `https://<your-app>/api/voice/vapi`. Add a custom header
   `x-vapi-secret: <VAPI_WEBHOOK_SECRET>` (or configure Vapi to send it).
3. **Tools** — Savvy pushes the tool defs per-call via overrides (outbound:
   `buildAssistantOverrides`; inbound: `buildInboundAssistant`). The webhook handles
   `setCallDetails({name,address,city,zip})` (inbound only — creates+assigns the lead and
   returns slots), `getRecommendedSlots` (no args), and `bookSlot({startsAt,endsAt})`.
4. **Phone number (inbound = code-driven)** → buy/import a number in Vapi, note its
   `phoneNumberId`. Set the number to **Server-URL mode** — i.e. do NOT pin it to a static
   assistant. Point its server URL at `https://<your-app>/api/voice/vapi`. On each inbound
   call Vapi sends an `assistant-request`; the webhook resolves the tenant by the dialed
   number and returns `{ assistantId, assistantOverrides }` for an upbeat Riley that books
   the inspection **live on the call** (collect+confirm name/address/city/zip →
   `setCallDetails` → offer slots → `bookSlot`). No hand-editing the dashboard prompt.
5. **Per-tenant inbound** → set each tenant's `tenant.inboundPhone` to the number whose
   calls should create leads for that tenant (the webhook resolves the tenant by the dialed
   number via `tenantByPhone`). If no tenant matches, the webhook returns an `error` and
   Vapi plays a generic failure — so always map the number.
6. **Env** (Vercel prod) → `VAPI_API_KEY`, `VAPI_ASSISTANT_ID`, `VAPI_PHONE_NUMBER_ID`,
   `VAPI_WEBHOOK_SECRET`. Redeploy + re-register Inngest.

## Voice quality (the "choppy / sounds unsure" knobs)

The persona **wording** (upbeat, confident, no "um/uh", repeat-back, spell uncommon names)
lives in code (`buildInboundAssistant` / `buildAssistantOverrides`) and ships with the app.
But how Riley *sounds* — choppiness, latency, interrupting — is the **Vapi voice engine** on
the base assistant, not code. If she still sounds choppy after this change, tune on the base
assistant in the Vapi dashboard:
- **Voice/TTS** → pick a natural, warm voice (e.g. an ElevenLabs conversational voice).
  Savvy only overrides `voice.speed` (1.0 inbound / 1.05 outbound); provider + voiceId come
  from the base assistant.
- **`stopSpeakingPlan` / `startSpeakingPlan`** (endpointing) → raise the silence threshold so
  Riley doesn't cut in or clip; this is the usual cause of "choppy" turn-taking.
- **Transcriber** → a faster/cleaner transcriber (e.g. Deepgram nova) reduces mid-sentence
  restarts that read as hesitation.

Reference pattern: bresco-legal already runs a Vapi assistant (`~/Sites/bresco-legal`) —
same webhook/secret shape; Savvy gets its own account + number.

## Behavior
- **Outbound fallback**: on `lead/contact-overdue` (3-min SLA breach), `voiceFallback` calls
  the lead IF open + uncontacted + has phone + SMS consent + outside quiet hours (tenant tz).
- **Inbound receptionist**: a call to a tenant's number triggers an `assistant-request` →
  Savvy returns an upbeat Riley that collects+confirms name/address/city/zip, creates the
  lead (`source: "inbound-call"`) and assigns the territory rep via `setCallDetails`, then
  books live with `bookSlot`. The end-of-call report only backfills a bare lead if the caller
  hung up before details were captured.
- **Outcome**: `lead.voice_outcome` (booked/no_answer/callback/dnc/needs_human) + full
  transcript in `communication` (channel `call`).
