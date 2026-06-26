"use server";
import { withTenant, user, eq } from "@savvy/db";
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
