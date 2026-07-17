"use server";
import { revalidatePath } from "next/cache";
import { listCrews, createCrew, renameCrew, setCrewActive, setCrewLocation, addCrewMember, removeCrewMember, setCrewPinHash } from "@savvy/db";
import { hashPin } from "@savvy/core";
import { getTenantId } from "./tenant";
import { canManageSettingsNow } from "./authz";

export async function listActiveCrews(): Promise<{ id: string; name: string }[]> {
  const tenantId = await getTenantId();
  const rows = await listCrews(tenantId);
  return rows.filter((c) => c.active).map((c) => ({ id: c.id, name: c.name }));
}

export async function createCrewAction(input: { name: string }): Promise<{ ok: true }> {
  const tenantId = await getTenantId();
  await createCrew({ tenantId, name: input.name });
  revalidatePath("/settings/crews");
  return { ok: true as const };
}

export async function renameCrewAction(input: { crewId: string; name: string }): Promise<{ ok: true }> {
  const tenantId = await getTenantId();
  await renameCrew({ tenantId, crewId: input.crewId, name: input.name });
  revalidatePath("/settings/crews");
  return { ok: true as const };
}

export async function setCrewActiveAction(input: { crewId: string; active: boolean }): Promise<{ ok: true }> {
  const tenantId = await getTenantId();
  await setCrewActive({ tenantId, crewId: input.crewId, active: input.active });
  revalidatePath("/settings/crews");
  return { ok: true as const };
}

export async function setCrewLocationAction(input: {
  crewId: string; baseLat: number | null; baseLng: number | null;
}): Promise<{ ok: true }> {
  const tenantId = await getTenantId();
  await setCrewLocation({ tenantId, crewId: input.crewId, baseLat: input.baseLat, baseLng: input.baseLng });
  revalidatePath("/settings/crews");
  return { ok: true as const };
}

export async function addCrewMemberAction(input: { crewId: string; userId: string }): Promise<{ ok: true }> {
  const tenantId = await getTenantId();
  await addCrewMember({ tenantId, crewId: input.crewId, userId: input.userId });
  revalidatePath("/settings/crews");
  return { ok: true as const };
}

export async function removeCrewMemberAction(input: { crewId: string; userId: string }): Promise<{ ok: true }> {
  const tenantId = await getTenantId();
  await removeCrewMember({ tenantId, crewId: input.crewId, userId: input.userId });
  revalidatePath("/settings/crews");
  return { ok: true as const };
}

export async function setCrewPinAction(input: { crewId: string; pin: string | null }): Promise<{ ok: true } | { error: string }> {
  if (!(await canManageSettingsNow())) return { error: "forbidden" };
  if (input.pin !== null && !/^\d{6,8}$/.test(input.pin)) return { error: "PIN must be 6–8 digits" };
  const tenantId = await getTenantId();
  await setCrewPinHash({ tenantId, crewId: input.crewId, pinHash: input.pin === null ? null : hashPin(input.pin) });
  revalidatePath("/settings/crews");
  return { ok: true };
}
