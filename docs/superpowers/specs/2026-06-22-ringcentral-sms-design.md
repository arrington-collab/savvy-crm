# RingCentral SMS — env-selected telephony provider

**Date:** 2026-06-22
**Status:** Approved (design)
**Goal:** Send + receive SMS through RingCentral as an alternative to Twilio, selected by env. Twilio stays for voice and as the fallback.

## Why
Savvy's SMS today is Twilio-only (`twilioSms: SmsSender`), imported directly by four agent functions. The pilot's roofing company runs on RingCentral, so outbound texts (drip, booking, reminders, dunning) and inbound STOP/CANCEL should go through RingCentral — without losing Twilio (which still powers voice/call-capture and serves as a fallback).

## Scope
- **SMS only.** Voice/call-capture stays on Twilio (`/api/twilio/voice` unchanged).
- Provider is **env-selected** (`TELEPHONY_SMS_PROVIDER`), account-level (one Savvy RingCentral app + number), mirroring how Twilio is account-level.
- Outbound + inbound (STOP / CANCEL / opt-out). Lead-creation-from-SMS stays out of scope (same as Twilio).

## Architecture

### 1. `SmsSender` selector (`packages/integrations/src/comms.ts`, new; re-exported from `index.ts`)
```ts
export const sms: SmsSender =
  process.env.TELEPHONY_SMS_PROVIDER === "ringcentral" ? ringcentralSms : twilioSms;
```
Repoint the four consumers from `twilioSms` → `sms`:
- `packages/agents/src/functions/drip.ts` (the `SendDeps` default at the call site)
- `packages/agents/src/functions/lead-intake.ts`
- `packages/agents/src/functions/dunning.ts`
- `packages/agents/src/functions/appointment-reminders.ts`
The injected-dependency seams (e.g. `drip`'s `SendDeps`) are unchanged, so tests keep passing mocks.

### 2. Outbound adapter (`packages/integrations/src/ringcentral.ts`, new)
- `makeRingCentralSms(cfg: { serverUrl; clientId; clientSecret; jwt; from; fetchImpl? }): SmsSender` — factory for test injection (mirrors `makeResendEmail`).
- **Auth:** RingCentral **JWT auth flow** — `POST {serverUrl}/restapi/oauth/token` with `grant_type=jwt-bearer&assertion={jwt}` and HTTP Basic `clientId:clientSecret` → `{ access_token, expires_in }`. Cache the token in-module; refresh when within ~60s of expiry.
- **Send:** `POST {serverUrl}/restapi/v1.0/account/~/extension/~/sms` with `{ from: { phoneNumber: cfg.from }, to: [{ phoneNumber: to }], text: body }` → return `{ sid: response.id }` (RC message id).
- **Error:** non-2xx → throw `Error("ringcentral send failed: <status> <detail>")` (matches the Resend adapter's throw shape so callers' try/catch behaves identically).
- `export const ringcentralSms = makeRingCentralSms({ ...from env })`.
- A `makeFakeRingCentralSms()` (returns a synthetic id, no network) for dev/e2e when `TELEPHONY_SMS_PROVIDER=ringcentral` but no creds — keeps suites green (mirrors the fake-gateway pattern used by docuseal/companycam/roofr).

### 3. Inbound route (`apps/web/src/app/api/ringcentral/inbound/route.ts`, new)
- **Validation handshake:** RingCentral, when creating/renewing a webhook subscription, sends a request carrying a `Validation-Token` header. The route must echo it back in the `Validation-Token` response header with 200 and empty body.
- **Event parse:** RC posts JSON (not form-encoded). For each inbound SMS in the notification body (`body.body` shape: `{ ..., body: { from: { phoneNumber }, to: [{ phoneNumber }], subject } }` for message-store instant events), extract `to`, `from`, `text` (the message text is `subject` on message-store events).
- Resolve tenant via the existing `tenantByPhone(to)`; call the existing `handleInboundSms(t.id, { from, body, twilioSid: <rc message id> })`. (`handleInboundSms` is provider-agnostic — it only uses tenantId/from/body; `twilioSid` is an optional opaque provider message id stored on the `communication` row.)
- HMAC/verification: RC webhooks authenticate via a `verificationToken` you set at subscription time and RC echoes in a `Verification-Token` header — compare against `RINGCENTRAL_WEBHOOK_TOKEN` (fail-closed in prod when set, matching the repo's webhook posture).

### 4. Subscription setup (`packages/integrations/src/scripts/rc-subscribe.ts`, new; `pnpm rc:subscribe`)
- A one-time tsx script that creates the RC WebHook subscription: `POST /restapi/v1.0/subscription` with `eventFilters: ["/restapi/v1.0/account/~/extension/~/message-store/instant?type=SMS"]`, `deliveryMode: { transportType: "WebHook", address: "{APP_BASE_URL}/api/ringcentral/inbound", verificationToken: RINGCENTRAL_WEBHOOK_TOKEN }`.
- RC WebHook subscriptions expire (~7 days / on delivery failures). The script is re-runnable; document that renewal is manual for the pilot (a cron renewer is a follow-up, not pilot-blocking).

## Env (added to `.env.production.example` + `.env.example`)
```
TELEPHONY_SMS_PROVIDER=ringcentral        # unset/twilio = Twilio (default)
RINGCENTRAL_SERVER_URL=https://platform.ringcentral.com
RINGCENTRAL_CLIENT_ID=
RINGCENTRAL_CLIENT_SECRET=
RINGCENTRAL_JWT=
RINGCENTRAL_FROM_NUMBER=
RINGCENTRAL_WEBHOOK_TOKEN=                 # generated; echoed by RC for inbound verification
```

## Testing
- **Unit (`@savvy/integrations`):** `makeRingCentralSms` with a mock `fetchImpl` — (a) JWT token exchange request shape + caching (second send reuses token, doesn't re-auth), (b) send request body/URL/headers, (c) non-2xx throws. `makeFakeRingCentralSms` returns an id without network.
- **Inbound:** a unit/route test that feeds a sample RC message-store notification payload → asserts `handleInboundSms` is called with the right `{from, body}` (inject a spy), and that a `Validation-Token` request echoes the token.
- **No regression:** the four consumers still pass their existing tests (they use injected mocks / the `sms` selector defaults to Twilio when the env is unset).

## Out of scope / follow-ups
- RingCentral **voice** (call capture/recording/metering) — stays on Twilio for the pilot.
- Automated subscription **renewal cron** (manual `rc:subscribe` for the pilot).
- Per-tenant RingCentral (one Savvy RC account for the pilot).
- Renaming `communication.twilioSid` to a provider-neutral `providerSid` (cosmetic; deferred to avoid a migration here).
