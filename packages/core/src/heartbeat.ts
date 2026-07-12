/**
 * Presentational state for an entity's heartbeat chip + cold badge (spec §4).
 * `lastTouch` is the newest of any agent OR human action on the entity; `createdAt`
 * is the entity's own creation — the floor used for coldness when nothing has
 * touched it yet (a brand-new untouched lead isn't "cold" until COLD_DAYS after it
 * was created). Cold is a pure elapsed-duration threshold, timezone-independent.
 */
export interface HeartbeatState {
  hasActivity: boolean;
  label: string;
  cold: boolean;
}

function relTime(now: Date, then: Date): string {
  const mins = Math.max(0, Math.round((now.getTime() - then.getTime()) / 60_000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

export function heartbeatState(lastTouch: Date | null, createdAt: Date, now: Date, coldDays: number): HeartbeatState {
  const hasActivity = lastTouch !== null;
  const reference = lastTouch ?? createdAt; // cold measured from last touch, else from creation
  const cold = now.getTime() - reference.getTime() > coldDays * 86_400_000;
  return { hasActivity, label: hasActivity ? relTime(now, lastTouch as Date) : "no activity yet", cold };
}

/** Merge per-source [{id, ts}] lists into one Map<id, newest ts>. */
export function mergeLastTouch(sources: ReadonlyArray<ReadonlyArray<{ id: string; ts: Date }>>): Map<string, Date> {
  const out = new Map<string, Date>();
  for (const source of sources) {
    for (const { id, ts } of source) {
      const cur = out.get(id);
      if (!cur || ts.getTime() > cur.getTime()) out.set(id, ts);
    }
  }
  return out;
}
