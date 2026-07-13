import { NextResponse } from "next/server";
import { withTenant, markSpiffPaid, isCanvassManager } from "@savvy/db";
import { verifyCanvassToken, bearerToken } from "@/lib/canvass-session";
import { canvassCors } from "@/lib/canvass-cors";
import { checkRateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

export function OPTIONS(req: Request): NextResponse {
  return new NextResponse(null, { status: 204, headers: canvassCors(req, "POST, OPTIONS") });
}

// POST /api/canvass/spiff/:id?action=paid — manager-only, flips owed → paid.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const headers = canvassCors(req, "POST, OPTIONS");
  const reply = (b: unknown, s: number) => NextResponse.json(b, { status: s, headers });

  const sess = verifyCanvassToken(bearerToken(req.headers));
  if (!sess) return reply({ error: "unauthorized" }, 401);
  const { ok } = await checkRateLimit("canvass", `${sess.tenantId}:${sess.repId}`);
  if (!ok) return reply({ error: "rate_limited" }, 429);

  const { id } = await ctx.params;
  const action = new URL(req.url).searchParams.get("action");
  if (action !== "paid") return reply({ error: "bad_action" }, 400);

  const changed = await withTenant(sess.tenantId, async (tx) => {
    if (!(await isCanvassManager(tx, sess.tenantId, sess.repId))) return null;
    return markSpiffPaid(tx, sess.tenantId, id, new Date());
  });
  if (changed === null) return reply({ error: "forbidden" }, 403);
  return reply({ ok: changed }, 200);
}
