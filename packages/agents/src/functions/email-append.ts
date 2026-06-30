import { adminDb, tenant, findCustomersNeedingEmail, setCustomerEmail } from "@savvy/db";
import { emailFinder as defaultFinder, type EmailFinder } from "@savvy/integrations";
import { inngest } from "../client";

/**
 * Append emails for one tenant's emailless customers via the skip-trace finder.
 * setCustomerEmail tags them source='appended' (and refuses to overwrite an
 * existing address). Returns how many were filled.
 */
export async function appendEmailsForTenant(tenantId: string, finder: EmailFinder = defaultFinder, limit = 25): Promise<number> {
  const due = await findCustomersNeedingEmail(tenantId, limit);
  let filled = 0;
  for (const c of due) {
    const email = await finder.findEmail({ name: c.name, phone: c.phone });
    if (!email) continue;
    if (await setCustomerEmail(tenantId, { customerId: c.customerId, email, source: "appended" })) filled++;
  }
  return filled;
}

/**
 * Dormant nightly skip-trace append. With the default (dormant) finder it's a no-op;
 * wiring a real provider behind EmailFinder activates it. Appended emails are
 * transactional-only — the drip guard keeps them out of marketing.
 */
export const emailAppendSweep = inngest.createFunction(
  { id: "email-append-sweep", concurrency: { limit: 1 } },
  { cron: "TZ=America/Phoenix 0 5 * * *" },
  async ({ step }) => {
    const tenants = await step.run("list-tenants", async () => adminDb.select({ id: tenant.id }).from(tenant));
    let filled = 0;
    for (const t of tenants) {
      filled += await step.run(`append-${t.id}`, () => appendEmailsForTenant(t.id));
    }
    return { filled };
  },
);
