# Phase 8 — Reporting & Billing Meters (Design)

**Date:** 2026-06-16
**Roadmap goal:** Dashboards (pipeline, velocity, rep/team performance) + usage metering (jobs processed, AI spend, AI voice minutes, storage) → revenue-band billing + overages. **Done when:** per-tenant usage + the billing band compute correctly; storage cap + cold-archive enforced.

**Scope decisions (locked in brainstorming):**
- **Compute + display only** — meter usage, compute the band bill + overages, surface it. **No Stripe charging** (later phase).
- **AI meter = both** LLM spend (`agent_run.costCents`) **and** AI voice minutes (Twilio; voice-duration capture added this phase).
- **Bands = platform config constant + persisted monthly snapshots.** `tenant.revenueBand` selects the band; a monthly cron writes a per-tenant `usage_snapshot`.
- **Storage = soft cap + age-based cold-archive flag.** Over-cap bills as overage (never blocks uploads); a daily cron flags documents older than N days as `archivedAt`; archived bytes drop out of the active-storage meter. Real R2 storage-class/lifecycle move = logged follow-up.

**Branch:** `worktree-phase8-reporting-billing`, off `main` (`958014e`, includes 5B + 6A + 7). Isolated worktree (a concurrent session holds the main checkout on Phase 6B).

---

## 1. Architecture overview

Two pillars in one waved PR:

- **Pillar A — Reporting:** pure functions computing velocity (days-in-stage) + rep/team performance over existing `job` / `job_stage_event` data; surfaced on the existing `/dashboard`.
- **Pillar B — Metering + billing:** a platform band config, pure `computeBill`, per-tenant usage aggregation, a `usage_snapshot` table, two scheduled crons (monthly meter + daily cold-archive), voice-duration capture, and a `/billing` page.

**Non-negotiables honored:** tenant RLS on `usage_snapshot` (+ isolation test); money in integer cents; all multi-step/scheduled work is durable Inngest; tests + typecheck + lint gate every commit; no secrets in repo.

---

## 2. Data model

### New table: `usage_snapshot` (RLS, `tenantIsolation()`)
| Column | Notes |
|---|---|
| `id`, `tenantId` | |
| `periodKey` | `YYYY-MM` (the metered month) |
| `jobsProcessed` | integer |
| `aiSpendCents` | integer |
| `aiVoiceMinutes` | integer |
| `storageBytes` | bigint (use `bigint` mode `number`) |
| `bandKey` | text — band at snapshot time |
| `basePriceCents`, `overageCents`, `totalCents` | integer |
| `createdAt` | |

Unique `(tenantId, periodKey)`; index `(tenantId)`.

### Column additions
- `document.archivedAt` (timestamptz, nullable) — cold-archive flag; archived rows excluded from the active-storage meter.
- `communication.durationSeconds` (integer, nullable) — call duration captured on the Twilio **voice** path.

`tenant.revenueBand` (exists, text) holds a band key from `BILLING_BANDS`.

---

## 3. Billing core (`@savvy/core`, pure)

### `billing-bands.ts`
```
export interface BillingBand {
  key: string; name: string; monthlyPriceCents: number;
  allowances: { jobsProcessed: number; aiSpendCents: number; aiVoiceMinutes: number; storageBytes: number };
  overageRates: { perJobCents: number; perVoiceMinuteCents: number; perGbStorageCents: number; perAiSpendDollarCents: number };
}
export const BILLING_BANDS: BillingBand[]   // seeded defaults, tunable
export function getBand(key: string | null): BillingBand   // falls back to the smallest band
```
Seed 3–4 bands (e.g. `starter`, `growth`, `scale`) with placeholder prices/allowances the operator tunes.

### `billing.ts`
```
export interface UsageTotals { jobsProcessed; aiSpendCents; aiVoiceMinutes; storageBytes }
export function computeBill(usage: UsageTotals, band: BillingBand): {
  basePriceCents: number;
  overages: { jobs: number; aiSpend: number; voice: number; storage: number }; // cents
  overageTotalCents: number;
  totalCents: number;
}
```
Each meter's overage = `max(0, usage - allowance) × rate`, rounded to whole cents. Storage overage prorated per-GB. AI-spend overage billed per dollar over allowance. Heavily unit-tested (base only, each meter over, all-over, zero).

### Reporting pure functions
- `velocity.ts`: `computeVelocity(stageEvents)` → `{ perStageAvgDays: Record<stage, number>; cycleTimeDays }` from ordered `enteredAt` deltas.
- `rep-performance.ts`: `summarizeRepPerformance(rows)` → per-rep `{ userId, name, jobsAssigned, approved, totalValueCents, avgDaysToClose }` + a team rollup.

---

## 4. Usage aggregation (`@savvy/db`)

`computeTenantUsage(tenantId, periodStart, periodEnd): Promise<UsageTotals>`:
| Meter | Query |
|---|---|
| jobsProcessed | `count(job)` where `openedAt`/`createdAt` in `[start,end)` |
| aiSpendCents | `sum(agent_run.costCents)` where `startedAt` in range |
| aiVoiceMinutes | `floor(sum(communication.durationSeconds)/60)` where `channel='voice'` in range |
| storageBytes | `sum(document.sizeBytes)` where `archivedAt is null` (point-in-time, not period-bounded) |

`recordUsageSnapshot(tenantId, periodKey)`: computes usage for the period, resolves the band, computes the bill, **upserts** `usage_snapshot` on `(tenantId, periodKey)` (idempotent — re-runs update in place).

---

## 5. Scheduled workflows (`@savvy/agents`, Inngest crons)

- `meterUsageMonthly` — monthly cron. Lists all tenants (via `adminDb`), and for each calls `recordUsageSnapshot(tenantId, priorMonthKey)`. Idempotent.
- `coldArchiveDocuments` — daily cron. Flags `document.archivedAt = now()` for rows older than `N` days (config default, e.g. 90) that aren't already archived, per tenant.

> Follow the repo's existing scheduled/cron function pattern (check `appointment-reminders.ts` for the Inngest cron/scheduled trigger syntax for this Inngest version). Register both in `packages/agents/src/index.ts`.

**Voice-duration capture:** in the Twilio voice/reception handler that logs a `communication` row (Phase 3 comms — locate via `grep -rl "channel.*voice\|twilio.*voice\|reception" apps packages`), set `durationSeconds` from the Twilio call payload. If no voice handler logs duration yet, add the field write where the voice call's `communication` row is created/finalized.

---

## 6. Web (`apps/web`)

- `billing-queries.ts` (server-only): `getCurrentUsage()` (live `computeTenantUsage` for the current month + band + `computeBill`), `listUsageSnapshots()` (history).
- **`/billing`** page (`force-dynamic`): current-period usage vs band allowances (progress bars), the computed bill breakdown (base + per-meter overages + total), and a snapshot history table. Nav link.
- `dashboard-queries.ts` additions: velocity + rep/team performance.
- Expand `/dashboard`: a **Velocity** card + a **Rep/Team performance** table (mirror existing dashboard card markup).

---

## 7. Testing

- **Unit (`@savvy/core`):** `computeBill` (base, each meter over, all-over, zero); `computeVelocity` (single + multi-stage, missing events); `summarizeRepPerformance`; `getBand` fallback.
- **DB integration (`@savvy/db`):** `computeTenantUsage` (seed jobs/agent_runs/voice comms/docs across a period; assert archived docs excluded + non-voice comms excluded); `recordUsageSnapshot` idempotent upsert; **RLS cross-tenant isolation** extended to `usage_snapshot`.
- **Agents:** `meterUsageMonthly` (seed one tenant → run → snapshot written + bill correct); `coldArchiveDocuments` (old flagged, recent untouched).
- **E2E (Playwright):** seed a tenant's usage → trigger `meterUsageMonthly` (or call `recordUsageSnapshot`) → `/billing` shows usage + computed bill; `/dashboard` shows the velocity card + a rep performance row.

---

## 8. Definition of done

- [ ] `usage_snapshot` + `document.archivedAt` + `communication.durationSeconds` migrated; RLS verified by test.
- [ ] `computeBill` + reporting pure functions correct and unit-tested.
- [ ] `computeTenantUsage` aggregates all four meters (archived excluded); `recordUsageSnapshot` idempotent.
- [ ] Monthly meter + daily cold-archive crons durable + idempotent; voice duration captured.
- [ ] `/billing` page + dashboard velocity/rep cards read live data.
- [ ] Unit + integration + agents + e2e pass; typecheck + lint clean. One reviewed PR.

## 9. Known follow-ups (out of scope, logged)
- Real Stripe Billing (subscription base + metered overage charges) — this phase computes/displays only.
- R2 storage-class/lifecycle move for cold-archived docs (this phase only flags `archivedAt`).
- Per-meter historical charts on the dashboard (snapshots enable this later).
- "Jobs processed" counts jobs *created* in the period; revisit if a closed-in-period definition is wanted.
