"use server";
import { revalidatePath } from "next/cache";
import { approveStormReinspectBatch, dismissStormReinspectBatch, withTenant, user, eq } from "@savvy/db";
import { inngest } from "@savvy/agents";
import { auth } from "@clerk/nextjs/server";
import { getTenantId } from "@/lib/tenant";

/** Owner approves the batch → NOVA sends the outreach (durable, quiet-hours-aware). */
export async function approveStormBatch(batchId: string): Promise<{ ok: boolean }> {
  const tenantId = await getTenantId();
  const { userId: clerkUserId } = await auth();
  const savvyUser = clerkUserId
    ? await withTenant(tenantId, async (tx) => (await tx.select({ id: user.id }).from(user).where(eq(user.clerkUserId, clerkUserId)))[0] ?? null)
    : null;
  if (!savvyUser) return { ok: false };

  const res = await approveStormReinspectBatch({ tenantId, batchId, userId: savvyUser.id });
  if (!("error" in res)) {
    try { await inngest.send({ name: "storm/reinspect.approved", data: { tenantId, batchId } }); } catch { /* retried by the send fn's own idempotency */ }
  }
  revalidatePath("/today");
  return { ok: !("error" in res) };
}

export async function dismissStormBatch(batchId: string): Promise<{ ok: boolean }> {
  const tenantId = await getTenantId();
  const res = await dismissStormReinspectBatch({ tenantId, batchId });
  revalidatePath("/today");
  return { ok: !("error" in res) };
}
