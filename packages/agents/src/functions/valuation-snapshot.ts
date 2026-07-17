// Owner's Room slice 1: the monthly valuation snapshot. 08:00 on the 1st,
// tenant-local (after metering at 6 and calibration at 7 — the snapshot reads
// their outputs). Every run is agent_run evidence for valuation.snapshot_cadence.

import { adminDb, isDemoTenant, recordAgentRun, recordValuationSnapshot, tenant } from "@savvy/db";
import { hourInTimeZone, dayOfMonthInTimeZone, priorMonthKeyInTimeZone } from "@savvy/core";
import { inngest } from "../client";

const SNAPSHOT_HOUR = 8;

export async function snapshotTenantValuation(tenantId: string, periodKey: string, now = new Date()): Promise<boolean> {
  if (await isDemoTenant(tenantId)) return false;
  await recordValuationSnapshot(tenantId, periodKey, now);
  await recordAgentRun({ tenantId, agent: "finance", taskKey: "valuation.snapshot_cadence", status: "ok" });
  return true;
}

export const valuationSnapshotMonthly = inngest.createFunction(
  { id: "valuation-snapshot-monthly", concurrency: { limit: 1 } },
  { cron: "0 * * * *" }, // hourly tick; each tenant snapshots at 08:00 on the 1st of ITS local month
  async ({ step }) => {
    const due = await step.run("due-tenants", async () => {
      const now = new Date();
      const rows = await adminDb.select({ id: tenant.id, timezone: tenant.timezone }).from(tenant);
      return rows
        .filter((t) => hourInTimeZone(now, t.timezone) === SNAPSHOT_HOUR && dayOfMonthInTimeZone(now, t.timezone) === 1)
        .map((t) => ({ id: t.id, periodKey: priorMonthKeyInTimeZone(now, t.timezone) }));
    });
    let snapshotted = 0;
    for (const t of due) {
      const ok = await step.run(`snapshot-${t.id}`, () => snapshotTenantValuation(t.id, t.periodKey));
      if (ok) snapshotted += 1;
    }
    return { snapshotted };
  },
);
