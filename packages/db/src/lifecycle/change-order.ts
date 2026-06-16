import { eq, sql } from "drizzle-orm";
import { withTenant } from "../tenant";
import { changeOrder } from "../schema/index";
import { computeChangeOrderTotal } from "@savvy/core";

type CoRow = typeof changeOrder.$inferSelect;

export async function createChangeOrder(input: {
  tenantId: string;
  jobId: string;
  customerId: string;
  reason?: string;
  lineItems: { amountCents: number }[];
}): Promise<CoRow> {
  const { subtotal, total } = computeChangeOrderTotal(input.lineItems);
  return withTenant(input.tenantId, async (tx) => {
    const [row] = await tx
      .insert(changeOrder)
      .values({
        tenantId: input.tenantId,
        jobId: input.jobId,
        customerId: input.customerId,
        reason: input.reason ?? null,
        status: "draft",
        lineItems: input.lineItems,
        subtotal,
        total,
      })
      .returning();
    return row!;
  });
}

export async function sendChangeOrder(input: {
  tenantId: string;
  changeOrderId: string;
  docusealSubmissionId: string;
  signingUrl: string;
}): Promise<void> {
  await withTenant(input.tenantId, (tx) =>
    tx
      .update(changeOrder)
      .set({ status: "sent", sentAt: sql`now()`, docusealSubmissionId: input.docusealSubmissionId, signingUrl: input.signingUrl })
      .where(eq(changeOrder.id, input.changeOrderId)),
  );
}
