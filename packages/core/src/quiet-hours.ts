export type QuietHours = { startHour: number; endHour: number };

/** Hour-of-day (0–23) for `date` in the given IANA timezone. */
function localHour(date: Date, tz: string): number {
  const s = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", hour12: false }).format(date);
  const h = parseInt(s, 10);
  return h === 24 ? 0 : h; // some runtimes format midnight as "24"
}

/** Quiet window wraps midnight when startHour > endHour (e.g. 21 → 8). */
export function isWithinQuietHours(date: Date, tz: string, qh: QuietHours): boolean {
  const h = localHour(date, tz);
  if (qh.startHour === qh.endHour) return false;
  return qh.startHour > qh.endHour
    ? h >= qh.startHour || h < qh.endHour // wraps midnight
    : h >= qh.startHour && h < qh.endHour;
}

/** First instant ≥ `date` that is NOT within quiet hours (advances 1h at a time, capped at 48 steps). */
export function nextAllowedSendTime(date: Date, tz: string, qh: QuietHours): Date {
  let t = new Date(date.getTime());
  for (let i = 0; i < 48 && isWithinQuietHours(t, tz, qh); i++) {
    t = new Date(t.getTime() + 60 * 60 * 1000);
  }
  return t;
}
