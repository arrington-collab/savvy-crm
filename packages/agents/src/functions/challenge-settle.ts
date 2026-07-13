import { adminDb, tenant, withTenant, settleDueChallenges } from "@savvy/db";
import { inngest } from "../client";

// Hourly: settle any challenge whose window has ended. GET /challenges also
// settles opportunistically; this is the backstop for challenges no one reads.
export const challengeSettleHourly = inngest.createFunction(
  { id: "challenge-settle-hourly" },
  { cron: "0 * * * *" },
  async ({ step }) => {
    const tenants = await step.run("tenants", () => adminDb.select({ id: tenant.id }).from(tenant));
    let settled = 0;
    for (const t of tenants) {
      settled += await step.run(`settle:${t.id}`, () => withTenant(t.id, (tx) => settleDueChallenges(tx, t.id, new Date())));
    }
    return { settled };
  },
);
