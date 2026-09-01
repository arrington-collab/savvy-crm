import { NextResponse } from "next/server";
import { adminDb, canvassSoldListing, canvassKnock, eq, sql } from "@savvy/db";
import { tenantByKey } from "@/lib/intake";
import { canvassCors } from "@/lib/canvass-cors";
import { checkRateLimit, clientIp } from "@/lib/rate-limit";

export const runtime = "nodejs";

// GET /api/canvass/health?key= — aggregate freshness signals for external
// monitoring (the Knock Jockey sentinel worker). Public like GET /reps: the
// public key is not a secret, and the response is aggregate-only — no
// addresses, names, or per-rep data. The caller computes staleness from
// latestSoldDate; keeping the threshold out of this route means alert policy
// can change without a redeploy here.
export function OPTIONS(req: Request): NextResponse {
  return new NextResponse(null, { status: 204, headers: canvassCors(req, "GET, OPTIONS") });
}

export async function GET(req: Request): Promise<NextResponse> {
  const headers = canvassCors(req, "GET, OPTIONS");
  const reply = (b: unknown, s: number) => NextResponse.json(b, { status: s, headers });

  const { ok } = await checkRateLimit("canvass-read", `health:${clientIp(req.headers)}`);
  if (!ok) return reply({ error: "rate_limited" }, 429);

  const key = new URL(req.url).searchParams.get("key") || "";
  if (!key) return reply({ error: "missing key" }, 400);
  const t = await tenantByKey(key);
  if (!t) return reply({ error: "unknown tenant" }, 404);

  const [sold] = await adminDb
    .select({
      latestSoldDate: sql<string | null>`max(${canvassSoldListing.soldDate})`,
      rows: sql<number>`count(*)::int`,
    })
    .from(canvassSoldListing)
    .where(eq(canvassSoldListing.tenantId, t.id));

  const [knock] = await adminDb
    .select({ lastKnockAt: sql<string | null>`max(${canvassKnock.createdAt})` })
    .from(canvassKnock)
    .where(eq(canvassKnock.tenantId, t.id));

  return reply(
    {
      ok: true,
      now: new Date().toISOString(),
      sold: { latestSoldDate: sold?.latestSoldDate ?? null, rows: sold?.rows ?? 0 },
      lastKnockAt: knock?.lastKnockAt ?? null,
    },
    200,
  );
}
