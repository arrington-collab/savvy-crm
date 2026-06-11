import { withTenant, recordCommission, eq, agentRun, invoice } from "@savvy/db";
import { inngest } from "../client";

/**
 * Fires on invoice/paid. Calls the idempotent recordCommission helper which
 * resolves the rep, reads finance config, computes the amount, and inserts the
 * commission row. Returns null when it legitimately skips (no assigned rep, or
 * profit model without job cost).
 *
 * Two discrete step.run calls so Inngest memoizes each independently.
 *
 * agentRun.status is plain text (not a pgEnum); valid values are running|ok|error.
 * "skipped" is not a valid value — we use "ok" for both the recorded and the
 * skipped cases. The return value captures whether commission was actually written.
 */
export const commissionOnPaid = inngest.createFunction(
  { id: "commission-on-paid", concurrency: { limit: 20 } },
  { event: "invoice/paid" },
  async ({ event, step }) => {
    const { tenantId, invoiceId } = event.data;

    const result = await step.run("record-commission", async () =>
      recordCommission({ tenantId, invoiceId }),
    );

    await step.run("log", async () =>
      withTenant(tenantId, async (tx) => {
        const [inv] = await tx.select().from(invoice).where(eq(invoice.id, invoiceId));
        await tx.insert(agentRun).values({
          tenantId,
          agent: "finance",
          jobId: inv?.jobId ?? null,
          status: "ok",
        });
      }),
    );

    return { commission: result };
  },
);
