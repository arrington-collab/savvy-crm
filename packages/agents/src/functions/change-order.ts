import { withTenant, agentRun, approveChangeOrder } from "@savvy/db";
import { inngest } from "../client";

/** Thin wrapper so the Inngest fn stays a one-liner and the test can call the work directly. */
export async function applyAcceptedChangeOrder(tenantId: string, changeOrderId: string): Promise<{ invoiceCreated: boolean }> {
  const res = await approveChangeOrder({ tenantId, changeOrderId });
  await withTenant(tenantId, (tx) =>
    tx.insert(agentRun).values({ tenantId, agent: "finance", status: "ok" }),
  );
  return res;
}

export const changeOrderAccepted = inngest.createFunction(
  { id: "change-order-accepted", concurrency: { limit: 10 } },
  { event: "change_order/accepted" },
  async ({ event, step }) =>
    step.run("apply", () => applyAcceptedChangeOrder(event.data.tenantId, event.data.changeOrderId)),
);
