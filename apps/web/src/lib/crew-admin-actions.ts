"use server";
import { withTenant, user, eq, and } from "@savvy/db";
import { hashPin } from "@savvy/core";
import { revalidatePath } from "next/cache";
import { getTenantId } from "./tenant";
import { isOrgAdmin } from "./authz";

export async function listCrewUsers(): Promise<{ id: string; name: string; hasPin: boolean }[]> {
  const tenantId = await getTenantId();
  const rows = await withTenant(tenantId, (tx) =>
    tx.select({ id: user.id, name: user.name, pinHash: user.pinHash }).from(user).where(eq(user.role, "crew")));
  return rows.map((r) => ({ id: r.id, name: r.name, hasPin: !!r.pinHash }));
}

export async function setCrewPin(userId: string, pin: string | null): Promise<{ ok: true } | { error: string }> {
  if (!(await isOrgAdmin())) return { error: "forbidden" };
  const tenantId = await getTenantId();
  if (pin !== null && !/^\d{4,8}$/.test(pin)) return { error: "PIN must be 4–8 digits" };
  const res = await withTenant(tenantId, async (tx) => {
    const [u] = await tx.select({ id: user.id }).from(user).where(and(eq(user.id, userId), eq(user.role, "crew")));
    if (!u) return null;
    await tx.update(user).set({ pinHash: pin === null ? null : hashPin(pin) }).where(eq(user.id, userId));
    return u;
  });
  if (!res) return { error: "not a crew user in this tenant" };
  revalidatePath("/settings/crew");
  return { ok: true };
}
