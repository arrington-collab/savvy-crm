"use server";
import { adminDb, user, eq, and } from "@savvy/db";
import { verifyPin } from "@savvy/core";
import { tenantByKey } from "./intake";
import { setCrewCookie, clearCrewCookie } from "./crew-session";

export async function crewLogin(key: string, pin: string): Promise<{ ok: true } | { error: string }> {
  const t = await tenantByKey(key);
  if (!t) return { error: "unknown workspace" };
  const crew = await adminDb
    .select({ id: user.id, pinHash: user.pinHash })
    .from(user)
    .where(and(eq(user.tenantId, t.id), eq(user.role, "crew")));
  const match = crew.find((u) => verifyPin(pin, u.pinHash));
  if (!match) return { error: "invalid PIN" };
  await setCrewCookie({ tenantId: t.id, crewUserId: match.id });
  return { ok: true };
}

export async function crewLogout(): Promise<{ ok: true }> {
  await clearCrewCookie();
  return { ok: true };
}
