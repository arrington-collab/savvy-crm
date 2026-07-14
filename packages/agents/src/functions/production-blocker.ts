// Production Pulse slice 3: hidden-damage blockers auto-draft a change-order
// stub (the 6c machinery) with the crew's photos attached — the office card
// arrives with the paperwork already started.

import { withTenant, eq, job, productionBlocker, createChangeOrder, attachBlockerChangeOrder, withAgentRun } from "@savvy/db";
import { draftChangeOrderScope } from "./change-order-draft";
import { inngest } from "../client";

export async function draftBlockerChangeOrderStub(input: {
  tenantId: string;
  jobId: string;
  blockerId: string;
}): Promise<{ changeOrderId: string } | { skipped: string }> {
  const [blocker] = await withTenant(input.tenantId, (tx) => tx.select().from(productionBlocker)
    .where(eq(productionBlocker.id, input.blockerId)));
  if (!blocker || blocker.kind !== "hidden_damage") return { skipped: "not_hidden_damage" };
  if (blocker.changeOrderId) return { skipped: "already_drafted" };

  const [j] = await withTenant(input.tenantId, (tx) => tx.select({ customerId: job.customerId }).from(job)
    .where(eq(job.id, input.jobId)));
  if (!j?.customerId) return { skipped: "no_customer" };

  return withAgentRun(
    { tenantId: input.tenantId, agent: "orchestrator", taskKey: "production_pulse.blocker_co_stub", jobId: input.jobId, leadId: null },
    async () => {
      const scope = await draftChangeOrderScope({
        tenantId: input.tenantId, jobId: input.jobId,
        description: blocker.note ?? "Hidden damage discovered during production",
      });
      const co = await createChangeOrder({
        tenantId: input.tenantId, jobId: input.jobId, customerId: j.customerId!,
        reason: `Hidden damage (crew report): ${blocker.note ?? "see photos"}`,
        lineItems: scope.lineItems,
      });
      await attachBlockerChangeOrder({ tenantId: input.tenantId, blockerId: input.blockerId, changeOrderId: co.id });
      return { changeOrderId: co.id };
    },
  );
}

export const productionBlockerStub = inngest.createFunction(
  { id: "production-blocker-stub", retries: 2 },
  { event: "production/blocker.reported" },
  async ({ event, step }) => {
    const { tenantId, jobId, blockerId, kind } = event.data;
    if (kind !== "hidden_damage") return { skipped: "not_hidden_damage" };
    return step.run("draft-co-stub", () => draftBlockerChangeOrderStub({ tenantId, jobId, blockerId }));
  },
);
