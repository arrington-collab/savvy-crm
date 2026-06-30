import { adminDb, tenant } from "@savvy/db";
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
  { cron: "TZ=America/Phoenix 0 3 * * *" },
  async ({ step }) => {
    const tenants = await step.run("list-tenants", async () => adminDb.select({ id: tenant.id }).from(tenant));
    for (const t of tenants) {
      await step.run(`sweep:${t.id}`, () => sweepTenant(t.id));
    }
    return { tenants: tenants.length };
  },
);
