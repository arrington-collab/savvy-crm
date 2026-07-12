import { NextResponse } from "next/server";
import { withTenant, listChallenges, standingsFor, settleDueChallenges } from "@savvy/db";
import { verifyCanvassToken, bearerToken } from "@/lib/canvass-session";
import { canvassCors } from "@/lib/canvass-cors";
import { checkRateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

export function OPTIONS(req: Request): NextResponse {
  return new NextResponse(null, { status: 204, headers: canvassCors(req, "GET, OPTIONS") });
}

// GET — all challenges with live standings. Settles any past-window active
// challenges first (opportunistic; the cron is the backstop).
export async function GET(req: Request): Promise<NextResponse> {
  const headers = canvassCors(req, "GET, OPTIONS");
  const reply = (b: unknown, s: number) => NextResponse.json(b, { status: s, headers });

  const sess = verifyCanvassToken(bearerToken(req.headers));
  if (!sess) return reply({ error: "unauthorized" }, 401);
  const { ok } = await checkRateLimit("canvass-read", `${sess.tenantId}:${sess.repId}`);
  if (!ok) return reply({ error: "rate_limited" }, 429);

  const challenges = await withTenant(sess.tenantId, async (tx) => {
    await settleDueChallenges(tx, sess.tenantId, new Date());
    const list = await listChallenges(tx, sess.tenantId);
    return Promise.all(
      list.map(async (c) => ({
        ...c,
        standings: c.status === "settled" ? [] : await standingsFor(tx, sess.tenantId, c),
      })),
    );
  });
  return reply({ challenges }, 200);
}
