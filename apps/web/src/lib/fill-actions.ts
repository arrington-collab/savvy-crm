"use server";
import { approveFillPlay } from "@savvy/db";
import { revalidatePath } from "next/cache";
import { getCurrentUser } from "./current-user";
import { canApproveMoneyNow } from "./authz";

export async function approveFillPlayAction(playId: string): Promise<{ ok: true } | { error: string }> {
  try {
    // S6 matrix: money approvals are owner/admin only.
    if (!(await canApproveMoneyNow())) return { error: "not allowed" };
    const { tenantId, userId } = await getCurrentUser();
    const r = await approveFillPlay(tenantId, { playId, userId: userId === "test-user" ? null : userId });
    if ("error" in r) return r;
    revalidatePath("/today");
    return { ok: true };
  } catch {
    return { error: "could not approve" };
  }
}
