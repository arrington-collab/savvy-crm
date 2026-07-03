import { and, eq } from "drizzle-orm";
import { job, claim, jobChecklistItem } from "../schema/index";
import { withTenant } from "../tenant";
import { recoverableDepreciationCents } from "@savvy/core";

/** Stable key for the depreciation-recovery office task — also its idempotency guard. */
export const DEPRECIATION_TASK_KEY = "claims.depreciation_recovery";

const TASK_TITLE = "Update Xactimate pricing + prepare recovery invoice";

/**
 * On an insurance job's completion, detect recoverable depreciation and, if any,
 * generate the office-staff task (§G): "update the Xactimate pricing to current and
 * prepare the recovery invoice." The task is a `job_checklist_item` owned by the
 * claims agent, due immediately so it surfaces in the /exceptions "Needs you" list.
 * Idempotent per job (keyed by DEPRECIATION_TASK_KEY). Retail jobs are skipped — they
 * have no depreciation lane.
 */
export async function detectDepreciationRecovery(input: {
  tenantId: string;
  jobId: string;
  now?: Date;
}): Promise<{ created: string; depreciationCents: number } | { skipped: string }> {
  return withTenant(input.tenantId, async (tx) => {
    const [j] = await tx.select({ type: job.type }).from(job).where(eq(job.id, input.jobId));
    if (!j) return { skipped: "no_job" };
    if (j.type !== "insurance") return { skipped: "not_insurance" };

    const [c] = await tx.select({ rcvCents: claim.rcvCents, acvCents: claim.acvCents }).from(claim).where(eq(claim.jobId, input.jobId));
    if (!c) return { skipped: "no_claim" };

    const depreciationCents = recoverableDepreciationCents(c);
    if (depreciationCents <= 0) return { skipped: "no_depreciation" };

    const [existing] = await tx
      .select({ id: jobChecklistItem.id })
      .from(jobChecklistItem)
      .where(and(eq(jobChecklistItem.jobId, input.jobId), eq(jobChecklistItem.key, DEPRECIATION_TASK_KEY)));
    if (existing) return { skipped: "already_exists" };

    const now = input.now ?? new Date();
    const [row] = await tx
      .insert(jobChecklistItem)
      .values({
        tenantId: input.tenantId,
        jobId: input.jobId,
        key: DEPRECIATION_TASK_KEY,
        title: TASK_TITLE,
        phase: "closeout",
        ownerAgent: "claims",
        automationLevel: "manual", // the human does the Xactimate re-pricing judgment
        status: "pending",
        dueAt: now, // due now → surfaces immediately in the Needs-you queue
        payload: { recoverableDepreciationCents: depreciationCents },
      })
      .returning({ id: jobChecklistItem.id });

    return { created: row!.id, depreciationCents };
  });
}
