import { adminDb, tenant } from "@savvy/db";
import { hourInTimeZone } from "@savvy/core";
import { inngest } from "../client";
import { sendTenantDigest } from "../ops-digest";

/**
 * Batched owner digests. Ticks hourly and fires each tenant at its local
 * digest_times (on-the-hour entries — the cron only ticks at :00). No hardcoded
 * TZ. Mirrors the task-health-sweep fan-out.
 */
export const opsDigest = inngest.createFunction(
  { id: "ops-digest" },
  { cron: "0 * * * *" },
  async ({ step }) => {
    const due = await step.run("due-tenants", async () => {
      const now = new Date();
      const tenants = await adminDb
        .select({ id: tenant.id, timezone: tenant.timezone, digestTimes: tenant.digestTimes })
        .from(tenant);
      return tenants
        .filter((t) => {
          const localHour = hourInTimeZone(now, t.timezone);
          return (t.digestTimes ?? []).some((dt) => dt.endsWith(":00") && parseInt(dt.slice(0, 2), 10) === localHour);
        })
        .map((t) => t.id);
    });
    let sent = 0;
    for (const id of due) {
      const r = await step.run(`digest:${id}`, () => sendTenantDigest(id));
      sent += r.sent;
    }
    return { sent };
  },
);
