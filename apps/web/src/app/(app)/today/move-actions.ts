"use server";
import { revalidatePath } from "next/cache";
import { confirmMove, dismissMove, recordMoveSignal } from "@savvy/db";
import { getTenantId } from "@/lib/tenant";

/** Verification card YES: the human's word confirms the move — both plays run. */
export async function confirmMoveAction(moveEventId: string, newAddress?: string): Promise<{ ok: boolean }> {
  const tenantId = await getTenantId();
  await confirmMove({ tenantId, moveEventId, newAddress: newAddress?.trim() || undefined });
  revalidatePath("/today");
  return { ok: true };
}

/** Verification card NO: closes the event; signals can reopen a fresh one. */
export async function dismissMoveAction(moveEventId: string): Promise<{ ok: boolean }> {
  const tenantId = await getTenantId();
  await dismissMove({ tenantId, moveEventId });
  revalidatePath("/today");
  return { ok: true };
}

/** Manual "customer moved" action (weight 100 — confirms immediately). */
export async function markCustomerMovedAction(
  customerId: string, propertyId: string, newAddress: string,
): Promise<{ ok: boolean }> {
  const tenantId = await getTenantId();
  await recordMoveSignal({ tenantId, customerId, propertyId, kind: "manual", newAddress: newAddress.trim() || undefined });
  revalidatePath("/today");
  return { ok: true };
}
