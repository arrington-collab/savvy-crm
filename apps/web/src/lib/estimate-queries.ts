import "server-only";
import { withTenant, estimate, measurement, job, eq, desc } from "@savvy/db";
import { getTenantId } from "./tenant";

export async function listEstimatesForJob(jobId: string) {
  const tenantId = await getTenantId();
  return withTenant(tenantId, (tx) =>
    tx.select().from(estimate).where(eq(estimate.jobId, jobId)).orderBy(desc(estimate.createdAt)),
  );
}

export async function getEstimate(estimateId: string) {
  const tenantId = await getTenantId();
  const [row] = await withTenant(tenantId, (tx) =>
    tx.select().from(estimate).where(eq(estimate.id, estimateId)),
  );
  return row ?? null;
}

/** Latest measurement for the job's property (measurement links to property, not job). */
export async function getLatestMeasurementForJob(jobId: string) {
  const tenantId = await getTenantId();
  return withTenant(tenantId, async (tx) => {
    const [j] = await tx.select().from(job).where(eq(job.id, jobId));
    if (!j?.propertyId) return null;
    const [m] = await tx
      .select()
      .from(measurement)
      .where(eq(measurement.propertyId, j.propertyId))
      .orderBy(desc(measurement.createdAt))
      .limit(1);
    return m ?? null;
  });
}
