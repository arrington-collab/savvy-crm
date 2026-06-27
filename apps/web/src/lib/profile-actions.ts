"use server";
import { withTenant, user, eq, createRepBlock, deleteRepBlock } from "@savvy/db";
import { revalidatePath } from "next/cache";
import { normalizePhone } from "@savvy/core";
import { getCurrentUser } from "./current-user";

/** Self-service: the signed-in user sets their own mobile number for rep
 *  speed-to-lead alerts. Scoped to getCurrentUser() — can't touch anyone else.
 *  Empty input clears the number; non-empty input that can't be normalized errors. */
export async function saveMyPhone(phone: string): Promise<{ ok: true } | { error: string }> {
  const trimmed = phone.trim();
  const normalized = trimmed ? normalizePhone(trimmed) : null;
  if (trimmed && !normalized) return { error: "invalid phone number" };
  const { tenantId, userId } = await getCurrentUser();
  await withTenant(tenantId, (tx) => tx.update(user).set({ phone: normalized }).where(eq(user.id, userId)));
  revalidatePath("/settings/profile");
  return { ok: true };
}

/** Self-service: block out time on the signed-in rep's own calendar. The scheduling
 *  engine subtracts these from offered slots. `startsAt`/`endsAt` are ISO instants
 *  (the client converts the rep's local datetime-local inputs to ISO). */
export async function addMyBlock(input: {
  startsAt: string;
  endsAt: string;
  reason?: string;
}): Promise<{ ok: true; id: string } | { error: string }> {
  const startsAt = new Date(input.startsAt);
  const endsAt = new Date(input.endsAt);
  if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) return { error: "Pick a start and end time" };
  if (startsAt >= endsAt) return { error: "End must be after start" };
  const { tenantId, userId } = await getCurrentUser();
  const { id } = await createRepBlock(tenantId, { userId, startsAt, endsAt, reason: input.reason?.trim() || null });
  revalidatePath("/settings/profile");
  return { ok: true, id };
}

/** Self-service: remove one of the signed-in rep's own blocks (ownership-scoped in the db). */
export async function removeMyBlock(blockId: string): Promise<{ ok: true } | { error: string }> {
  const { tenantId, userId } = await getCurrentUser();
  await deleteRepBlock(tenantId, { userId, blockId });
  revalidatePath("/settings/profile");
  return { ok: true };
}
