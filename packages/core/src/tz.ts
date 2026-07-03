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
