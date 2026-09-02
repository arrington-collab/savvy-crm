import { NextResponse } from "next/server";
import { dateKeyInTimeZone } from "@savvy/core";
import { withTenant, tenant, eq, insertPings, listPingsForDay, isCanvassManager } from "@savvy/db";
import { verifyCanvassToken, bearerToken } from "@/lib/canvass-session";
import { canvassCors } from "@/lib/canvass-cors";
import { checkRateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

export function OPTIONS(req: Request): NextResponse {
  return new NextResponse(null, { status: 204, headers: canvassCors(req, "GET, POST, OPTIONS") });
}

// POST — the signed-in rep uploads their own trail buffer (repId from session).
export async function POST(req: Request): Promise<NextResponse> {
  const headers = canvassCors(req, "GET, POST, OPTIONS");
  const reply = (b: unknown, s: number) => NextResponse.json(b, { status: s, headers });
  const sess = verifyCanvassToken(bearerToken(req.headers));
  if (!sess) return reply({ error: "unauthorized" }, 401);
  const { ok } = await checkRateLimit("canvass", `${sess.tenantId}:${sess.repId}`);
  if (!ok) return reply({ error: "rate_limited" }, 429);
  let json: unknown; try { json = await req.json(); } catch { return reply({ error: "invalid json" }, 400); }
  const points = (json as { points?: unknown })?.points;
  if (!Array.isArray(points)) return reply({ error: "bad_request" }, 400);
  const n = await withTenant(sess.tenantId, (tx) =>
    insertPings(tx, sess.tenantId, sess.repId, points as { lat: number; lng: number; ts: number }[]),
  );
  return reply({ ok: true, stored: n }, 201);
}

// GET ?date=YYYY-MM-DD — manager-only day trails for the whole team.
export async function GET(req: Request): Promise<NextResponse> {
  const headers = canvassCors(req, "GET, POST, OPTIONS");
  const reply = (b: unknown, s: number) => NextResponse.json(b, { status: s, headers });
  const sess = verifyCanvassToken(bearerToken(req.headers));
  if (!sess) return reply({ error: "unauthorized" }, 401);
  const { ok } = await checkRateLimit("canvass-read", `${sess.tenantId}:${sess.repId}`);
  if (!ok) return reply({ error: "rate_limited" }, 429);
  const out = await withTenant(sess.tenantId, async (tx) => {
    if (!(await isCanvassManager(tx, sess.tenantId, sess.repId))) return null;
    const [tRow] = await tx.select({ timezone: tenant.timezone }).from(tenant).where(eq(tenant.id, sess.tenantId));
    const tz = tRow?.timezone ?? "UTC";
    const date = new URL(req.url).searchParams.get("date") || dateKeyInTimeZone(new Date(), tz);
    return { date, reps: await listPingsForDay(tx, sess.tenantId, tz, date) };
  });
  if (out === null) return reply({ error: "forbidden" }, 403);
  return reply(out, 200);
}
