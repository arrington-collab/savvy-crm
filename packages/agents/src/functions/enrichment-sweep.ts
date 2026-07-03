import { adminDb, tenant } from "@savvy/db";
import { tenantsDueAtHour } from "@savvy/core";
import { inngest } from "../client";
import { sweepTenant } from "../enrichment";

/**
 * Background Ops: nightly per-tenant enrichment sweep. Walks the ordered enricher
 * registry, filling gaps the system couldn't fill at lead-creation time (e.g. an
 * address-only property → coords → year/roof/county). Convergent + rate-limited via
 * the enrichment_attempt ledger. Mirrors the cold-archive / meter-usage cron pattern.
 */
export const enrichmentSweep = inngest.createFunction(
  { id: "enrichment-sweep" },
  { cron: "0 * * * *" }, // hourly tick; runs each tenant at 03:00 its local time
  async ({ step }) => {
    const due = await step.run("due-tenants", async () => {
      const rows = await adminDb.select({ id: tenant.id, timezone: tenant.timezone }).from(tenant);
      return tenantsDueAtHour(rows, new Date(), 3).map((t) => t.id);
    });
    for (const id of due) {
      await step.run(`sweep:${id}`, () => sweepTenant(id));
    }
    return { tenants: due.length };
  },
);
