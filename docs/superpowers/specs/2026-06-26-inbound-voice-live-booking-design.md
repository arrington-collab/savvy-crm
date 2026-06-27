# Inbound Voice Live Booking (Riley) — Design

**Date:** 2026-06-26
**Status:** Approved (design)
**Builds on:** `2026-06-25-instant-assign-live-schedule-design.md` (item 5 — AI/Vapi wiring of the shared intake-and-schedule service), `2026-06-24-voice-agent-design.md`.

---

## 1. Problem

When a prospect calls, the AI receptionist **Riley** should book the inspection **live on the call** — the same outcome the human quick-book screen already delivers. Today she can't:

- Inbound calls have **no `leadId` at call-start**. The lead is only created at `end-of-call-report`, so the mid-call `getRecommendedSlots`/`bookSlot` tools hit "no lead context" and bail.
- Riley collects no structured address, so even after a lead exists there's no **zip** to pick the territory rep.

The shared **intake-and-schedule service** (`recommendAssignee` · `slotsForRep` · `bookLeadSlot`, merged in #50/#51) already does the booking work. This feature wires Riley into it.

## 2. Live-config constraint (decisive)

The live Riley assistant (`010c08bc-…`) is a **static, pre-assigned** Vapi assistant: her `serverMessages` has **no `assistant-request`**, so Vapi never calls our webhook to *get* a per-call assistant config, and there is **no per-call metadata injection** for inbound. The instant-assign spec's "create the lead at call-start via `assistant-request` + inject `leadId` into metadata" therefore **does not apply** to inbound.

**Resolution:** correlate the lead to the **Vapi `call.id`** (present on every tool-call). The lead is created lazily on the first details tool-call and found by `call.id` on subsequent tool-calls within the same call.

## 3. Goals / Non-goals

**Goals:** Riley collects + confirms name/address/city/**zip**, the territory rep is recommended + assigned, two **today-first** slots are offered, and the chosen slot is booked — all mid-call, via the shared service.

**Non-goals (v1):**
- The specific-time "who's free at 4?" voice path — the human quick-book screen already has it; defer for inbound.
- Server-side geocoding — Riley confirms the 5-digit zip verbally and the tool validates it (no `GOOGLE_MAPS_SERVER_KEY` in prod; none required).
- Outbound voice-fallback flow — unchanged (it already injects `leadId`/`tenantId` in metadata).

## 4. Architecture

Extend the existing public webhook `apps/web/src/app/api/voice/vapi/route.ts`. No new route, no `assistant-request` handling. The tool-call handlers branch on context source:

```
Vapi tool-call ──▶ /api/voice/vapi
                     │  leadId = metadata.leadId            (outbound: unchanged)
                     │         ?? leadByCallId(tenantId, call.id)   (inbound: new)
                     ▼
   setCallDetails ─▶ resolve tenant by dialed number (tenantByPhone)
                     create-or-find lead for call.id (source inbound-call, dedupe)
                     validate zip (5 digits) → else re-ask
                     set property city/zip → recommendAssignee(zip) → assign rep
                     return 2 today-first slots (slotsForRep)
   bookSlot ───────▶ find lead (metadata.leadId ?? by call.id) → bookLeadSlot → mark contacted + emit appointment/booked
```

## 5. Components

### 5.1 Data model — `lead.voice_call_id`
New nullable `text("voice_call_id")` column on `lead` + an index. Lets the webhook create-once and find the inbound lead by Vapi `call.id` across tool-calls. Tenant-scoped reads (existing RLS on `lead`). One additive migration.

### 5.2 DB lifecycle — lead-by-call-id
- `setLeadVoiceCallId(tx, { tenantId, leadId, callId })` — stamp the call id when the inbound lead is created.
- `getLeadByVoiceCallId(tenantId, callId): Promise<{ id: string; assignedUserId: string | null; propertyId: string | null } | null>` — RLS-scoped lookup. Returns null when not found (first tool-call of a call).

### 5.3 Core — zip validation
`isValidZip(raw: string | null | undefined): boolean` (US 5-digit) in `packages/core` (pure, unit-tested). Used by `setCallDetails` to decide re-ask vs proceed.

### 5.4 Webhook tool handlers (`route.ts`)
- **`setCallDetails({ name, address, city, zip })`** — new tool. Resolve tenant by `toNumber`; if unmapped → graceful tool result ("a specialist will call you right back"). If `!isValidZip(zip)` → tool result `{ needZip: true }` instructing Riley to re-ask. Else: create-or-find the lead by `call.id` (via `createLeadForTenant` for create — dedupes customer/property — then `setLeadVoiceCallId`), `recommendAssignee(tenantId, { zip, city })`, `setLeadOwner(rep)`, return `slotsForRep({ tenantId, repId, todayFirst: true, limit: 2 })` labels. No rep configured → still create the lead, return a "specialist will call you" result.
- **`bookSlot({ startsAt, endsAt })`** — resolve `leadId = metadata.leadId ?? getLeadByVoiceCallId(...)`; `bookLeadSlot`; on success `markLeadContacted` + emit `appointment/booked`; on `slot_taken`/error return the existing guidance shape.
- **`getRecommendedSlots()`** — same `leadId` resolution; unchanged otherwise.
- **`end-of-call-report`** — look up the lead by `call.id` first; only create if still absent (early hang-up). No duplicate inbound lead.

### 5.5 Live Riley (Vapi API)
PATCH the live assistant (`VAPI_ASSISTANT_ID`) to (a) add the `setCallDetails` function tool, and (b) update the system prompt: collect + **read back and confirm** name, street address, city, and the **5-digit zip** before offering times, and call `setCallDetails` before `getRecommendedSlots`. Persona stays Riley; only the tool list + prompt change. (Done directly on live Riley per the rollout decision; verified via a follow-up GET on the assistant. A real test call is the operator's to place.)

## 6. Error handling & edge cases

| Situation | Behavior |
|---|---|
| Dialed number not mapped to a tenant | `setCallDetails` returns a graceful "a specialist will call you right back"; no lead. |
| Zip missing / not 5 digits | Tool result re-asks for the zip; no rep picked yet. |
| No territory rule matches the zip | `recommendAssignee` falls back to round-robin (built in). |
| No reps configured at all | Lead created, no rep; tool returns "a specialist will call you right back". |
| Slot taken between offer and book | `bookSlot` returns the existing retry guidance; lead persists. |
| Caller hangs up before `setCallDetails` | `end-of-call-report` creates the minimal lead (current behavior), found-by-call-id so no duplicate. |
| Outbound call (has `metadata.leadId`) | Unchanged — never uses the call-id path. |

## 7. Testing

- **Core unit:** `isValidZip` (5-digit yes; 4/6-digit, empty, null, "8520a" no).
- **DB integration:** `setLeadVoiceCallId` + `getLeadByVoiceCallId` round-trip; RLS (another tenant's call-id lookup returns null); the `voice_call_id` column migration applies.
- **E2E (`voice-webhook.spec.ts`):** POST a Vapi `tool-calls` payload (correct `x-vapi-secret`) for `setCallDetails` with a seeded tenant (mapped `inboundPhone`) + reps + a zip territory rule → assert a `lead` row exists for the call.id, assigned to the territory rep, and the tool result carries ≥1 slot. Then POST a `bookSlot` payload with a returned slot → assert a `scheduled` `appointment` row. Mirrors the existing webhook auth e2e + the quick-book DB-assertion pattern.
- **Live Vapi:** after the PATCH, GET the assistant and assert `setCallDetails` is in `model.tools` and the prompt mentions zip confirmation.

## 8. Deploy

One additive migration (`lead.voice_call_id`). Deploy chain = merge → apply the migration to prod Neon → `vercel --prod` → PATCH live Riley via the Vapi API → operator places a real test call.

## 9. Open questions

None blocking. (Geocoding and the specific-time voice path are explicitly deferred — §3.)
