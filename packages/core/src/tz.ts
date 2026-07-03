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
