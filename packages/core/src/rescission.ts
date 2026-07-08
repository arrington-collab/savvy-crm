import { instantAtLocalTimeOnDate, instantAtLocalHourOnDayOf } from "./tz";

export const RESCISSION_DAYS_DEFAULT: Record<string, number> = { CO: 10, AZ: 3 };
export const RESCISSION_DAYS_FALLBACK = 3;

/** Rescission cooling-off days for a jurisdiction: tenant override ?? statutory default ?? fallback. */
export function rescissionDaysFor(state: string | null, config?: Record<string, number>): number {
  const key = (state ?? "").trim().toUpperCase();
  if (config && key in config) return config[key]!;
  if (key in RESCISSION_DAYS_DEFAULT) return RESCISSION_DAYS_DEFAULT[key]!;
  return RESCISSION_DAYS_FALLBACK;
}

function civilDateInTZ(instant: Date, tz: string): string {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(instant);
  const g = (t: string) => p.find((x) => x.type === t)!.value;
  return `${g("year")}-${g("month")}-${g("day")}`;
}

function addCalendarDays(civil: string, n: number): string {
  const [y, m, d] = civil.split("-").map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

/** The UTC instant of 00:00 tenant-local time on (signing civil date + N rescission days). */
export function rescissionReleaseAt(input: { state: string | null; signedAt: Date; timezone: string; config?: Record<string, number> }): Date {
  const days = rescissionDaysFor(input.state, input.config);
  const targetCivil = addCalendarDays(civilDateInTZ(input.signedAt, input.timezone), days);
  // An instant on the target civil day (preserving signedAt's time-of-day), then snapped to local midnight.
  const onTargetDay = instantAtLocalTimeOnDate(targetCivil, input.signedAt, input.timezone);
  return instantAtLocalHourOnDayOf(onTargetDay, input.timezone, 0);
}

/** True while now is strictly before the hold instant; false when hold is null or elapsed (auto-release). */
export function isRescissionHeld(holdUntil: Date | null, now: Date): boolean {
  return holdUntil != null && now.getTime() < holdUntil.getTime();
}
