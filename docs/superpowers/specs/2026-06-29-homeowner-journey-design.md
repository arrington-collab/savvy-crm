# F — Homeowner journey (status page + stage notifications) — Design

**Date:** 2026-06-29
**Slice:** Jobs build, slice F. (G — thin claim tracking — is a separate follow-up slice.)

## Problem

Homeowners are blind after they book: nothing tells them their job moved to estimate/approved/
production/complete, and there's no page where they can see where their job stands. Every other
party (rep, crew, office) has a view; the customer has none.

## Goal

Two halves of the "homeowner journey" (both chosen with Brett):
1. **Public status page** — a token-link page where a homeowner sees their job's journey timeline,
   next appointment, and a friendly current-status — no login.
2. **Stage-change notifications** — on key milestone transitions, text/email the homeowner a friendly
   update with a link to that page.

## Approach

Reuse the existing public-token pattern (`signPayloadToken`/`verifyPayloadToken`, behind `/book/[token]`)
for the page, and a **cron off `job_stage_event`** for notifications.

**Why a cron, not an event:** `recordStageChange` writes a `job_stage_event` on EVERY real transition
(human drag AND agent), but the `job/stage-changed` Inngest event only fires for agent-driven changes
(user drags call `recordStageChange` directly, by design). The db layer can't emit Inngest events. So
the reliable, decoupled trigger is a cron that reads recent un-notified `job_stage_event` rows — the
same durable-marker pattern as `deferred_at` (C Part 2) and `weather_flagged_at` (D1b). ~15-min lag is
fine for milestone comms.

**Dormant-safe:** the notifier only acts on events entered within a short **lookback window** (2h) and
stamps a `homeowner_notified_at` marker, so it never spams historical transitions on first deploy and
never double-sends. Notifications respect `customer.smsOptOut`/`emailOptOut` and fail-soft without creds
(like `appointment-reminders`). Default `notifyStages = [approved, production, complete]`.

### 1. Core (`packages/core/src/homeowner.ts`)

- `parseHomeownerConfig(raw) → { enabled: boolean(true); notifyStages: JobStage[] }` from
  `tenant.settings.homeowner` (notifyStages default `["approved","production","complete"]`, filtered to
  valid `JOB_STAGE`).
- `homeownerStageCopy(stage) → { headline: string; body: string }` — customer-friendly milestone copy
  (e.g. `approved → { headline: "You're approved! 🎉", body: "Your project is approved — we're getting
  it on the schedule." }`). Covers all stages.
- `buildHomeownerJourney(currentStage) → Array<{ key: JobStage; label: string; status: "done"|"current"|"upcoming" }>`
  over the homeowner-meaningful milestone subset (`inspected, estimate, approved, production, closeout,
  complete`), marking each by position vs `currentStage` in `JOB_STAGE`. Pure, unit-tested. Exported from
  the core index.

### 2. DB — marker + reads

- **Migration:** add nullable `job_stage_event.homeowner_notified_at timestamptz` (the durable dedup
  marker; `job_stage_event` already has `tenantIsolation()` RLS — no new policy).
- `getHomeownerStatus(tenantId, jobId) → { companyName; customerName; address; currentStage; events: {toStage; enteredAt}[]; nextAppointment: {type; startsAt}|null } | null`
  — read for the page (job + tenant name + customer + property + stage events + next scheduled appt).
- `listStageEventsToNotify(tenantId, { stages, sinceMs, now }) → Array<{ eventId; jobId; toStage; customerId; phone; email; smsOptOut; emailOptOut }>`
  — recent un-notified events (`toStage in stages AND homeowner_notified_at IS NULL AND entered_at >= now - sinceMs`)
  joined job→customer; `markStageEventNotified(tenantId, eventId)` stamps `homeowner_notified_at = now`.
  All `withTenant`. Exported from `@savvy/db`.

### 3. Agents — notification cron (`packages/agents/src/functions/homeowner-notify.ts`)

- `evaluateTenantHomeownerNotifs(tenantId, now) → { sent: number }`: `parseHomeownerConfig`; if `!enabled`
  no-op; `listStageEventsToNotify(stages = notifyStages, sinceMs = 2h)`; per event build the status link
  (`signPayloadToken({ tenantId, jobId }, UNSUBSCRIBE_SECRET)` → `${APP_BASE_URL}/status/<token>`) +
  `homeownerStageCopy(toStage)`; send SMS (phone && !smsOptOut) + email (email && !emailOptOut), fail-soft;
  log a `communication` row; `markStageEventNotified`. Mirrors `appointment-reminders` send/structure.
- `homeownerNotify` Inngest cron (`*/15 * * * *` TZ Phoenix, `concurrency: { limit: 1 }`); lists tenants,
  loops the helper. **Registered** in `packages/agents/src/index.ts` `functions` array.

### 4. Web — public status page

- `/status/[token]` route — add `/^\/status\//` to `middleware.ts` PUBLIC.
- `getHomeownerStatus(token)` server action (public — uses the token's `tenantId`, NOT `getTenantId()`):
  `verifyPayloadToken` → `{ tenantId, jobId }` → `withTenant(tenantId, …)` read → status data or `{ error }`.
- `status/[token]/page.tsx` server component — renders the journey timeline (done/current/upcoming),
  the next appointment, a friendly current-status (`homeownerStageCopy`), and the company name. Read-only,
  the customer's own data; invalid/expired token → a friendly "link invalid" message (mirror `/book`).

## Testing

- **Core unit:** `parseHomeownerConfig` defaults/overrides; `homeownerStageCopy` covers every stage;
  `buildHomeownerJourney` (done/current/upcoming by stage).
- **DB:** `getHomeownerStatus` shape; `listStageEventsToNotify` (recency + un-notified filter) +
  `markStageEventNotified` (dedup).
- **Agents:** `evaluateTenantHomeownerNotifs` — sends + marks for a configured milestone event; no-op when
  disabled / opted-out / stage not configured / event too old.
- **e2e** (`homeowner-status.spec.ts`): build a token for a seeded job → GET `/status/<token>` → assert the
  journey timeline + next appointment render; an invalid token → friendly error. (Public route; TEST_MODE
  bypasses Clerk.)
- **Docs:** `docs/jobs-pipeline.md` + `.env.example` (note `APP_BASE_URL` already exists; no new secret —
  reuses `UNSUBSCRIBE_SECRET`).

## Assumptions / decisions

- **[Brett]** Build F now (page + notifications); G (thin claim tracking) is the next slice.
- **[DECISION]** Notifications via cron off `job_stage_event` + `homeowner_notified_at` marker (reliable
  across human+agent paths; the existing `job/stage-changed` event misses user drags).
- **[DECISION]** 2h lookback + marker → no historical spam on first deploy, no double-sends.
- **[ASSUMED]** Reuse `UNSUBSCRIBE_SECRET` for the status token (already the booking/unsub secret); no new env.
- **[ASSUMED]** notifyStages default `[approved, production, complete]`; respect opt-out; fail-soft on no creds.

## Out of scope

- **No homeowner estimate/invoice/photo viewer** (page shows journey + next appt only).
- **No homeowner reply/2-way** on the status page (read-only).
- **No per-homeowner notification preferences** beyond the existing `customer` opt-out flags.
- **No "copy homeowner link" cockpit button** (the notification carries the link; a cockpit affordance is
  a cheap follow-up).
- Insurance/claims = slice G (separate).
