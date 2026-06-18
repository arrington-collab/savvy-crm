"use server";
import { adminDb, user, eq, and, withTenant, job, document } from "@savvy/db";
import { openCheckIn, closeCheckIn, recordAgentRun } from "@savvy/db";
import { r2Storage } from "@savvy/integrations";
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
