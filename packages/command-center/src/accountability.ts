import type { QueueItem } from "./exception-queue";
import { isActive } from "./exception-queue";

// D4-9: the accountability panel (spec §6f) — "what's aging on someone else's
// plate." Reuses Day 2's `isActive` (open, or a snooze whose time has passed)
// rather than reinventing open/snoozed lifecycle rules; this module only adds
// the two things Day 2 didn't need: grouping by primary owner and bucketing
// by how long an active item has been sitting there.
//
// Grouped by `assignee` (the primary, accountable owner), NOT `notify`
// membership — `needsYouFor`/`ExceptionQueue.needsYou` already answer "does
// this person need to see it" (any name in `notify`, including oversight);
// accountability asks a different question, "whose plate is this really on,
// and for how long" — a role can be listed as oversight in `notify` without
// being the one on the hook to fix it.

export type QueueAgeBucket = "0-1d" | "2-3d" | "4-7d" | "8d+";

// Ordered ascending by max age (days); the last bucket ("8d+") is the
// catch-all for anything older than the last threshold below.
const AGE_THRESHOLDS: { key: QueueAgeBucket; maxDays: number }[] = [
  { key: "0-1d", maxDays: 1 },
  { key: "2-3d", maxDays: 3 },
  { key: "4-7d", maxDays: 7 },
];
const OLDEST_BUCKET: QueueAgeBucket = "8d+";

export const QUEUE_AGE_BUCKETS: QueueAgeBucket[] = [...AGE_THRESHOLDS.map((b) => b.key), OLDEST_BUCKET];

export function ageDaysOf(createdAt: string, now: Date): number {
  return (now.getTime() - new Date(createdAt).getTime()) / (1000 * 60 * 60 * 24);
}

export function ageBucketFor(createdAt: string, now: Date): QueueAgeBucket {
  const ageDays = ageDaysOf(createdAt, now);
  for (const b of AGE_THRESHOLDS) {
    if (ageDays <= b.maxDays) return b.key;
  }
  return OLDEST_BUCKET;
}

export interface OwnerAgeGroup {
  /** The item's `assignee` — a role/person string (e.g. "arrington", "sales-manager"), never a display name lookup. */
  owner: string;
  total: number;
  byAge: Record<QueueAgeBucket, QueueItem[]>;
  /** Age (days, fractional) of the single oldest active item this owner holds — used to sort the worst-aging owner to the top. */
  oldestDays: number;
}

/**
 * Groups the ACTIVE items in the exception queue (strictly open, or a
 * snooze whose time has passed — via `isActive`) by primary owner
 * (`assignee`), then buckets each owner's items by age. Sorted worst-first
 * (the owner holding the single oldest active item leads the list) — the
 * panel's whole point is surfacing what's aging on someone else's plate, not
 * an alphabetical roster.
 */
export function groupActiveByOwnerAndAge(items: QueueItem[], now: Date): OwnerAgeGroup[] {
  const active = items.filter((it) => isActive(it, now));

  const byOwner = new Map<string, QueueItem[]>();
  for (const it of active) {
    const arr = byOwner.get(it.assignee) ?? [];
    arr.push(it);
    byOwner.set(it.assignee, arr);
  }

  const groups: OwnerAgeGroup[] = [...byOwner.entries()].map(([owner, ownerItems]) => {
    const byAge: Record<QueueAgeBucket, QueueItem[]> = { "0-1d": [], "2-3d": [], "4-7d": [], "8d+": [] };
    let oldestDays = 0;
    for (const it of ownerItems) {
      byAge[ageBucketFor(it.createdAt, now)].push(it);
      oldestDays = Math.max(oldestDays, ageDaysOf(it.createdAt, now));
    }
    return { owner, total: ownerItems.length, byAge, oldestDays };
  });

  return groups.sort((a, b) => b.oldestDays - a.oldestDays);
}
