import "server-only";
import { withTenant, job, customer, eq } from "@savvy/db";
import { getTenantId } from "./tenant";

/** Customer name for a job, for breadcrumb labels on job sub-pages. Null if not found. */
export async function getJobCustomerName(jobId: string): Promise<string | null> {
  const tenantId = await getTenantId();
  const [row] = await withTenant(tenantId, (tx) =>
    tx
      .select({ name: customer.name })
      .from(job)
      .leftJoin(customer, eq(customer.id, job.customerId))
      .where(eq(job.id, jobId)),
  );
  return row?.name ?? null;
}
