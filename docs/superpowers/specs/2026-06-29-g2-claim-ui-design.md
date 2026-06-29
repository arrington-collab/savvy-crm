# G-2 — Claim tracking UI + adjuster scheduling (design)

**Date:** 2026-06-29 · **Slice:** Jobs build, G-2 (finishes "thin claim tracking"; G PR-1 #71 shipped the backend).

## Goal
Make the `claim` backend from #71 usable from the job cockpit for `job.type='insurance'` jobs:
1. **Claim panel** — view/edit the claim (number, carrier, adjuster name/phone, status, ACV/RCV/deductible, filed date) via a server action.
2. **Adjuster-meeting booking** — book an "adjuster" appointment from the panel; booking flips `claim.status → adjuster_scheduled`.
3. **Read-only claim-task list** — surface the 20 `insurance-claim-management-*` lifecycle tasks already on the job.

## 🚫 Hard boundary (do NOT cross)
NO supplement AI / KB / code lookup / carrier-rebuttal letters / Xactimate generation. The `carrier`/`supplement` tables stay commented stubs. No `carrier` FK. That is the deferred SuppIQ / Phase-9 product.

## What already exists (verified on origin/main @ 069ed89)
- `claim` table (one-per-job, RLS) + `CLAIM_STATUS = filed|adjuster_scheduled|approved|partial|denied|closed`.
- `upsertClaim(input)` (insert-or-update on jobId; only sets provided fields) + `getClaimForJob(tenantId, jobId)` in `packages/db/src/lifecycle/claim.ts`, exported from `@savvy/db`.
- `bookAppointment({ type: AppointmentType, ... })` in `packages/db/src/lifecycle/appointments.ts` — already type-generic; throws `SlotTakenError` on the no-overlap EXCLUDE constraint.
- `APPOINTMENT_TYPE = inspection|cm|crew` (`packages/core/src/enums.ts`) — **no `adjuster` yet**.
- Job page (`apps/web/src/app/(app)/jobs/[id]/page.tsx`) already fetches all `jobTask` rows (id,title,phase,status,…) and `job.type`. Claim tasks carry `phase = "Insurance Claim Management"`.
- UI pattern to mirror: `MaterialsPanel.tsx` (client, `useTransition`, `router.refresh()`) ← `material-actions.ts` (`"use server"`, `getTenantId()`, db fn, `revalidatePath`).

## Design

### Enum + migration
- Add `"adjuster"` to `APPOINTMENT_TYPE` in `packages/core/src/enums.ts`.
- Migration **0031**: `ALTER TYPE "appointment_type" ADD VALUE IF NOT EXISTS 'adjuster';` (generate via drizzle if it emits it; otherwise hand-write — commit `.sql` + `_journal.json` + snapshot).

### DB layer (`packages/db/src/lifecycle/claim.ts`)
- `bookAdjusterMeeting({ tenantId, jobId, startsAt, endsAt, assigneeUserId?, customerId? })` → calls `bookAppointment({ ...,. type:'adjuster' })` then `upsertClaim({ tenantId, jobId, status:'adjuster_scheduled' })`; returns `{ appointmentId }`. (Two tenant-scoped calls; composes existing primitives. Idempotent on status.)
- `getAdjusterAppointmentForJob(tenantId, jobId)` → latest `scheduled` appointment with `type='adjuster'` for the job, or null. Returns `{ id, startsAt, endsAt, assigneeUserId } | null`.
- Export both from `@savvy/db` (`packages/db/src/index.ts`).

### Web — server actions (`apps/web/src/lib/claim-actions.ts`)
- `saveClaimAction(input)` — maps form fields (dollar strings → cents via a helper; date string → `Date | null`) → `upsertClaim` → `revalidatePath('/jobs/{jobId}')`. Returns `{ ok:true } | { error }`.
- `bookAdjusterMeetingAction({ jobId, startsAtISO, durationMin?, assigneeUserId? })` — derives `endsAt = startsAt + (durationMin ?? 60)min` → `bookAdjusterMeeting` → revalidate. Catches `SlotTakenError` → `{ error:'slot_taken' }`.

### Web — `ClaimPanel.tsx` (client) + page wiring
- New `apps/web/src/app/(app)/jobs/[id]/ClaimPanel.tsx`: claim form (text inputs, status `<select>`, dollar inputs, date input, Save) + adjuster sub-section (shows scheduled adjuster appt, or `datetime-local` + Book) + read-only task list. `useTransition` + `router.refresh()`, mirrors MaterialsPanel. `data-testid` hooks throughout.
- In `page.tsx`: when `job.type === 'insurance'`, fetch `getClaimForJob` + `getAdjusterAppointmentForJob` (top-level awaits; both self-wrap `withTenant`), filter the already-fetched tasks to `phase === "Insurance Claim Management"`, and render `<ClaimPanel>` in a `<Card>` near Materials. Non-insurance jobs render nothing new.

## Tests
- **packages/db unit (TDD):** `bookAdjusterMeeting` creates a `type='adjuster'` appointment AND flips claim status (creating the claim row if absent); `getAdjusterAppointmentForJob` returns the scheduled adjuster appt and null when none. Use `.js` on relative imports in the test file.
- **Web:** `pnpm typecheck` + `pnpm lint`. Playwright e2e only if a seeded insurance job is available; otherwise rely on typecheck + the db unit tests (apps/web is not in the vitest workspace).

## Out of scope (explicit follow-ups)
- Task-073 auto-notify (supplement-approved → homeowner-notify). Surfaced read-only only.
- Full orchestration / auto-acting of the 20 lifecycle tasks.
- Crew teams (D1c).
