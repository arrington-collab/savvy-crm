# Voice Agent (Vapi) — Setup

Phase D ships **fail-open**: with no `VAPI_API_KEY`, outbound calls no-op and the
webhook is inert but deployable. To turn it on (Brett's hands):

1. **Vapi account** → create ONE shared assistant. Leave brand/persona generic; Savvy
   injects tenant brand + lead context per call via `assistantOverrides`.
2. **Assistant server URL** → `https://<your-app>/api/voice/vapi`. Add a custom header
   `x-vapi-secret: <VAPI_WEBHOOK_SECRET>` (or configure Vapi to send it).
3. **Tools** — the assistant calls `getRecommendedSlots` (no args) and
   `bookSlot({startsAt,endsAt})`; both are handled by the webhook. The full tool defs are
   also pushed per-call via overrides (`buildAssistantOverrides`).
4. **Phone number** → buy/import a number in Vapi, note its `phoneNumberId`. Route inbound
   calls for that number to the shared assistant.
5. **Per-tenant inbound** → set each tenant's `tenant.inboundPhone` to the number whose
   calls should create leads for that tenant (the webhook resolves the tenant by the dialed
   number via `tenantByPhone`).
6. **Env** (Vercel prod) → `VAPI_API_KEY`, `VAPI_ASSISTANT_ID`, `VAPI_PHONE_NUMBER_ID`,
   `VAPI_WEBHOOK_SECRET`. Redeploy + re-register Inngest.

Reference pattern: bresco-legal already runs a Vapi assistant (`~/Sites/bresco-legal`) —
same webhook/secret shape; Savvy gets its own account + number.

## Behavior
- **Outbound fallback**: on `lead/contact-overdue` (3-min SLA breach), `voiceFallback` calls
  the lead IF open + uncontacted + has phone + SMS consent + outside quiet hours (tenant tz).
- **Inbound receptionist**: a call to a tenant's number hits the shared assistant → books via
  the engine; the end-of-call report creates a lead-from-call.
- **Outcome**: `lead.voice_outcome` (booked/no_answer/callback/dnc/needs_human) + full
  transcript in `communication` (channel `call`).
