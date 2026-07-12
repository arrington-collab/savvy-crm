import { NextResponse } from "next/server";
import { CHALLENGE_KINDS, CHALLENGE_METRICS, instantAtLocalHourOnDayOf, type ChallengeKind, type ChallengeMetric } from "@savvy/core";
import { withTenant, tenant, createChallenge, isCanvassRepActive, isCanvassManager, eq } from "@savvy/db";
import { verifyCanvassToken, bearerToken } from "@/lib/canvass-session";
import { canvassCors } from "@/lib/canvass-cors";
import { checkRateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

export function OPTIONS(req: Request): NextResponse {
  return new NextResponse(null, { status: 204, headers: canvassCors(req, "POST, OPTIONS") });
}

// POST — create a challenge. Body: { kind, metric, targetRepId?, participantIds?,
// windowHours? }. h2h/koth need targetRepId (opponent / current throne holder);
// contest needs participantIds and is manager-only. Window = now → now+windowHours
// (default: end of the tenant-local day for h2h).
export async function POST(req: Request): Promise<NextResponse> {
  const headers = canvassCors(req, "POST, OPTIONS");
  const reply = (b: unknown, s: number) => NextResponse.json(b, { status: s, headers });

  const sess = verifyCanvassToken(bearerToken(req.headers));
  if (!sess) return reply({ error: "unauthorized" }, 401);
  const { ok } = await checkRateLimit("canvass", `${sess.tenantId}:${sess.repId}`);
  if (!ok) return reply({ error: "rate_limited" }, 429);

  let body: { kind?: string; metric?: string; targetRepId?: string; participantIds?: string[]; windowHours?: number };
  try { body = (await req.json()) as typeof body; } catch { return reply({ error: "invalid json" }, 400); }

  const kind = body.kind as ChallengeKind;
  const metric = body.metric as ChallengeMetric;
  if (!CHALLENGE_KINDS.includes(kind)) return reply({ error: "bad kind" }, 400);
  if (!CHALLENGE_METRICS.includes(metric)) return reply({ error: "bad metric" }, 400);

  const result = await withTenant(sess.tenantId, async (tx) => {
    if (!(await isCanvassRepActive(tx, sess.tenantId, sess.repId))) return { error: "unauthorized" as const };
    let participantRepIds: string[];
    if (kind === "contest") {
      if (!(await isCanvassManager(tx, sess.tenantId, sess.repId))) return { error: "forbidden" as const };
      participantRepIds = Array.from(new Set([...(body.participantIds ?? [])]));
      if (participantRepIds.length < 2) return { error: "need participants" as const };
    } else {
      if (!body.targetRepId || body.targetRepId === sess.repId) return { error: "need opponent" as const };
      participantRepIds = [sess.repId, body.targetRepId];
    }
    const now = new Date();
    const [tRow] = await tx.select({ timezone: tenant.timezone }).from(tenant).where(eq(tenant.id, sess.tenantId));
    const tz = tRow?.timezone ?? "UTC";
    // default window: h2h = end of the tenant-LOCAL day (midnight local tomorrow,
    // DST-correct via instantAtLocalHourOnDayOf on a tomorrow anchor); else windowHours (24 default)
    let windowEnd: Date;
    if (body.windowHours) windowEnd = new Date(now.getTime() + body.windowHours * 3600_000);
    else if (kind === "h2h") windowEnd = instantAtLocalHourOnDayOf(new Date(now.getTime() + 24 * 3600_000), tz, 0);
    else windowEnd = new Date(now.getTime() + 24 * 3600_000);
    const { id } = await createChallenge(tx, {
      tenantId: sess.tenantId, createdByRepId: sess.repId, kind, metric,
      windowStart: now, windowEnd, participantRepIds,
    });
    return { id };
  });
  if ("error" in result) {
    const code = result.error === "forbidden" ? 403 : result.error === "unauthorized" ? 401 : 400;
    return reply({ error: result.error }, code);
  }
  return reply({ ok: true, id: result.id }, 201);
}
