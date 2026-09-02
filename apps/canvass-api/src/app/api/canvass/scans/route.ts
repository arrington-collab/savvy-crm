import { NextResponse } from "next/server";
import { withTenant, listScans, isCanvassManager } from "@savvy/db";
import { verifyCanvassToken, bearerToken } from "@/lib/canvass-session";
import { canvassCors } from "@/lib/canvass-cors";
import { checkRateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

export function OPTIONS(req: Request): NextResponse {
  return new NextResponse(null, { status: 204, headers: canvassCors(req, "GET, OPTIONS") });
}

// GET /api/canvass/scans — manager-only: recent homeowner ID-scan captures.
export async function GET(req: Request): Promise<NextResponse> {
  const headers = canvassCors(req, "GET, OPTIONS");
  const reply = (b: unknown, s: number) => NextResponse.json(b, { status: s, headers });

  const sess = verifyCanvassToken(bearerToken(req.headers));
  if (!sess) return reply({ error: "unauthorized" }, 401);
  const { ok } = await checkRateLimit("canvass-read", `${sess.tenantId}:${sess.repId}`);
  if (!ok) return reply({ error: "rate_limited" }, 429);

  const scans = await withTenant(sess.tenantId, async (tx) => {
    if (!(await isCanvassManager(tx, sess.tenantId, sess.repId))) return null;
    return listScans(tx, sess.tenantId);
  });
  if (scans === null) return reply({ error: "forbidden" }, 403);
  return reply({ scans }, 200);
}
