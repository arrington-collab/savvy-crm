import { NextResponse } from "next/server";
import { withTenant, markAlertRead } from "@savvy/db";
import { verifyCanvassToken, bearerToken } from "@/lib/canvass-session";
import { canvassCors } from "@/lib/canvass-cors";
import { checkRateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

export function OPTIONS(req: Request): NextResponse {
  return new NextResponse(null, { status: 204, headers: canvassCors(req, "POST, OPTIONS") });
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const headers = canvassCors(req, "POST, OPTIONS");
  const reply = (b: unknown, s: number) => NextResponse.json(b, { status: s, headers });
  const sess = verifyCanvassToken(bearerToken(req.headers));
  if (!sess) return reply({ error: "unauthorized" }, 401);
  const { ok } = await checkRateLimit("canvass", `${sess.tenantId}:${sess.repId}`);
  if (!ok) return reply({ error: "rate_limited" }, 429);
  const { id } = await ctx.params;
  if (new URL(req.url).searchParams.get("action") !== "read") return reply({ error: "bad_action" }, 400);
  const changed = await withTenant(sess.tenantId, (tx) => markAlertRead(tx, sess.tenantId, id, sess.repId, new Date()));
  return reply({ ok: changed }, 200);
}
