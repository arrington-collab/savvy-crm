import "server-only";
import { withTenant, materialOrder, eq, desc, getJobInstallDate } from "@savvy/db";
import { getTenantId } from "./tenant";

export async function listMaterialOrdersForJob(jobId: string) {
  const tenantId = await getTenantId();
  return withTenant(tenantId, (tx) =>
    tx.select().from(materialOrder).where(eq(materialOrder.jobId, jobId)).orderBy(desc(materialOrder.createdAt)),
  );
}

export async function getJobInstallDateForJob(jobId: string) {
  const tenantId = await getTenantId();
  return getJobInstallDate(tenantId, jobId);
}
