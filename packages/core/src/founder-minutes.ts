/**
 * Founder-minutes: the human attention an exception cost = time between the owner
 * first opening it (first_viewed_at) and it being resolved, capped at 30 min/item
 * so one long-ignored item can't dominate. Summed per task into
 * task_health.founder_minutes_30d — the automation priority queue is manual/assisted
 * tasks sorted by this, descending. Pure so the cap/window math is unit-tested.
 */
const CAP_MINUTES = 30;

export type FounderMinuteItem = { firstViewedAt: Date | null; resolvedAt: Date | null };

export function sumFounderMinutes(items: FounderMinuteItem[]): number {
  let total = 0;
  for (const it of items) {
    if (!it.firstViewedAt || !it.resolvedAt) continue; // never opened, or not resolved -> no measured attention
    const mins = (it.resolvedAt.getTime() - it.firstViewedAt.getTime()) / 60_000;
    if (mins <= 0) continue; // clock skew / resolved before viewed
    total += Math.min(CAP_MINUTES, mins);
  }
  return Math.round(total);
}
