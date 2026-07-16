import { adminDb, tenant, sweepCertRequests } from "@savvy/db";
import { inngest } from "../client";

/**
 * Partner Ledger slice 4: the cert lane's engine. Hourly, per tenant —
 * advances booked→inspected when fieldwork completes and AUTO-DELIVERS the
 * moment the inspector approves (job + invoice + permanent cert link).
 * Delivery is automatic, never a button someone forgets; the cert.sla
 * evidence check (delivered-or-declined ≤48h) catches anything that stalls.
 */
export const certSlaSweep = inngest.createFunction(
  { id: "cert-sla-sweep" },
  { cron: "0 * * * *" },
  async ({ step }) => {
    const ids = await step.run("tenants", async () => {
      const rows = await adminDb.select({ id: tenant.id }).from(tenant);
      return rows.map((r) => r.id);
    });
    let delivered = 0;
    let inspected = 0;
    for (const id of ids) {
      const r = await step.run(`sweep:${id}`, () => sweepCertRequests(id, new Date()));
      delivered += r.delivered;
      inspected += r.inspected;
    }
    return { tenants: ids.length, inspected, delivered };
  },
);
