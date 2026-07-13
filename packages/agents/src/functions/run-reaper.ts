import { adminDb, tenant, markStaleRunsTimedOut } from "@savvy/db";
import { SHOWCASE } from "@savvy/core";
import { inngest } from "../client";

/** Every 5 minutes: flip orphaned `running` agent_run rows to error/timed_out
 *  across all tenants, so a crashed function never leaves a stuck spinner. */
export const runReaper = inngest.createFunction(
  { id: "run-reaper", concurrency: { limit: 1 } },
  { cron: "*/5 * * * *" },
  async ({ step }) => {
    const cutoff = await step.run("cutoff", async () =>
      new Date(Date.now() - SHOWCASE.RUN_STALE_MINUTES * 60_000));
    const tenants = await step.run("tenants", async () =>
      (await adminDb.select({ id: tenant.id }).from(tenant)).map((t) => t.id));
    let closed = 0;
    for (const id of tenants) {
      closed += await step.run(`reap-${id}`, () =>
        markStaleRunsTimedOut(id, new Date(cutoff as unknown as string)));
    }
    return { closed };
  },
);
