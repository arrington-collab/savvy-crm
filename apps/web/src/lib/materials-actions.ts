"use server";
import { upsertMaterialLeftover, confirmNoLeftovers, reconcileJobMaterials, resolveMaterialReturn } from "@savvy/db";
import { revalidatePath } from "next/cache";
import { getCurrentUser } from "./current-user";
import { getTenantId } from "./tenant";

export async function logLeftoverAction(input: {
  jobId: string;
  itemKey: string;
  quantity: number;
}): Promise<{ ok: true } | { error: string }> {
  try {
    const { tenantId, userId } = await getCurrentUser();
    if (!input.itemKey || !(input.quantity > 0)) return { error: "pick an item and quantity" };
    await upsertMaterialLeftover(tenantId, {
      jobId: input.jobId, itemKey: input.itemKey, quantity: input.quantity, source: "manual",
      createdByUserId: userId === "test-user" ? null : userId,
    });
    await reconcileJobMaterials(tenantId, { jobId: input.jobId });
    revalidatePath("/today");
    return { ok: true };
  } catch {
    return { error: "could not log leftover" };
  }
}

export async function confirmNoLeftoversAction(jobId: string): Promise<{ ok: true } | { error: string }> {
  try {
    const tenantId = await getTenantId();
    await confirmNoLeftovers(tenantId, { jobId });
    await reconcileJobMaterials(tenantId, { jobId });
    revalidatePath("/today");
    return { ok: true };
  } catch {
    return { error: "could not confirm" };
  }
}

export async function resolveReturnAction(
  returnId: string,
  outcome: "credited" | "written_off",
  recoveredCents?: number,
): Promise<{ ok: true } | { error: string }> {
  try {
    const tenantId = await getTenantId();
    await resolveMaterialReturn(tenantId, { returnId, outcome, recoveredCents });
    revalidatePath("/today");
    return { ok: true };
  } catch {
    return { error: "could not resolve return" };
  }
}
