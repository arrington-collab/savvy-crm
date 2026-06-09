"use server";
import { withTenant, recordStageChange } from "@savvy/db";
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
