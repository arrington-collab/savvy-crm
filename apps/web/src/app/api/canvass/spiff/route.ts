import { NextResponse } from "next/server";
import { withTenant, createManualSpiff, isCanvassManager } from "@savvy/db";
import { verifyCanvassToken, bearerToken } from "@/lib/canvass-session";
import { canvassCors } from "@/lib/canvass-cors";
import { checkRateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

export function OPTIONS(req: Request): NextResponse {
  return new NextResponse(null, { status: 204, headers: canvassCors(req, "POST, OPTIONS") });
}

// POST /api/canvass/spiff — manager awards a one-off manual spiff.
// Body: { winnerRepId, amountCents, note? }.
export async function POST(req: Request): Promise<NextResponse> {
  const headers = canvassCors(req, "POST, OPTIONS");
  const reply = (b: unknown, s: number) => NextResponse.json(b, { status: s, headers });

  const sess = verifyCanvassToken(bearerToken(req.headers));
  if (!sess) return reply({ error: "unauthorized" }, 401);
  const { ok } = await checkRateLimit("canvass", `${sess.tenantId}:${sess.repId}`);
  if (!ok) return reply({ error: "rate_limited" }, 429);

  const body = (await req.json().catch(() => null)) as { winnerRepId?: string; amountCents?: number; note?: string } | null;
  const winnerRepId = body?.winnerRepId;
  const amountCents = Math.floor(Number(body?.amountCents));
  if (!winnerRepId || !Number.isFinite(amountCents) || amountCents <= 0) return reply({ error: "bad_request" }, 400);

  const result = await withTenant(sess.tenantId, async (tx) => {
    if (!(await isCanvassManager(tx, sess.tenantId, sess.repId))) return null;
    return createManualSpiff(tx, { tenantId: sess.tenantId, winnerRepId, amountCents, note: body?.note });
  });
  if (result === null) return reply({ error: "forbidden" }, 403);
  return reply(result, 201);
}
