import "server-only";
import { withTenant, changeOrder, eq, desc } from "@savvy/db";
import { getTenantId } from "./tenant";

export async function listChangeOrdersForJob(jobId: string) {
  const tenantId = await getTenantId();
  return withTenant(tenantId, (tx) =>
    tx.select().from(changeOrder).where(eq(changeOrder.jobId, jobId)).orderBy(desc(changeOrder.createdAt)),
  );
}

export async function getChangeOrder(changeOrderId: string) {
  const tenantId = await getTenantId();
  const [row] = await withTenant(tenantId, (tx) =>
    tx.select().from(changeOrder).where(eq(changeOrder.id, changeOrderId)),
  );
  return row ?? null;
}
