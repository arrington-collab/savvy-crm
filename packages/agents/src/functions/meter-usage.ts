import { adminDb, recordUsageSnapshot, tenant } from "@savvy/db";
import { hourInTimeZone, dayOfMonthInTimeZone, priorMonthKeyInTimeZone } from "@savvy/core";
import { inngest } from "../client";

const METER_HOUR = 6; // 06:00 on the 1st, tenant-local

/** Prior-month key in UTC, e.g. run in July -> "2026-06". Retained as a UTC util. */
export function priorMonthKey(now: Date): string {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth(); // 0-based; prior month = m-1, handled by Date
  const d = new Date(Date.UTC(y, m - 1, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export const meterUsageMonthly = inngest.createFunction(
  { id: "meter-usage-monthly", concurrency: { limit: 1 } },
  { cron: "0 * * * *" }, // hourly tick; each tenant meters at 06:00 on the 1st of ITS local month
  async ({ step }) => {
    // Due = tenants for which it is 06:00 on the 1st locally; each gets its own
    // prior-month period key (local month boundary can differ from UTC).
    const due = await step.run("due-tenants", async () => {
      const now = new Date();
      const rows = await adminDb.select({ id: tenant.id, timezone: tenant.timezone }).from(tenant);
      return rows
        .filter((t) => hourInTimeZone(now, t.timezone) === METER_HOUR && dayOfMonthInTimeZone(now, t.timezone) === 1)
        .map((t) => ({ id: t.id, periodKey: priorMonthKeyInTimeZone(now, t.timezone) }));
    });
    for (const t of due) {
      await step.run(`meter-${t.id}`, () => recordUsageSnapshot(t.id, t.periodKey));
    }
    return { metered: due.length };
  },
);
