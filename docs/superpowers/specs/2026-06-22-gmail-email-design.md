# Per-tenant Gmail email (Nango google-mail)

**Date:** 2026-06-22
**Status:** Approved (design)
**Goal:** Let each tenant send Savvy's outbound email from their own Gmail/Google Workspace account (OAuth via Nango), falling back to the shared Resend sender when a tenant hasn't connected Gmail.

## Why
Savvy sends email via Resend only (`resendEmail: EmailSender`, imported by `dunning`/`drip`/`appointment-reminders`). For the pilot the customer wants mail to come *from their own address*. Each tenant connects their Google account; Savvy sends through it. (Google's `gmail.send` is a restricted scope — for the pilot the Google OAuth app runs in **testing mode** with the friend added as a test user; production-scale needs Google verification + CASA, tracked as a follow-up.)

## Scope
- **Per-tenant** Gmail send via **Nango** `google-mail` (mirrors the existing `gcal` per-connection pattern).
- Tenant **fallback to Resend** when no Gmail connection exists (so nothing breaks pre-connection).
- A **"Connect Gmail"** action in `/settings` (admin-gated), storing the connection on the tenant.

## Architecture

### 1. Tenant-aware resolver (`packages/integrations/src/email.ts`, extended)
Keep the `EmailSender` interface (`sendEmail({to, from, subject, html}) → {id}`) unchanged. Add:
```ts
export function makeGmailEmail(cfg: { connectionId: string; integrationId?: string }): EmailSender
```
and a resolver that callers use instead of the bare `resendEmail`:
```ts
// packages/integrations/src/email-resolver.ts (new)
export async function getEmailSender(opts: { gmailConnectionId?: string | null }): Promise<EmailSender>
//   gmailConnectionId present → makeGmailEmail({ connectionId })
//   else                      → resendEmail
```
The resolver takes the already-resolved connection id (the *caller*, which has tenant context, reads it from tenant settings) — keeps `@savvy/integrations` free of DB imports, consistent with how `gcal` receives a `connectionId`.

### 2. Gmail adapter (`makeGmailEmail`)
- Build an RFC 822 message: `To`, `From`, `Subject`, `MIME-Version`, `Content-Type: text/html; charset=utf-8`, blank line, `html`. base64**url**-encode (Gmail requires URL-safe base64, `-`/`_`, no padding newlines).
- Send via `nangoProxy({ connectionId, providerConfigKey: integrationId ?? NANGO_GMAIL_INTEGRATION_ID, method: "POST", endpoint: "/gmail/v1/users/me/messages/send", data: { raw } })` → return `{ id: response.id }`.
- `from`: Gmail sends as the **connected account's** address regardless of the header; pass the tenant's connected address through (the connect step can capture it) or let Gmail default to the authorized user. For the pilot, omit/ignore a custom `from` and let Gmail use the authorized account.
- Errors mirror the Resend adapter's throw shape.

### 3. Connection storage + consumers
- Store on tenant settings: `tenant.settings.email.gmailConnectionId` (jsonb; no migration — reuses the existing `settings` blob, like `scheduling`/`finance`/`esign`). A small `parseEmailConfig` in `@savvy/core` (zod, defaults to `{}`), mirroring `parseSchedulingConfig`.
- Repoint the 3 email consumers (`dunning`, `drip`, `appointment-reminders`): each already runs in tenant context, so each loads the tenant's `gmailConnectionId` and calls `getEmailSender({ gmailConnectionId })` instead of importing `resendEmail` directly. (`drip` resolves it and passes through its `SendDeps.email`.)

### 4. Connect UI (`apps/web/src/app/(app)/settings/...`)
- A "Connect Gmail" button using **Nango Connect** (frontend SDK) for the `google-mail` integration — mirrors the existing QuickBooks/Calendar connect buttons. On success, persist the returned `connectionId` to `tenant.settings.email.gmailConnectionId` via an admin-gated `"use server"` action (`isOrgAdmin()` guard, like the other settings actions). Show connected/disconnected state.
- Nango setup (manual, documented): create a `google-mail` integration in Nango with scope `https://www.googleapis.com/auth/gmail.send`; the Google Cloud OAuth app in **testing mode** + friend added as a test user.

## Env (added to `.env.production.example` + `.env.example`)
```
NANGO_GMAIL_INTEGRATION_ID=google-mail
# (existing NANGO_SECRET_KEY / NANGO_HOST already present)
```

## Testing
- **Unit (`@savvy/integrations`):** `makeGmailEmail` with a mock `nangoProxy` — asserts the RFC822 message is correctly assembled + base64url-encoded (round-trip decode), the endpoint/connection are right, and `{id}` is returned; non-2xx throws.
- **Unit:** `getEmailSender` — connection present → gmail sender; absent → `resendEmail` (identity check via a flag/spy).
- **Unit (`@savvy/core`):** `parseEmailConfig` defaults + round-trip.
- **No regression:** `dunning`/`drip`/`appointment-reminders` tests still pass (resolver returns the Resend sender when no connection, matching today's behavior; injected `SendDeps` seams unchanged).

## Out of scope / follow-ups
- **Google verification + CASA** for production multi-tenant (pilot runs in testing mode).
- Capturing/displaying the connected Gmail address in settings (nice-to-have).
- Inbound email / reply threading (Savvy is send-only today).
- DKIM/domain alignment guidance for deliverability.
