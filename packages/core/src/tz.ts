/**
 * The local hour (0-23) at `now` in an IANA time zone. Used to fire per-tenant
 * crons at a tenant-local time: an hourly cron ticks, and each tenant runs when
 * its local hour matches. Pure + hydration-safe (explicit timeZone).
 */
export function hourInTimeZone(now: Date, tz: string): number {
  const h = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hour12: false }).format(now);
  return parseInt(h, 10) % 24; // some environments render midnight as "24"
}
