"use server";
import { withTenant, recordStageChange, jobTask, eq } from "@savvy/db";
import { revalidatePath } from "next/cache";
import { getTenantId } from "./tenant";
import type { JobStage } from "@savvy/core";

export async function moveJobToStage(
  jobId: string,
  toStage: JobStage,
): Promise<{ ok: true }> {
  const tenantId = await getTenantId();
  await withTenant(tenantId, (tx) =>
    recordStageChange(tx, { tenantId, jobId, toStage }),
  );
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
