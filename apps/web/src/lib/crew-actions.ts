"use server";
import { adminDb, user, eq, and, isNull, withTenant, job, document } from "@savvy/db";
import { openCheckIn, closeCheckIn, recordAgentRun, getCrewLoginCandidates } from "@savvy/db";
import { r2Storage } from "@savvy/integrations";
import { verifyPin } from "@savvy/core";
import { tenantByKey } from "./intake";
import { setCrewCookie, clearCrewCookie, getCrewSession } from "./crew-session";
import { crewCanAccessJob } from "./crew-queries";
import { headers } from "next/headers";
import { checkRateLimit, clientIp } from "./rate-limit";
import { log } from "./log";

export type CrewLoginResult =
  | { ok: true }
  | { selectCrew: { crewId: string; members: { id: string; name: string }[] } }
  | { error: string };

export async function crewLogin(key: string, pin: string): Promise<CrewLoginResult> {
  const ip = clientIp(await headers());
  const limited = await checkRateLimit("crew-pin", `${key}:${ip}`);
  if (!limited.ok) {
    log.warn("crew login rate limited", { route: "crew-login", tenantKey: key });
    return { error: "too many attempts" };
  }
  const t = await tenantByKey(key);
  if (!t) return { error: "unknown workspace" };

  // Shared crew PIN first: a PIN matching an active crew returns its roster so the
  // member can self-identify (no session is set until they pick — see crewSelectMember).
  const crews = await getCrewLoginCandidates(t.id);
  const crewMatch = crews.find((c) => verifyPin(pin, c.pinHash));
  if (crewMatch) {
    if (crewMatch.members.length === 0) return { error: "crew has no members" };
    return { selectCrew: { crewId: crewMatch.id, members: crewMatch.members } };
  }

  // Fallback: per-user PIN. Filter to active (non-deactivated) crew members only —
  // deactivated users must not sign in even if their PIN hash is still present.
  const crew = await adminDb
    .select({ id: user.id, pinHash: user.pinHash })
    .from(user)
    .where(and(eq(user.tenantId, t.id), eq(user.role, "crew"), isNull(user.deactivatedAt)));
  const match = crew.find((u) => verifyPin(pin, u.pinHash));
  if (!match) return { error: "invalid PIN" };
  await setCrewCookie({ tenantId: t.id, crewUserId: match.id });
  return { ok: true };
}

/**
 * Step 2 of shared-PIN login: the member taps their name. We RE-VERIFY the crew PIN
 * here (not just trust crewId+userId) so this can't be used to forge a session without
 * the PIN, then confirm the user is a member of that crew before setting the session.
 */
export async function crewSelectMember(
  key: string, pin: string, userId: string,
): Promise<{ ok: true } | { error: string }> {
  const ip = clientIp(await headers());
  const limited = await checkRateLimit("crew-pin", `${key}:${ip}`);
  if (!limited.ok) {
    log.warn("crew member-select rate limited", { route: "crew-login", tenantKey: key });
    return { error: "too many attempts" };
  }
  const t = await tenantByKey(key);
  if (!t) return { error: "unknown workspace" };
  const crews = await getCrewLoginCandidates(t.id);
  const crewMatch = crews.find((c) => verifyPin(pin, c.pinHash));
  if (!crewMatch) return { error: "invalid PIN" };
  if (!crewMatch.members.some((m) => m.id === userId)) return { error: "not a member of this crew" };
  await setCrewCookie({ tenantId: t.id, crewUserId: userId });
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

export async function crewPresignPhoto(
  jobId: string, input: { filename: string; contentType: string },
): Promise<{ ok: true; uploadUrl: string; r2Key: string } | { error: string }> {
  const s = await getCrewSession();
  if (!s) return { error: "not signed in" };
  if (!(await crewCanAccessJob(s, jobId))) return { error: "not your job" };
  const safe = input.filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
  const r2Key = `${s.tenantId}/${jobId}/${crypto.randomUUID()}-${safe}`;
  try {
    const { url } = await r2Storage.presignUpload({ key: r2Key, contentType: input.contentType });
    return { ok: true, uploadUrl: url, r2Key };
  } catch {
    return { error: "storage_not_configured" };
  }
}

export async function crewRecordPhoto(
  jobId: string,
  input: { r2Key: string; label: string; filename: string; mime: string; sizeBytes: number },
): Promise<{ ok: true; id: string } | { error: string }> {
  const s = await getCrewSession();
  if (!s) return { error: "not signed in" };
  if (!(await crewCanAccessJob(s, jobId))) return { error: "not your job" };
  if (!input.r2Key.startsWith(`${s.tenantId}/${jobId}/`)) return { error: "bad_key" };
  const res = await withTenant(s.tenantId, async (tx) => {
    const [j] = await tx.select({ customerId: job.customerId }).from(job).where(eq(job.id, jobId));
    if (!j) return null;
    const [row] = await tx.insert(document).values({
      tenantId: s.tenantId, jobId, customerId: j.customerId ?? null,
      kind: "photo", label: input.label, r2Key: input.r2Key,
      filename: input.filename, mime: input.mime, sizeBytes: input.sizeBytes, source: "savvy",
    }).returning({ id: document.id });
    return row;
  });
  if (!res) return { error: "not_found" };
  return { ok: true, id: res.id };
}
