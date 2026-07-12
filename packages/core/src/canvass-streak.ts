import { dateKeyInTimeZone } from "./tz";

// Streaks in the tenant's local calendar days, not UTC.
function dayKeySet(times: Date[], tz: string): Set<string> {
  return new Set(times.map((t) => dateKeyInTimeZone(t, tz)));
}
function addDays(key: string, delta: number): string {
  const [y, m, d] = key.split("-").map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d! + delta));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

/** Consecutive local days with ≥1 knock, ending today or (grace) yesterday. */
export function currentStreak(times: Date[], tz: string, now: Date = new Date()): number {
  if (times.length === 0) return 0;
  const days = dayKeySet(times, tz);
  const today = dateKeyInTimeZone(now, tz);
  let cursor = days.has(today) ? today : addDays(today, -1);
  if (!days.has(cursor)) return 0;
  let n = 0;
  while (days.has(cursor)) {
    n++;
    cursor = addDays(cursor, -1);
  }
  return n;
}

/** Longest run of consecutive local days across all history. */
export function bestStreak(times: Date[], tz: string): number {
  if (times.length === 0) return 0;
  const keys = [...dayKeySet(times, tz)].sort();
  let best = 1;
  let run = 1;
  for (let i = 1; i < keys.length; i++) {
    run = keys[i] === addDays(keys[i - 1]!, 1) ? run + 1 : 1;
    if (run > best) best = run;
  }
  return best;
}
