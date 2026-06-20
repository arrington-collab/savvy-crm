import "server-only";
import { withTenant, job, customer, property, eq, or, ilike, desc } from "@savvy/db";
import { getTenantId } from "./tenant";

export type SchedulableJob = {
  jobId: string;
  customerId: string;
  customerName: string;
  address: string | null;
};

/** Search jobs (any stage) by customer name or property address for the create-appointment
 *  picker. Returns up to 10, most recent first. Blank/short queries return []. */
export async function searchSchedulableJobs(q: string): Promise<SchedulableJob[]> {
  const term = q.trim();
  if (term.length < 2) return [];
  const tenantId = await getTenantId();
  const pattern = `%${term}%`;
  return withTenant(tenantId, (tx) =>
    tx
      .select({
        jobId: job.id,
        customerId: job.customerId,
        customerName: customer.name,
        address: property.address,
      })
      .from(job)
      // innerJoin customer (job.customerId is NOT NULL) → customerName types as string;
      // leftJoin property tolerates a missing row → address is string | null.
      .innerJoin(customer, eq(customer.id, job.customerId))
      .leftJoin(property, eq(property.id, job.propertyId))
      .where(or(ilike(customer.name, pattern), ilike(property.address, pattern)))
      .orderBy(desc(job.createdAt))
      .limit(10),
  );
}
