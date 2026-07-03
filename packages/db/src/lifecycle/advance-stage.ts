import { eq } from "drizzle-orm";
import { JOB_STAGE, type JobStage, type Agent } from "@savvy/core";
import { job } from "../schema/index";
import { db } from "../client";
import { recordStageChange } from "./record-stage-change";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Advance a job to `toStage` from a real-world signal (crew check-in, material
 * delivery, completion photos). Shared by every event-driven derived-status
 * trigger. Behavior mirrors the invoice-stage sync:
 *  - **forward-only**: skips (`not_forward`) when `toStage` is not strictly ahead
 *    of the job's current stage — so re-firing the same signal is idempotent and
 *    a signal can never regress a job.
 *  - **gate-aware**: a move blocked by the completion-photo gate or the per-stage
 *    document gate leaves the job in place and reports the skip reason
 *    (`photo_gate` / `doc_gate`) instead of throwing.
 */
export async function advanceJobStageForward(
  tx: Tx,
  opts: { tenantId: string; jobId: string; toStage: JobStage; byAgent?: Agent | null; byUserId?: string | null; now?: Date },
): Promise<{ toStage: JobStage } | { skipped: string }> {
  const [j] = await tx.select({ stage: job.stage }).from(job).where(eq(job.id, opts.jobId));
  if (!j) return { skipped: "no_job" };

  if (JOB_STAGE.indexOf(opts.toStage) <= JOB_STAGE.indexOf(j.stage as JobStage)) {
    return { skipped: "not_forward" };
  }

  try {
    await recordStageChange(tx, {
      tenantId: opts.tenantId,
      jobId: opts.jobId,
      toStage: opts.toStage,
      byAgent: opts.byAgent ?? null,
      byUserId: opts.byUserId ?? null,
      now: opts.now,
    });
  } catch (e) {
    if (e instanceof Error && e.name === "IncompletePhotosError") return { skipped: "photo_gate" };
    if (e instanceof Error && e.name === "IncompleteDocumentsError") return { skipped: "doc_gate" };
    throw e;
  }
  return { toStage: opts.toStage };
}
