import { adminDb, tenant, backfillPartnerAttribution } from "@savvy/db";
import { inngest } from "../client";

/**
 * Partner Ledger slice 1: self-healing attribution. Intake now stamps
 * lead.partner_id at creation, so normally this sweep finds nothing — it
 * exists to (a) fold PRE-0097 free-text source_detail into partner records
 * on its first pass per tenant, and (b) catch any lead that slips through a
 * path the schema guard doesn't cover. Idempotent (only touches leads with
 * partner_id IS NULL); unattributable leads are left for the
 * partner.attribution evidence check to surface.
 */
export const partnerAttributionSweep = inngest.createFunction(
  { id: "partner-attribution-sweep" },
  { cron: "0 * * * *" },
  async ({ step }) => {
    const ids = await step.run("tenants", async () => {
      const rows = await adminDb.select({ id: tenant.id }).from(tenant);
      return rows.map((r) => r.id);
    });
    let attributed = 0;
    for (const id of ids) {
      const r = await step.run(`backfill:${id}`, () => backfillPartnerAttribution(id));
      attributed += r.attributed;
    }
    return { tenants: ids.length, attributed };
  },
);
