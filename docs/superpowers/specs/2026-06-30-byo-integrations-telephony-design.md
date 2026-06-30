# BYO Integrations — per-tenant telephony credentials + managed setup

**Date:** 2026-06-30
**Status:** Approved (design) — re-baselined on current `main`
**Goal:** Let each tenant bring their own telephony credentials (Twilio / RingCentral / Vapi), stored encrypted per-tenant, with an optional "we'll set it up for you for a fee" managed flow. Build it on a reusable `integration_connection` framework so future integrations slot in the same way. Default every existing tenant to the platform account so production (Bloom) is untouched.

## Why
Savvy is multi-tenant SaaS — each tenant is a different roofing company. Today telephony is **global, single-account**: Twilio, RingCentral, and Vapi all read one set of `process.env` credentials, and tenant isolation is done only by phone-number routing (`tenant.inboundPhone`). That means every tenant rides Savvy's one Twilio/Vapi account — Savvy fronts the cost and carries the A2P/10DLC compliance liability, and outbound SMS even sends from a single shared global number.

Per-tenant business systems (QuickBooks, CompanyCam, Gmail, Google Calendar) are **already per-tenant** via Nango/Stripe-Connect, with connection ids stored as columns on the `tenant`/`user` rows. Telephony is the gap. The product decision: **BYO by default, with a managed "we'll set it up for you for a fee" option** for tenants who don't want to deal with Twilio/10DLC themselves.

## Scope
- **Telephony providers:** Twilio (SMS + voice/capture), RingCentral (SMS), Vapi (voice agent). Twilio is the reference provider built end-to-end first; RingCentral + Vapi follow the identical shape.
- **Reusable framework:** a generic `integration_connection` table + capability resolver, designed so non-telephony providers (e-sign, email-relay, etc.) can be added later without a rewrite. Only telephony providers are wired in v1.
- **Per-tenant policy flag:** `tenant.telephony_mode` (`platform` | `byo`) decides whether a tenant uses Savvy's shared account or their own credentials.
- **Managed setup flow:** a "Have Savvy set this up" request marked on the connection row.
- **Outbound-sender fix:** in BYO mode, outbound SMS sends from the tenant's own number (closes the current shared-global-number gap). *(Activated in Phase 2 — see build order.)*
- **Out of scope:** carrier registration itself (A2P 10DLC / toll-free) — BYO tenants register their own; we surface it as the primary reason to choose managed, but Savvy does not automate carrier registration in v1. Re-homing the already-per-tenant Nango integrations (QBO/CompanyCam) into this UI is also out of scope.

## Architecture

### 1. Data model (`packages/db`)
**New table `integration_connection`** (`packages/db/src/schema/integrations.ts`, new; RLS-isolated via `tenantIsolation()`):
`id, tenant_id, provider (enum), status (enum), secret_ciphertext, secret_iv, secret_tag, key_version, metadata (jsonb, non-secret config), label, last_verified_at, created_at, updated_at`. Unique `(tenant_id, provider)`. RLS policy mirrors existing tables; a cross-tenant read test must return nothing.

**`tenant` table:** add `telephony_mode` enum (`platform` | `byo`), **default `platform`**. The migration backfills all existing rows to `platform` → Bloom and every current tenant keep today's behavior with zero change. Next migration is **`0035_*`** (main is at 0034).

### 2. Encryption (`packages/core/src/secret-box.ts`, new)
`seal()` / `open()` using AES-256-GCM via Node `crypto`. Master key from `INTEGRATION_SECRET_KEY` env (base64 of exactly 32 bytes; reuses the existing `requireSecret` helper). `key_version` column enables future rotation. Plaintext is never logged and never returned to a client; `maskSecret()` renders `••• 4821`.

### 3. Capability resolver (`packages/db/src/lifecycle/telephony.ts`)
`resolveTelephonyCreds(tenantId)` returns the Twilio creds bag:
- `platform` mode → global env creds (today's behavior).
- `byo` + active connection → the tenant's own decrypted creds.
- `byo` + nothing active → `inactive` (caller must not send).
Lives in `packages/db` (it needs `withTenant` + schema + `@savvy/core` `secret-box`); `packages/integrations` stays a set of pure client factories that consume a creds bag.

### 4. Client factories (`packages/integrations`)
`makeTwilioSms(creds)` builds an `SmsSender` from explicit creds; `verifyTwilioCreds(creds)` does a cheap auth check (GET the account resource). The existing env-bound `twilioSms` export keeps reading env at call time (the `platform` source) — unchanged behavior.

### 5. Connect UI (`apps/web/src/app/(app)/settings/integrations/`)
A telephony settings page (copying the QuickBooks settings-page + masked-status template): pick **Platform-managed** vs **Bring-your-own**; BYO shows a Twilio credential form with **Save / Test connection / Disconnect** and a **"Have Savvy set this up"** button. Server actions are tenant-scoped and never return secrets. Registered in both settings nav surfaces (`settings/page.tsx` SECTIONS + `components/cockpit/Sidebar.tsx` NAV).

### 6. Managed "do it for me" flow
> **Design note (audience fit):** `main` has a per-tenant Exception Queue (`/exceptions`), but it is the *tenant's own* "things you must act on" worklist. A managed-setup request is **Savvy-ops** work, not the tenant's — so it does **not** belong in the tenant's exception queue. The marker-on-the-row + tenant banner + ops-queries-by-status approach below is the correct audience fit (and needs no new subsystem).

- **"Have Savvy set this up"** → `requestManagedTelephonySetup`: sets connection `status='setup_requested'` and writes a request note into `metadata` (`requestedBy`, `requestedAt`, optional `feeNote`).
- **Tenant view:** the settings page shows a "Setup requested — Savvy will reach out" banner while `status='setup_requested'`.
- **Ops view:** staff find pending work cross-tenant via `listManagedSetupRequests()` (an `adminDb` query of `integration_connection WHERE status='setup_requested'`). No dedicated worklist UI in v1.
- **Fee:** recorded as an out-of-band note only (no per-event line-item billing exists on main); Savvy invoices/charges manually. Auto-charging is a deferred follow-up.
- Ops fulfillment: staff enter the tenant's own credentials on their behalf via the same save action → `status='active'`. Credentials remain the **tenant's own account** (the fee is for labor). `platform` mode remains as an alternative fully-managed tier the flag already supports.

### 7. Backward-compatibility (protects prod)
Migration default `telephony_mode='platform'` for all existing tenants → Bloom's live Vapi/Twilio is unchanged. The resolver's `platform` branch returns the same env creds used today. Existing telephony tests run in platform mode and stay green.

## Testing
Encryption round-trip + tamper rejection; resolver (`platform` / `byo-active` / `byo-inactive`); lifecycle CRUD; **RLS test that cross-tenant reads of `integration_connection` return nothing**; Twilio factory + verify (fetch-injected). Typecheck + lint clean; `.env.example` updated with `INTEGRATION_SECRET_KEY`.

## Build order
- **Phase 1 (this spec's plan):** framework + crypto + resolver + Twilio storage/connect/test/managed + Bloom-safe default. **Behavior-preserving** — stores and resolves creds, does NOT re-route the live send path.
- **Phase 2 (separate plan):** activate the send path (thread `resolveTelephonyCreds` through the SMS call sites + `comms.ts` seam), add RingCentral + Vapi, onboarding-status wiring, inactive-mode guard.

## Assumptions
- "Do it for you for a fee" = Savvy performs the **setup labor**; credentials end up being the **tenant's own** account.
- Voice (Vapi) and SMS (Twilio/RingCentral) share **one** `telephony_mode` per tenant.
- One connection per `(tenant, provider)` in v1.

## What's missing / a domain expert would challenge
- **A2P 10DLC / toll-free registration** is the likely #1 driver of the managed option; v1 surfaces it but does not automate it.
- **Master-key management:** v1 uses a single env-held key with `key_version` for future rotation; a real KMS/HSM is later hardening.
- **Per-channel modes** (BYO voice but platform SMS) deferred.
