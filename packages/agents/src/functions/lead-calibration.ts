import { adminDb, tenant, recordAgentRun, getCalibrationInputs } from "@savvy/db";
import { hourInTimeZone, dayOfMonthInTimeZone, computeCalibration } from "@savvy/core";
import { inngest } from "../client";

const CALIBRATION_HOUR = 7; // 07:00 on the 1st, tenant-local (after the 06:00 usage meter)

/**
 * Slice 5 calibration hook (no ML): once a month, per tenant on ITS timezone,
 * compare score bands to resolved outcomes. Below the resolved-lead threshold it
 * simply records the run ("insufficient data"); the digest surfaces the numbers
 * live once the report flips to active. Records an agent_run as the monthly proof.
 */
export const leadCalibrationMonthly = inngest.createFunction(
  { id: "lead-calibration-monthly", concurrency: { limit: 1 } },
  { cron: "0 * * * *" }, // hourly tick; each tenant calibrates at 07:00 on the 1st of ITS local month
  async ({ step }) => {
    const due = await step.run("due-tenants", async () => {
      const now = new Date();
      const rows = await adminDb.select({ id: tenant.id, timezone: tenant.timezone }).from(tenant);
      return rows
        .filter((t) => hourInTimeZone(now, t.timezone) === CALIBRATION_HOUR && dayOfMonthInTimeZone(now, t.timezone) === 1)
        .map((t) => t.id);
    });
    for (const id of due) {
      await step.run(`calibrate-${id}`, async () => {
        const report = computeCalibration(await getCalibrationInputs(id));
        await recordAgentRun({ tenantId: id, agent: "orchestrator", taskKey: "lead.calibration", status: "ok" });
        return { status: report.status, n: report.n };
      });
    }
    return { calibrated: due.length };
  },
);
