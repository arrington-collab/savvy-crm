// Phase 26 slice 5: the slow-week fill sweep. Detects crew gaps inside the
// look-ahead window and generates fill plays; scheduled touches then send on
// the 10am relationship-cadence rail. Runs at 9am tenant-local so a fresh
// gap's offers go out the same morning. Every run is agent_run evidence for
// the fill.gap_resolution invariant.

import { adminDb, tenant as tenantTbl, isDemoTenant, runFillSweep, withAgentRun, type FillSweepResult } from "@savvy/db";
import { parseFinanceConfig, hourInTimeZone } from "@savvy/core";
import { inngest } from "../client";

export async function sweepTenantFill(tenantId: string, now = new Date()): Promise<FillSweepResult> {
  if (await isDemoTenant(tenantId)) return { gapsDetected: 0, playsCreated: 0, passes: 0 };
  return withAgentRun(
    { tenantId, agent: "scheduling", taskKey: "fill.gap_resolution", jobId: null, leadId: null },
    () => runFillSweep(tenantId, now),
  );
}

export const fillSweep = inngest.createFunction(
  { id: "fill-sweep" },
  { cron: "0 * * * *" }, // hourly tick; runs each tenant at 09:00 its local time
  async ({ step }) => {
    const tenants = await step.run("due-tenants", async () => {
      const rows = await adminDb.select({ id: tenantTbl.id, settings: tenantTbl.settings }).from(tenantTbl);
      const now = new Date();
      return rows
        .filter((r) => hourInTimeZone(now, parseFinanceConfig((r.settings as { finance?: unknown } | null)?.finance).timezone) === 9)
        .map((r) => r.id);
    });
    let gaps = 0, plays = 0, passes = 0;
    for (const tenantId of tenants) {
      const r = await step.run(`sweep-${tenantId}`, () => sweepTenantFill(tenantId));
      gaps += r.gapsDetected; plays += r.playsCreated; passes += r.passes;
    }
    return { tenants: tenants.length, gaps, plays, passes };
  },
);
