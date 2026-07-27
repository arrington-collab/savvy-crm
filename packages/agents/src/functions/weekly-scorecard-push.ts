import { adminDb, and, eq, isNull, recordAgentRun, rebuildWeek, tenant, user, weeklyScorecard, withTenant } from "@savvy/db";
import { hourInTimeZone, isoWeekdayInTimeZone } from "@savvy/core";
import { businessDateOf, weekStartOf, MockFlashDelivery, type FlashDelivery, type MetricValue } from "@savvy/command-center";
import { inngest } from "../client";

/**
 * D4-10: the Monday-morning weekly-scorecard push. Ticks hourly (mirrors
 * ops-digest's fan-out) and fires each tenant once — at its local Monday
 * morning — using `isoWeekdayInTimeZone` + `hourInTimeZone` off the tenant's
 * `timezone` column, same source ops-digest reads. No dedicated
 * "scorecardPushHour" config column exists yet, so the push hour defaults to
 * 8am local, overridable via `tenant.settings.scorecard.pushHourLocal`.
 */

// 8am tenant-local — a sensible default for an owner's Monday-morning read,
// before the day's first appointments. Documented default (no config column).
export const DEFAULT_PUSH_HOUR = 8;
const MONDAY = 1; // isoWeekdayInTimeZone: 1=Monday..7=Sunday

/**
 * The configured local push hour for a tenant, read from
 * `settings.scorecard.pushHourLocal` when present and a valid hour (mirrors
 * how ops-digest reads `digest_times` off the tenant row) — else
 * `DEFAULT_PUSH_HOUR`. An invalid/out-of-range override never throws; it
 * just falls back, so a bad config value can't silently break the cron.
 */
export function scorecardPushHour(settings: unknown): number {
  const raw = (settings as { scorecard?: { pushHourLocal?: unknown } } | null)?.scorecard?.pushHourLocal;
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 0 && raw <= 23 ? raw : DEFAULT_PUSH_HOUR;
}

/**
 * True only when it's simultaneously Monday AND `pushHour` local time in
 * `timezone` — the gate an hourly cron tick needs to fire a weekly job
 * exactly once per tenant per week. Pure (no DB, no clock reads beyond the
 * passed-in `now`), so it's directly unit-testable with a fake clock.
 */
export function isWeeklyScorecardDue(now: Date, timezone: string, pushHour: number): boolean {
  return isoWeekdayInTimeZone(now, timezone) === MONDAY && hourInTimeZone(now, timezone) === pushHour;
}

export interface TenantScorecardPushRow {
  id: string;
  timezone: string;
  settings?: unknown;
}

/** Filters tenants to those due for their Monday-local-morning scorecard push right now. Pure. */
export function dueTenantsForWeeklyScorecard<T extends TenantScorecardPushRow>(tenants: T[], now: Date): T[] {
  return tenants.filter((t) => isWeeklyScorecardDue(now, t.timezone, scorecardPushHour(t.settings)));
}

// Mirrors buildScorecard's own (unexported) onTrackRank / the scorecard
// page's re-sort: off-track first (needs attention now), pending/no-goal
// second, on-track last. Re-sorted here (not trusted from the SELECT) for
// the same reason the page does it — Postgres gives no row-order guarantee.
function onTrackRank(onTrack: boolean | null): number {
  if (onTrack === false) return 0;
  if (onTrack === null) return 1;
  return 2;
}

function formatMetricValue(v: MetricValue): string {
  return v.status === "ok" ? String(v.value) : `pending (${v.reason})`;
}

export interface ScorecardSummaryRow {
  metricKey: string;
  value: MetricValue;
  onTrack: boolean | null;
}

/**
 * A short, honest, off-track-first text summary of a week's persisted
 * scorecard rows for the Monday push. Never fabricates a number — a
 * `pending` row prints its reason instead of a fake value, same "honest
 * absence" discipline as the scorecard page (D4-7) and `buildScorecard` (D4-6).
 */
export function renderWeeklyScorecardSummary(rows: ScorecardSummaryRow[]): string {
  if (rows.length === 0) return "Weekly scorecard: no data yet.";
  const sorted = [...rows].sort((a, b) => onTrackRank(a.onTrack) - onTrackRank(b.onTrack));
  const offTrack = sorted.filter((r) => r.onTrack === false);
  if (offTrack.length === 0) return `Weekly scorecard: all ${rows.length} measurables on track.`;
  const lines = offTrack.slice(0, 5).map((r) => `${r.metricKey}: ${formatMetricValue(r.value)}`);
  return `Weekly scorecard: ${offTrack.length} off-track — ${lines.join("; ")}.`;
}

export interface WeeklyScorecardPushDeps {
  /** Injectable delivery seam (Day 2's FlashDelivery) — defaults to the mock (no real Twilio/email wiring here). */
  delivery?: FlashDelivery;
  /** Injectable clock for tests. */
  now?: Date;
}

/**
 * Sends one tenant's Monday weekly-scorecard push:
 *  1. `rebuildWeek` for the current Denver business week (idempotent — safe
 *     to call even if the day's/week's rows already exist, and safe if this
 *     ever double-fires the same tenant/week: it just re-upserts the same
 *     rows in place, same guarantee `rebuildWeek`'s own doc comment makes).
 *  2. Read the persisted company-wide (`locationId IS NULL`) rows for that
 *     week — same query the scorecard page (D4-7) uses.
 *  3. Render an off-track-first summary and push it through the injected
 *     `FlashDelivery` seam (mock on prod today) to the tenant's owner.
 *  4. Record an `agent_run` as proof-of-send (mirrors `sendTenantDigest`).
 *
 * Fail-soft at the delivery step only (a send hiccup never throws), same
 * split ops-digest makes between "the compute must succeed" and "the send is
 * best-effort". A double-fire is accepted as mock-send-idempotent: the
 * summary is deterministic off the (idempotently rebuilt) week, so resending
 * it is harmless — there is no dedupe table beyond that, noted as a
 * deliberate simplification for a mock-only delivery seam.
 */
export async function sendTenantWeeklyScorecard(tenantId: string, deps: WeeklyScorecardPushDeps = {}): Promise<{ sent: boolean; offTrack: number }> {
  const now = deps.now ?? new Date();
  const weekStart = weekStartOf(businessDateOf(now));

  await rebuildWeek(tenantId, weekStart);

  const rows = await withTenant(tenantId, (tx) =>
    tx.select().from(weeklyScorecard).where(and(
      eq(weeklyScorecard.tenantId, tenantId),
      eq(weeklyScorecard.weekStart, weekStart),
      isNull(weeklyScorecard.locationId),
    )));

  const summary = renderWeeklyScorecardSummary(
    rows.map((r) => ({ metricKey: r.metricKey, value: r.value as MetricValue, onTrack: r.onTrack })),
  );
  const offTrack = rows.filter((r) => r.onTrack === false).length;

  const [owner] = await adminDb
    .select({ phone: user.phone })
    .from(user)
    .where(and(eq(user.tenantId, tenantId), eq(user.role, "owner")))
    .limit(1);

  let sent = false;
  if (owner?.phone) {
    const delivery = deps.delivery ?? new MockFlashDelivery();
    try {
      const base = process.env.APP_BASE_URL ?? "http://localhost:3000";
      await delivery.send({ headline: summary, url: `${base}/reports/scorecard`, to: owner.phone });
      sent = true;
    } catch {
      /* fail-soft: mirrors ops-digest — a delivery hiccup never blocks the push */
    }
  }

  await recordAgentRun({ tenantId, agent: "orchestrator", taskKey: "scorecard.weekly_push", status: "ok" });

  return { sent, offTrack };
}

export const weeklyScorecardPush = inngest.createFunction(
  { id: "weekly-scorecard-push" },
  { cron: "0 * * * *" },
  async ({ step }) => {
    const due = await step.run("due-tenants", async () => {
      const now = new Date();
      const tenants = await adminDb.select({ id: tenant.id, timezone: tenant.timezone, settings: tenant.settings }).from(tenant);
      return dueTenantsForWeeklyScorecard(tenants, now).map((t) => t.id);
    });

    let sent = 0;
    for (const id of due) {
      const r = await step.run(`weekly-scorecard:${id}`, () => sendTenantWeeklyScorecard(id));
      if (r.sent) sent += 1;
    }
    return { sent, due: due.length };
  },
);
