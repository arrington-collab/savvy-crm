import { addDays } from "@savvy/core";
import { denverDayWindow } from "./day-window";

// Monday-start week, per spec Appendix A.1: Monday 00:00:00 → Sunday 23:59:59.999
// America/Denver. `weekStart` is always the Monday's YYYY-MM-DD Denver business-date
// string. All arithmetic here is on civil-date strings (day-of-week for a calendar
// date is timezone-independent), mirroring the precedent in
// `@savvy/core` `schedule-view.ts` (`addDays`/`weekday`). Only `denverWeekWindow`
// touches real UTC instants, and it does so by delegating to the already
// DST-robust `denverDayWindow` — never reinventing that math.

/** Day-of-week (0 = Sunday .. 6 = Saturday) of a YYYY-MM-DD civil date string. */
function weekdayOf(businessDate: string): number {
  const [y, m, d] = businessDate.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!, 12)).getUTCDay();
}

/** The Monday YYYY-MM-DD (Denver business date) of the week containing `businessDate`. */
export function weekStartOf(businessDate: string): string {
  const dow = weekdayOf(businessDate); // 0=Sun..6=Sat
  const daysSinceMonday = (dow + 6) % 7; // Mon=0, Tue=1, ..., Sun=6
  return addDays(businessDate, -daysSinceMonday);
}

/** The 7 Denver business-date strings Mon→Sun for the week starting `weekStart`. */
export function weekDates(weekStart: string): string[] {
  return Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
}

/**
 * `n` (default 13) trailing Monday business-date strings, oldest→newest,
 * including `currentWeekStart` itself as the last entry.
 */
export function trailingWeekStarts(currentWeekStart: string, n = 13): string[] {
  return Array.from({ length: n }, (_, i) => addDays(currentWeekStart, -7 * (n - 1 - i)));
}

/**
 * The Denver-local week window for `weekStart`: Monday 00:00:00 → Sunday
 * 23:59:59.999 America/Denver, expressed as UTC instants. DST-safe because it
 * delegates both ends to `denverDayWindow`, which already handles the Denver
 * offset correctly across DST transitions (e.g. a week spanning the Nov
 * fall-back is 169 wall-clock hours, not 168).
 */
export function denverWeekWindow(weekStart: string): { startUtc: Date; endUtc: Date } {
  const dates = weekDates(weekStart);
  const monday = dates[0]!;
  const sunday = dates[6]!;
  const { startUtc } = denverDayWindow(monday);
  const { endUtc } = denverDayWindow(sunday);
  return { startUtc, endUtc };
}
