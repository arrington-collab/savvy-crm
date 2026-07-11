import { addCalendarDays, startOfLocalDayInTimeZone } from "./tz";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validate a replay date. Accepts a real `YYYY-MM-DD` calendar date, else null
 * (so a junk `?replay=` param falls back to the live feed rather than throwing).
 */
export function parseReplayDate(raw: string | null | undefined): string | null {
  if (!raw || !DATE_RE.test(raw)) return null;
  const [y, m, d] = raw.split("-").map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  // Reject non-real dates that would roll over (e.g. 2026-02-30, 2026-13-01).
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return raw;
}

/** The `[start, end)` UTC instants bounding the tenant-local calendar day `civilDate`. */
export function replayDayBounds(civilDate: string, tz: string): { start: Date; end: Date } {
  return {
    start: startOfLocalDayInTimeZone(civilDate, tz),
    end: startOfLocalDayInTimeZone(addCalendarDays(civilDate, 1), tz),
  };
}

/**
 * How many runs are revealed at wall-clock `progress ∈ [0,1]` of the replay: every
 * run whose `startedAt` is at or before `start + progress·(end−start)`. Assumes
 * `startedAtMs` is ASC (the day loader orders by startedAt). Monotonic
 * non-decreasing in progress and clamped — the honest "by startedAt" timeline: a
 * run only appears once the scrubber reaches the moment it really happened.
 */
export function revealedRunCount(startedAtMs: number[], startMs: number, endMs: number, progress: number): number {
  const p = Math.max(0, Math.min(1, progress));
  const cutoff = startMs + p * (endMs - startMs);
  let count = 0;
  for (const t of startedAtMs) if (t <= cutoff) count++;
  return count;
}
