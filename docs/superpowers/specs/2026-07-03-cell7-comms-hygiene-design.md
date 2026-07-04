# Cell 7 — Comms Hygiene — Design

**Date:** 2026-07-03
**Status:** Approved (design)
**Contract:** First-20-Cells, Cell 7. Done bar: `comms.body_quality` and `comms.no_double_send` invariants (already seeded, already wired into the health sweep) run green in production for 14 days.

## Problem

Two comms-quality invariants exist and are wired into the health sweep (`packages/core/src/verification/checks.ts:25,42` + `packages/agents/src/health-sweep.ts`), but the send paths don't yet satisfy them:

1. **`comms.body_quality` is RED.** Three homeowner notifiers embed a raw ~139-char JWT status link directly in the SMS/email **body** — `${base}/status/${signPayloadToken(...)}` — which trips the invariant's `body ~ 'https?://[^space]{33,}'` rule. Files: `homeowner-notify.ts:30`, `homeowner-crew-notify.ts` (~52,70,73), `homeowner-delivery-notify.ts` (~50,63,66). The `/b/{code}` short-link system already exists but only serves booking links (`/b/[code]` always redirects to `/book/{token}`).
2. **`comms.no_double_send` is only app-layer safe.** The `communication` table has no structural dedupe. The homeowner-stage notifiers use a send-then-mark ledger pattern (`sendSms` → insert `communication` → `markStageEventNotified`); if the mark fails or a cron overlaps, the next tick re-sends. The invariant would catch it after the fact but nothing prevents it.

## Goal & scope

Make `body_quality` green (short-link the status URLs) and structurally harden `no_double_send` (claim-then-send with a DB idempotency key). **Out of scope** (per product call): tenant-tz "Tomorrow, 2:00 PM" datetime rendering — comms bodies carry no datetimes today, and it's tied to neither invariant.

## Decisions (from brainstorming)

| Question | Decision |
|---|---|
| Scope | Short-links + dedupe hardening. Skip tz-rendering. |
| Shortener | **Generalize** the existing `/b/` shortener to a second `kind` (`status`) rather than build a parallel one. Keep the table named `booking_link` (renaming churns booking code for no functional gain) — add a `kind` column, default `'booking'` (backward-compatible). |
| Dedupe mechanism | Add `dedupe_key` to `communication` + partial unique index; restructure notifiers to **claim-then-send** (insert the row first with `onConflictDoNothing`; skip the send if 0 rows inserted). This prevents the duplicate *send*, not just a duplicate *row*. |
| Evidence | No new invariant — the two exist and are wired. The cell is done when both run green. |

## Architecture — three units, one migration (0046)

### Unit 1 — Generalize the short-link shortener
- **Migration 0046** adds `kind text not null default 'booking'` to `booking_link`.
- `packages/db/src/schema/booking-link.ts`: add the `kind` column.
- `packages/db/src/lifecycle/booking-link.ts`: `resolveBookingLink` returns `{ token, kind }` (not just token). Add `createStatusLink({ tenantId, token, expiresAt? })` that inserts with `kind='status'` and returns the code (mirrors `createBookingLink`, which stays as-is and inserts `kind='booking'`).
- `apps/web/src/app/b/[code]/route.ts`: resolve `{ token, kind }`; redirect to `/status/${token}` when `kind==='status'`, else `/book/${token}` (unchanged default). 404 when not found/expired (unchanged).

### Unit 2 — Short-link the three homeowner notifiers
Each notifier currently builds `const link = ${base}/status/${signPayloadToken({tenantId, jobId}, secret)}`. Replace with:
```ts
const token = signPayloadToken({ tenantId, jobId: ev.jobId }, secret);
const code = await createStatusLink({ tenantId, token });
const link = `${base}/b/${code}`;
```
Body now carries a ~30-char link → `body_quality` regex (`{33,}`) no longer matches → GREEN. Applies to: `homeowner-notify.ts`, `homeowner-crew-notify.ts`, `homeowner-delivery-notify.ts` (each place a `/status/` link is put into a body).

### Unit 3 — Structural dedupe (claim-then-send)
- **Migration 0046** also adds `dedupe_key text` to `communication` + partial unique index `communication_dedupe_uniq` on `(tenant_id, dedupe_key) WHERE dedupe_key IS NOT NULL`.
- `packages/db/src/schema/comms.ts`: add the column + index.
- New db helper `claimCommunication(input): Promise<{ id: string } | null>` — inserts a `communication` row with a `dedupeKey`, `onConflictDoNothing` on the partial unique index, `returning({ id })`. Returns the row on success, `null` on conflict (already claimed).
- Notifiers restructure from send-then-record to **claim-then-send**:
  ```ts
  const dedupeKey = `stage:${channel}:${to}:${ev.eventId}`;  // template + recipient + event
  const claimed = await claimCommunication({ tenantId, jobId: ev.jobId, customerId: ev.customerId, channel, direction: "outbound", to, body, dedupeKey });
  if (!claimed) continue;               // already sent this (channel,recipient,event) — skip
  try { await sender.sendSms(...) } catch { /* fail-soft */ }
  ```
  `markStageEventNotified` stays (avoids re-listing the event) as belt-and-suspenders; correctness no longer depends on it. The `communication` row is still written as intent-to-send (matches the existing comment), now with a dedupe key.
- Non-idempotent existing inserts (where a `dedupe_key` isn't supplied) keep working: the partial unique index only applies `WHERE dedupe_key IS NOT NULL`, so rows without a key are unaffected.

## Non-negotiables honored
- **Tenant isolation:** all reads/writes via `withTenant`/`adminDb` scoped by `tenant_id`; the dedupe index is `(tenant_id, dedupe_key)`.
- **Fail-soft sends unchanged:** the send stays wrapped in try/catch; the claim row records intent-to-send regardless (as today).
- **Backward compatible:** `booking_link.kind` defaults `'booking'`; the dedupe index is partial (`WHERE dedupe_key IS NOT NULL`) so existing keyless inserts are unaffected.
- **No new events, no hardcoded TZ.**

## Testing
- **Unit 1 (db integration):** `createStatusLink` inserts `kind='status'`; `resolveBookingLink` returns `{token, kind}`; a `booking`-kind link still resolves. Route-level: `/b/{code}` for a status link redirects to `/status/{token}` (assert via `resolveBookingLink` + a small route test or the redirect target).
- **Unit 2 (invariant-backed):** seed an outbound `communication` row whose body contains a `/b/{code}` link; run the actual `comms.body_quality` query (from `checks.ts`) against it and assert **zero** offending rows. Contrast: a row with a raw `/status/{139-char-jwt}` body is flagged (guards the regex).
- **Unit 3 (dedupe):** `claimCommunication` twice with the same `dedupeKey` → first returns a row, second returns `null` (0 rows). In a notifier-level test, two runs over the same stage event → `sendSms` called exactly once. Run the `comms.no_double_send` query against the resulting rows → zero offenders.

## Out of scope / follow-ups
- Tenant-tz "Tomorrow, 2:00 PM" datetime rendering in comms bodies (not invariant-linked; bodies carry no datetimes today).
- Applying the `dedupe_key` claim pattern to other send paths (e.g. `appointment-reminders`) beyond the homeowner notifiers — the mechanism is general; extend opportunistically if those paths show duplicate-send races.
- Renaming `booking_link` → `short_link` (cosmetic; deferred to avoid churn).
