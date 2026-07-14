// Production Pulse slice 3: the hourly detector heartbeat. The exception queue
// derives its cards on read — this sweep exists so production.silence_detection
// has PROOF the detectors ran (an agent_run row every hour per active tenant),
// and so the daily digest can carry the one routine summary line.

import {
  adminDb, tenant as tenantTbl, withAgentRun,
  paceLagPhases, silentCrewDays, lateCrewAppointments, eodGaps, listOpenBlockers,
} from "@savvy/db";
import { inngest } from "../client";

export async function sweepTenantProductionDetectors(tenantId: string, now = new Date()): Promise<{
  paceLags: number; silences: number; lates: number; eodMissing: number; blockers: number;
}> {
  return withAgentRun(
    // THE heartbeat: production.silence_detection evidence = this run exists hourly.
    { tenantId, agent: "orchestrator", taskKey: "production_pulse.detectors", jobId: null, leadId: null },
    async () => {
      const dayKey = now.toISOString().slice(0, 10);
      const [lags, silences, lates, eod, blockers] = await Promise.all([
        paceLagPhases(tenantId, now),
        silentCrewDays(tenantId, now),
        lateCrewAppointments(tenantId, now),
        eodGaps(tenantId, dayKey),
        listOpenBlockers(tenantId),
      ]);
      return { paceLags: lags.length, silences: silences.length, lates: lates.length, eodMissing: eod.length, blockers: blockers.length };
    },
  );
}

export const productionDetectorSweep = inngest.createFunction(
  { id: "production-detector-sweep" },
  { cron: "0 * * * *" },
  async ({ step }) => {
    const tenants = await step.run("tenants", async () =>
      (await adminDb.select({ id: tenantTbl.id }).from(tenantTbl)).map((r) => r.id));
    let totals = { paceLags: 0, silences: 0, lates: 0, eodMissing: 0, blockers: 0 };
    for (const tenantId of tenants) {
      const r = await step.run(`sweep-${tenantId}`, () => sweepTenantProductionDetectors(tenantId));
      totals = {
        paceLags: totals.paceLags + r.paceLags, silences: totals.silences + r.silences,
        lates: totals.lates + r.lates, eodMissing: totals.eodMissing + r.eodMissing, blockers: totals.blockers + r.blockers,
      };
    }
    return { tenants: tenants.length, ...totals };
  },
);
