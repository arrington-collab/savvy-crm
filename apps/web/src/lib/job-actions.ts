"use server";
import {
  withTenant,
  recordStageChange,
  IncompletePhotosError,
  IncompleteDocumentsError,
  StageEvidenceError,
  BackwardNeedsReasonError,
  jobChecklistItem,
  eq,
  setJobTaskAutomationLevel,
} from "@savvy/db";
import { revalidatePath } from "next/cache";
import { getTenantId } from "./tenant";
import { isAutomationLevel, type JobStage, type AutomationLevel } from "@savvy/core";

export async function moveJobToStage(
  jobId: string,
  toStage: JobStage,
  reason?: string,
): Promise<
  | { ok: true }
  | { error: "missing_photos"; missing: string[] }
  | { error: "missing_docs"; missing: string[] }
  | { error: "needs_evidence"; missing: string | null }
  | { error: "needs_reason" }
> {
  const tenantId = await getTenantId();
  try {
    await withTenant(tenantId, (tx) =>
      recordStageChange(tx, { tenantId, jobId, toStage, reason }),
    );
  } catch (e) {
    if (e instanceof IncompletePhotosError)
      return { error: "missing_photos", missing: e.missing };
    if (e instanceof IncompleteDocumentsError)
      return { error: "missing_docs", missing: e.missing };
    if (e instanceof StageEvidenceError)
      return { error: "needs_evidence", missing: e.missing };
    if (e instanceof BackwardNeedsReasonError)
      return { error: "needs_reason" };
    throw e;
  }
  revalidatePath("/jobs");
  revalidatePath("/pipeline");
  return { ok: true };
}

/** Set a cockpit task's automation level (Background Ops: promote Manual → assisted → auto). */
export async function setTaskAutomationLevel(
  taskId: string,
  level: AutomationLevel,
): Promise<{ ok: true } | { error: string }> {
  if (!isAutomationLevel(level)) return { error: "bad_level" };
  const tenantId = await getTenantId();
  const r = await setJobTaskAutomationLevel({ tenantId, taskId, level });
  revalidatePath("/jobs", "layout");
  return "ok" in r ? { ok: true } : { error: r.skipped };
}

export async function toggleTask(
  taskId: string,
  done: boolean,
): Promise<{ ok: true }> {
  const tenantId = await getTenantId();
  await withTenant(tenantId, async (tx) => {
    await tx
      .update(jobChecklistItem)
      .set({
        status: done ? "done" : "pending",
        completedAt: done ? new Date() : null,
      })
      .where(eq(jobChecklistItem.id, taskId));
  });
  revalidatePath("/jobs", "layout");
  return { ok: true };
}
