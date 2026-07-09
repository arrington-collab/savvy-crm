"use server";
import { auth } from "@clerk/nextjs/server";
import { withTenant, completeJobTaskManually } from "@savvy/db";
import { revalidatePath } from "next/cache";
import { getTenantId } from "./tenant";

/**
 * Ticks (or unticks) a MANUAL-mode job_task from the Job Ledger checkbox.
 * Rejects non-manual tasks (`completeJobTaskManually` throws "not_manual") —
 * assisted/full_auto tasks are completed by their agent, not a human click.
 */
export async function completeManualTask(jobId: string, taskId: number, done: boolean): Promise<void> {
  const tenantId = await getTenantId();
  const { userId } = await auth();
  await withTenant(tenantId, (tx) =>
    completeJobTaskManually(tx, { tenantId, jobId, taskId, userId: userId ?? "unknown", done }),
  );
  revalidatePath(`/jobs/${jobId}`);
}
