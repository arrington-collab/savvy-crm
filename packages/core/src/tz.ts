/**
 * The local hour (0-23) at `now` in an IANA time zone. Used to fire per-tenant
 * crons at a tenant-local time: an hourly cron ticks, and each tenant runs when
 * its local hour matches. Pure + hydration-safe (explicit timeZone).
 */
export function hourInTimeZone(now: Date, tz: string): number {
  const h = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hour12: false }).format(now);
  return parseInt(h, 10) % 24; // some environments render midnight as "24"
}

/**
 * Filters tenants to those for which it is `hour` (0-23) local right now — the
 * shared gate for every tenant-local daily cron. Each cron ticks hourly and runs
 * only its due tenants, so a fixed-TZ cron string is never needed.
 */
export function tenantsDueAtHour<T extends { timezone: string }>(tenants: T[], now: Date, hour: number): T[] {
  return tenants.filter((t) => hourInTimeZone(now, t.timezone) === hour);
}

/** "YYYY-MM-DD" of the local calendar day at `now` in an IANA zone. Used to
 * bucket/report by the tenant's day, not the server's UTC day. */
export function dateKeyInTimeZone(now: Date, tz: string): string {
  // en-CA formats as YYYY-MM-DD
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** The local day-of-month (1-31) at `now` in an IANA zone — gates day-of-month crons (e.g. the 1st). */
export function dayOfMonthInTimeZone(now: Date, tz: string): number {
  const d = new Intl.DateTimeFormat("en-US", { timeZone: tz, day: "numeric" }).format(now);
  return parseInt(d, 10);
}

/**
 * "YYYY-MM" of the month BEFORE the tenant's current LOCAL month — the period a
 * monthly meter run bills. Keyed off local (not UTC) month so a tenant near a
 * month boundary meters the correct period.
 */
export function priorMonthKeyInTimeZone(now: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "numeric" }).formatToParts(now);
  const y = Number(parts.find((p) => p.type === "year")!.value);
  const m = Number(parts.find((p) => p.type === "month")!.value); // 1-12 local month
  const d = new Date(Date.UTC(y, m - 2, 1)); // m-1 = current (0-based), −1 more = prior; Date handles year wrap
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Offset (ms) to add to a UTC instant to get its wall-clock reading in `tz`. */
function tzOffsetMs(instant: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "numeric", day: "numeric",
    hour: "numeric", minute: "numeric", second: "numeric", hour12: false,
  }).formatToParts(instant);
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const hour = get("hour") % 24; // normalize a "24" midnight
  const asUTC = Date.UTC(get("year"), get("month") - 1, get("day"), hour, get("minute"), get("second"));
  return asUTC - instant.getTime();
}

/**
 * The UTC instant corresponding to `hour:00` LOCAL time on the same local
 * calendar day as `anchor`, in IANA zone `tz`. DST-correct (resolves the zone's
 * offset at the target wall-clock, not the anchor's). Used to schedule
 * wall-clock-anchored homeowner touches ("6pm the evening before", "7am day-of").
 */
export function instantAtLocalHourOnDayOf(anchor: Date, tz: string, hour: number): Date {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "numeric", day: "numeric" }).formatToParts(anchor);
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const guess = Date.UTC(get("year"), get("month") - 1, get("day"), hour, 0, 0);
  // Resolve the offset at the guessed instant, then correct once — sufficient at hour granularity.
  const offset = tzOffsetMs(new Date(guess), tz);
  return new Date(guess - offset);
}

/**
 * The UTC instant whose wall-clock reading in `tz` is the same hour:minute:second
 * as `sourceLocalTime`, but on calendar day `targetCivilDate` (YYYY-MM-DD).
 * Used to move an appointment to a new day while preserving its time-of-day.
 */
export function instantAtLocalTimeOnDate(targetCivilDate: string, sourceLocalTime: Date, tz: string): Date {
  const [y, m, d] = targetCivilDate.split("-").map(Number) as [number, number, number];
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "numeric", second: "numeric", hour12: false }).formatToParts(sourceLocalTime);
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const hour = get("hour") % 24; // normalize a "24" midnight
  const guess = Date.UTC(y, m - 1, d, hour, get("minute"), get("second"));
  const offset = tzOffsetMs(new Date(guess), tz);
  return new Date(guess - offset);
}
