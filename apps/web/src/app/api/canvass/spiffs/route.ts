import { NextResponse } from "next/server";
import { withTenant, listSpiffs, isCanvassManager } from "@savvy/db";
import { verifyCanvassToken, bearerToken } from "@/lib/canvass-session";
import { canvassCors } from "@/lib/canvass-cors";
import { checkRateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

export function OPTIONS(req: Request): NextResponse {
  return new NextResponse(null, { status: 204, headers: canvassCors(req, "GET, OPTIONS") });
}

// GET /api/canvass/spiffs?scope=mine|all — "mine" (default) returns spiffs where
// the caller is winner or payer; "all" is manager-only.
export async function GET(req: Request): Promise<NextResponse> {
  const headers = canvassCors(req, "GET, OPTIONS");
  const reply = (b: unknown, s: number) => NextResponse.json(b, { status: s, headers });

  const sess = verifyCanvassToken(bearerToken(req.headers));
  if (!sess) return reply({ error: "unauthorized" }, 401);
  const { ok } = await checkRateLimit("canvass-read", `${sess.tenantId}:${sess.repId}`);
  if (!ok) return reply({ error: "rate_limited" }, 429);

  const scope = new URL(req.url).searchParams.get("scope") === "all" ? "all" : "mine";

  const spiffs = await withTenant(sess.tenantId, async (tx) => {
    if (scope === "all" && !(await isCanvassManager(tx, sess.tenantId, sess.repId))) return null;
    return listSpiffs(tx, sess.tenantId, scope, sess.repId);
  });
  if (spiffs === null) return reply({ error: "forbidden" }, 403);
  return reply({ scope, spiffs }, 200);
}
