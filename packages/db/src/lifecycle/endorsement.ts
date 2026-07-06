import { and, eq } from "drizzle-orm";
import type { EndorsementStatus } from "@savvy/core";
import { withTenant } from "../tenant";
import { claim } from "../schema/insurance";

/**
 * Cell 16: record a mortgage-endorsement chase action on a job's claim. Sets the
 * lender co-payee (when detected), advances the endorsement status, and stamps
 * endorsement_last_action_at so the 5-business-day no-idle invariant resets on
 * each real touch. Tenant-scoped; a no-op if the claim isn't found.
 */
export async function setClaimEndorsement(input: {
  tenantId: string;
  jobId: string;
  status: EndorsementStatus;
  lenderName?: string | null;
  lastActionAt?: Date;
}): Promise<void> {
  await withTenant(input.tenantId, (tx) =>
    tx
      .update(claim)
      .set({
        endorsementStatus: input.status,
        endorsementLastActionAt: input.lastActionAt ?? new Date(),
        ...(input.lenderName !== undefined ? { lenderName: input.lenderName } : {}),
      })
      .where(and(eq(claim.tenantId, input.tenantId), eq(claim.jobId, input.jobId))),
  );
}
