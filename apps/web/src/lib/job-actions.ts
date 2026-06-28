"use server";
import {
  withTenant,
  recordStageChange,
  IncompletePhotosError,
  IncompleteDocumentsError,
  jobTask,
  eq,
} from "@savvy/db";
import { revalidatePath } from "next/cache";
import { getTenantId } from "./tenant";
import type { JobStage } from "@savvy/core";

export async function moveJobToStage(
  jobId: string,
  toStage: JobStage,
): Promise<
  | { ok: true }
  | { error: "missing_photos"; missing: string[] }
  | { error: "missing_docs"; missing: string[] }
> {
  const tenantId = await getTenantId();
  try {
    await withTenant(tenantId, (tx) =>
      recordStageChange(tx, { tenantId, jobId, toStage }),
    );
  } catch (e) {
    if (e instanceof IncompletePhotosError)
      return { error: "missing_photos", missing: e.missing };
    if (e instanceof IncompleteDocumentsError)
      return { error: "missing_docs", missing: e.missing };
    throw e;
  }
  revalidatePath("/jobs");
  return { ok: true };
}

export async function toggleTask(
  taskId: string,
  done: boolean,
): Promise<{ ok: true }> {
  const tenantId = await getTenantId();
  await withTenant(tenantId, async (tx) => {
    await tx
      .update(jobTask)
      .set({
        status: done ? "done" : "pending",
        completedAt: done ? new Date() : null,
      })
      .where(eq(jobTask.id, taskId));
  });
  revalidatePath("/jobs", "layout");
  return { ok: true };
}
