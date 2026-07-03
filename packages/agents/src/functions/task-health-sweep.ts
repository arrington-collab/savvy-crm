import { adminDb, tenant } from "@savvy/db";
import { tenantsDueAtHour } from "@savvy/core";
import { inngest } from "../client";
import { sweepTenantHealth } from "../health-sweep";

const SWEEP_HOUR = 4; // 04:00 tenant-local

/**
 * The nightly scoreboard sweep. Inngest crons fire at a fixed time, so this
 * ticks HOURLY and runs each tenant only when it is 04:00 in that tenant's own
 * timezone — no hardcoded TZ. Per due tenant it runs the evidence checks and
 * recomputes task_health (see sweepTenantHealth). Mirrors the enrichment-sweep
 * fan-out pattern.
 */
export const taskHealthSweep = inngest.createFunction(
  { id: "task-health-sweep" },
  { cron: "0 * * * *" },
  async ({ step }) => {
    const due = await step.run("due-tenants", async () => {
      const tenants = await adminDb.select({ id: tenant.id, timezone: tenant.timezone }).from(tenant);
      return tenantsDueAtHour(tenants, new Date(), SWEEP_HOUR).map((t) => t.id);
    });
    for (const id of due) {
      await step.run(`sweep:${id}`, () => sweepTenantHealth(id));
    }
    return { swept: due.length };
  },
);
