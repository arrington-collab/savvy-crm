"use server";
import { markTaskExceptionViewed } from "@savvy/db";
import { getTenantId } from "./tenant";

/**
 * Records that the owner opened a task's exception in the UI (stamps
 * first_viewed_at once). Founder-minutes = Σ(resolved − first_viewed) reads it.
 * Idempotent and tenant-scoped; called from the /tasks/[id] view tracker.
 */
export async function recordTaskFirstView(taskId: number): Promise<void> {
  await markTaskExceptionViewed(await getTenantId(), taskId);
}
