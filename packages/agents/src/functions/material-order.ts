import { createMaterialOrderFromEstimate } from "@savvy/db";
import { inngest } from "../client";

// Auto-generate the material order (BOM) when an estimate is accepted.
// Idempotent: createMaterialOrderFromEstimate returns the existing order on replay.
export const createMaterialOrderOnAccepted = inngest.createFunction(
  { id: "create-material-order-on-accepted", concurrency: { limit: 5 } },
  { event: "estimate/accepted" },
  async ({ event, step }) =>
    step.run("create-material-order", () =>
      createMaterialOrderFromEstimate({ tenantId: event.data.tenantId, estimateId: event.data.estimateId }),
    ),
);
