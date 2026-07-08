import { createMaterialOrderFromEstimate, RescissionHoldError } from "@savvy/db";
import { inngest } from "../client";

// Auto-generate the material order (BOM) when an estimate is accepted.
// Idempotent: createMaterialOrderFromEstimate returns the existing order on replay.
export const createMaterialOrderOnAccepted = inngest.createFunction(
  { id: "create-material-order-on-accepted", concurrency: { limit: 5 } },
  { event: "estimate/accepted" },
  async ({ event, step }) =>
    step.run("create-material-order", async () => {
      try {
        return await createMaterialOrderFromEstimate({ tenantId: event.data.tenantId, estimateId: event.data.estimateId });
      } catch (e) {
        // Rescission hold: defer ordering until the window elapses (re-fired on the next
        // acceptance / manual re-trigger). Not a failure.
        if (e instanceof RescissionHoldError) return { deferred: true, releaseAt: e.releaseAt.toISOString() };
        throw e;
      }
    }),
);
