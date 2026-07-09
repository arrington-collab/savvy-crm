"use server";
import { withTenant, completeJobTaskManually } from "@savvy/db";
import { revalidatePath } from "next/cache";
import { getCurrentUser } from "./current-user";

/**
 * Ticks (or unticks) a MANUAL-mode job_task from the Job Ledger checkbox.
 * Rejects non-manual tasks (`completeJobTaskManually` throws "not_manual") —
 * assisted/full_auto tasks are completed by their agent, not a human click.
 */
export async function completeManualTask(jobId: string, taskId: number, done: boolean): Promise<void> {
  const { tenantId, userId } = await getCurrentUser();
  // TEST_MODE's getCurrentUser returns the non-UUID sentinel "test-user"; the
  // audit user_id FK (and job_task.owner) take null rather than a fake id.
  const localUserId = userId === "test-user" ? null : userId;
  await withTenant(tenantId, (tx) =>
    completeJobTaskManually(tx, { tenantId, jobId, taskId, userId: localUserId, done }),
  );
  revalidatePath(`/jobs/${jobId}`);
}
