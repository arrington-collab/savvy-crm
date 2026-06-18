"use server";
import { adminDb, user, eq, and, withTenant } from "@savvy/db";
import { openCheckIn, closeCheckIn, recordAgentRun } from "@savvy/db";
import { verifyPin } from "@savvy/core";
import { tenantByKey } from "./intake";
import { setCrewCookie, clearCrewCookie, getCrewSession } from "./crew-session";
import { crewCanAccessJob } from "./crew-queries";

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

export async function crewCheckIn(
  jobId: string, lat: number | null, lng: number | null,
): Promise<{ ok: true } | { error: string }> {
  const s = await getCrewSession();
  if (!s) return { error: "not signed in" };
  if (!(await crewCanAccessJob(s, jobId))) return { error: "not your job" };
  await withTenant(s.tenantId, (tx) => openCheckIn(tx, { tenantId: s.tenantId, jobId, crewUserId: s.crewUserId, lat, lng }));
  await recordAgentRun({ tenantId: s.tenantId, agent: "scheduling", taskKey: "crew.checkin", jobId, status: "ok" });
  return { ok: true };
}

export async function crewCheckOut(
  jobId: string, lat: number | null, lng: number | null,
): Promise<{ ok: true } | { error: string }> {
  const s = await getCrewSession();
  if (!s) return { error: "not signed in" };
  if (!(await crewCanAccessJob(s, jobId))) return { error: "not your job" };
  await withTenant(s.tenantId, (tx) => closeCheckIn(tx, { tenantId: s.tenantId, jobId, crewUserId: s.crewUserId, lat, lng }));
  await recordAgentRun({ tenantId: s.tenantId, agent: "scheduling", taskKey: "crew.checkout", jobId, status: "ok" });
  return { ok: true };
}
