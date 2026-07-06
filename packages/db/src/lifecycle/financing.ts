import { eq } from "drizzle-orm";
import type { FinancingStatus } from "@savvy/core";
import { withTenant } from "../tenant";
import { job } from "../schema/jobs";

/**
 * Cell 11: advance a job's financing status from a provider webhook. Status-only
 * — no credit data is ever stored. `externalRef` is the vendor's opaque
 * application id. Tenant-scoped; a no-op if the job isn't found.
 */
export async function setJobFinancingStatus(input: {
  tenantId: string;
  jobId: string;
  status: FinancingStatus;
  externalRef?: string | null;
}): Promise<void> {
  await withTenant(input.tenantId, (tx) =>
    tx
      .update(job)
      .set({ financingStatus: input.status, ...(input.externalRef !== undefined ? { financingRef: input.externalRef } : {}) })
      .where(eq(job.id, input.jobId)),
  );
}
