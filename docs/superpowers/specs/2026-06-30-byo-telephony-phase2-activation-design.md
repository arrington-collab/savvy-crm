# BYO Telephony — Phase 2 (activate Twilio SMS + Vapi voice)

**Date:** 2026-06-30
**Status:** Approved (design)
**Depends on:** Phase 1 (PR #77) — `integration_connection` table, `tenant.telephony_mode`, `secret-box`, `resolveTelephonyCreds`, Twilio factories, settings UI.
**Goal:** Make `byo` tenants actually use their own credentials. Thread the Phase-1 resolver through the live SMS send path and Vapi voice (outbound + inbound), with **platform fallback** when a `byo` tenant is not actively connected. Behavior for `platform`-mode tenants and the existing global paths is unchanged.

## Why
Phase 1 stores and resolves per-tenant Twilio/Vapi credentials but does not route any live send — every outbound SMS still uses the global `sms`/`smsFrom` seam, and Vapi voice is still fully global. Phase 2 connects the resolver to the edges so a connected `byo` tenant sends texts from their own Twilio number and places/receives calls through their own Vapi assistant.

## Core policy decisions
- **Platform fallback (delivery over isolation):** when a `byo` tenant is `inactive` (not connected / disabled), sends fall back to Savvy's global platform account rather than being dropped. The resolver stays honest (`source:'inactive'`); the **fallback decision lives at the send/receive edge**, one place per channel.
- **Resolver contract unchanged** from Phase 1. Phase 2 adds new resolve functions for voice but does not alter `resolveTelephonyCreds`.
- **Prod safety:** every existing `platform`-mode tenant (incl. live tenant Bloom) and the existing global inbound path behave exactly as today. All new behavior is gated on a `byo`+active connection.

## Architecture

### A. SMS send-path activation (Twilio)
Today every outbound caller imports a module-level `sms: SmsSender` and `smsFrom()` from `@savvy/integrations` (`comms.ts`). Phase 2 makes sending tenant-aware:
- New helper `getTenantSms(tenantId): Promise<{ sender: SmsSender; from: string }>` (location: a thin composition layer that may import both `@savvy/db` resolver and `@savvy/integrations` factories — likely `packages/agents` or a new `apps/web`/agents-side helper; the plan picks the exact home to avoid a package cycle). Logic:
  - `resolveTelephonyCreds(tenantId)` → `source:'tenant'` → `makeTwilioSms(creds)` + `creds.from`.
  - `source:'platform'` OR `source:'inactive'` → the global platform sender + `smsFrom(env)` (today's behavior). **This is the single fallback point.**
  - Guard: if a resolved `tenant` creds bag has empty `accountSid` or empty `from` (possible from a managed-setup placeholder row), treat as platform fallback (do not attempt a send with empty creds).
- Thread `tenantId` through the ~7 SMS call sites (drip, lead-intake, lead-cadence, dunning, appointment-reminders, lead-speed-to-lead, the Vapi route's SMS send). Each already has a `tenantId` in scope. The existing injected-dependency seams (e.g. `drip`'s `SendDeps`) are preserved so tests keep injecting mocks.

### B. Voice connect UI + Vapi outbound
Extend `integration_connection` to `provider='vapi'`:
- secret (sealed) = `{ apiKey: string }`.
- metadata (non-secret) = `{ assistantId: string; phoneNumberId: string }`.
- New lifecycle fns mirroring the Twilio ones: `upsertVapiConnection`, `getVapiSecret`, `getVapiConnection` (returns status + assistant/phone ids, never the apiKey), and `resolveVoiceCreds(tenantId): { source:'platform'|'tenant'|'inactive'; vapi:{ apiKey; assistantId; phoneNumberId } }` (platform branch returns env `VAPI_*`).
- **Settings UI:** the telephony card gains a Vapi section (API key + assistant id + phone-number id + Test connection). Test = a cheap authenticated Vapi API call (e.g. GET assistant) → set status active.
- **Outbound:** the Vapi gateway becomes a factory `makeVapiClient(creds)`; the outbound caller (Riley speed-to-lead `placeOutboundCall`) resolves the tenant's Vapi when `byo`+active, else platform fallback. The existing `voice`/`httpVapi` env export is preserved as the platform path.

### C. Inbound Vapi routing
Today the inbound Vapi webhook resolves the tenant by the called/inbound number. For BYO, a tenant points **their own** Vapi assistant's server URL at Savvy's webhook, so the inbound payload carries the tenant's `assistantId`/`phoneNumberId`, not a Savvy-owned number.
- New reverse lookup `tenantByVapiAssistant(assistantId: string): Promise<string | null>` — an `adminDb` query over `integration_connection` where `provider='vapi'`, `status='active'`, and `metadata->>'assistantId' = assistantId`. (May also match on `phoneNumberId` as a fallback key.)
- The inbound route resolves the tenant as: **BYO assistant match first**, else fall through to **today's platform resolution** (called-number lookup). So existing inbound (Bloom) is untouched.
- **Webhook auth:** the shared `VAPI_WEBHOOK_SECRET` stays the verification header — the tenant configures Savvy's webhook URL + that shared secret in their Vapi assistant. Tenant identity comes from the `assistantId` in the verified payload, not from the secret. (Per-tenant webhook secrets are a later hardening option.)

### D. Backward-compatibility / prod safety
- No change to `resolveTelephonyCreds` or to the `platform` send/inbound paths.
- New `provider='vapi'` rows are opt-in; absent a Vapi connection, voice behaves exactly as today (global).
- **Optional onboarding nudge (off by default):** if a `byo` tenant is silently riding platform fallback (mode=byo but no active connection), surface a non-blocking onboarding hint to finish connecting. Not the Exception Queue (per the product choice to prioritize delivery). Behind a flag; ships dormant.

### E. Testing
- **Per SMS call site:** `byo`-active → tenant creds + tenant `from`; `byo`-inactive AND `platform` → platform sender + platform `from`; empty-creds placeholder → platform fallback. Assert via injected mock `SmsSender` (which creds/from were used).
- **`getTenantSms` unit test:** the three branches + the empty-creds guard.
- **Voice:** `resolveVoiceCreds` three branches; `makeVapiClient` shape + an injected-fetch verify test; outbound caller uses tenant Vapi when active else platform.
- **Inbound:** `tenantByVapiAssistant` returns the right tenant and is cross-tenant safe (RLS-bypass query but matched by exact assistant id); inbound route test — BYO assistant resolves the correct tenant, unknown assistant falls through to platform resolution.
- RLS unchanged; existing telephony + voice tests stay green.

## Implementation split (two plans)
1. **Plan 2a — Outbound activation** (build first): SMS send-path threading + `getTenantSms`/tenant-aware `smsFrom` + the empty-creds guard + Vapi connect UI + `resolveVoiceCreds`/`makeVapiClient` + Vapi outbound, all with platform fallback. Self-contained and immediately useful; does not touch live inbound.
2. **Plan 2b — Inbound Vapi routing** (build second): `tenantByVapiAssistant` reverse lookup + the inbound webhook tenant-resolution change (BYO-first, platform fallthrough). Isolated because it touches the live inbound path.

## Assumptions
- All ~7 SMS call sites are threaded in Plan 2a (mechanical but broad); each already has `tenantId` in scope.
- Vapi secret shape = `{ apiKey }`; `assistantId`/`phoneNumberId` are non-secret metadata.
- One Vapi connection per tenant (one assistant); the reverse lookup is unique on `assistantId`.
- The composition helper `getTenantSms` lives where it can import both the db resolver and the integrations factory without creating a package cycle (the plan resolves the exact location).

## What's missing / a domain expert would challenge
- **Per-tenant webhook secrets:** Phase 2 uses the shared `VAPI_WEBHOOK_SECRET`; a malicious tenant who learns it cannot impersonate another tenant (identity is by assistant id), but per-tenant secrets are stronger — deferred.
- **Empty-creds placeholder rows** (from managed-setup) must never produce a failed send — the empty-creds guard in `getTenantSms`/voice resolution is the safeguard; the plan must test it explicitly.
- **RingCentral** BYO is still out of scope (platform-only) — a later phase.
- **Number provisioning / A2P 10DLC** remain the tenant's responsibility (or the managed flow).
