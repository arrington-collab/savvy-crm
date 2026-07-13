import { withTenant, readKnockForAlert, createSaleNoContractAlerts } from "@savvy/db";
import { inngest } from "../client";

// A sale with no signed contract after 30 minutes → alert the seller + managers.
// Silent when the contract landed in time (the field app stamps contract_signed_at
// on the knock) or the knock is no longer a sale.
export const canvassSaleContractWatch = inngest.createFunction(
  { id: "canvass-sale-contract-watch", concurrency: { limit: 10 } },
  { event: "canvass/sale.logged" },
  async ({ event, step }) => {
    const { tenantId, knockId, repId } = event.data as { tenantId: string; knockId: string; repId: string };
    await step.sleep("grace-30m", "30m");
    return await step.run("alert-if-no-contract", () =>
      withTenant(tenantId, async (tx) => {
        const k = await readKnockForAlert(tx, knockId);
        if (!k || k.outcome !== "sale" || k.contractSignedAt) return { alerted: 0, reason: "resolved" as const };
        const label = k.contactName || k.address || "A sale";
        const { created } = await createSaleNoContractAlerts(tx, tenantId, { knockId, sellerRepId: repId, contactLabel: label });
        return { alerted: created };
      }),
    );
  },
);
