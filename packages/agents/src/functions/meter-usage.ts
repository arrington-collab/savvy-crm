import { adminDb, recordUsageSnapshot, tenant } from "@savvy/db";
import { inngest } from "../client";

/** Prior-month key in UTC, e.g. run in July -> "2026-06". */
export function priorMonthKey(now: Date): string {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth(); // 0-based; prior month = m-1, handled by Date
  const d = new Date(Date.UTC(y, m - 1, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export const meterUsageMonthly = inngest.createFunction(
  { id: "meter-usage-monthly", concurrency: { limit: 1 } },
  { cron: "TZ=America/Phoenix 0 6 1 * *" }, // 06:00 on the 1st, meters the prior month
  async ({ step }) => {
    const periodKey = await step.run("period", async () => priorMonthKey(new Date()));
    const tenants = await step.run("list-tenants", async () => adminDb.select({ id: tenant.id }).from(tenant));
    for (const t of tenants) {
      await step.run(`meter-${t.id}`, () => recordUsageSnapshot(t.id, periodKey));
    }
    return { metered: tenants.length, periodKey };
  },
);
