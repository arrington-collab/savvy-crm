import { NextResponse } from "next/server";
import { SOLD_STATUSES, z } from "@savvy/core";
import { withTenant, canvassSoldListing, eq, and, sql } from "@savvy/db";
import { verifyCanvassToken, bearerToken } from "@/lib/canvass-session";
import { canvassCors } from "@/lib/canvass-cors";
import { checkRateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

// POST /api/canvass/sold/status — a rep sets a sold home's sign status
// (new|goback|notint|appt|customer|dnk).
//
// The sign's status is its OWN lifecycle, deliberately not derived from knock
// outcomes: the owner wants to mark a house a Go Back without logging a knock.
// The cost is that the two can disagree, which the pin popup surfaces rather
// than hides.
export function OPTIONS(req: Request): NextResponse {
  return new NextResponse(null, { status: 204, headers: canvassCors(req, "POST, OPTIONS") });
}

const bodySchema = z.object({
  id: z.string().uuid(),
  status: z.enum(SOLD_STATUSES),
});

export async function POST(req: Request): Promise<NextResponse> {
  const headers = canvassCors(req, "POST, OPTIONS");
  const reply = (b: unknown, s: number) => NextResponse.json(b, { status: s, headers });

  const sess = verifyCanvassToken(bearerToken(req.headers));
  if (!sess) return reply({ error: "unauthorized" }, 401);

  const { ok } = await checkRateLimit("canvass", `soldstatus:${sess.tenantId}:${sess.repId}`);
  if (!ok) return reply({ error: "rate_limited" }, 429);

  let json: unknown;
  try { json = await req.json(); } catch { return reply({ error: "invalid json" }, 400); }
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) return reply({ error: parsed.error.flatten() }, 400);
  const { id, status } = parsed.data;

  const updated = await withTenant(sess.tenantId, async (tx) =>
    tx
      .update(canvassSoldListing)
      .set({ status, statusAt: sql`now()`, statusByRepId: sess.repId })
      .where(and(eq(canvassSoldListing.tenantId, sess.tenantId), eq(canvassSoldListing.id, id)))
      .returning({ id: canvassSoldListing.id, status: canvassSoldListing.status, statusAt: canvassSoldListing.statusAt }),
  );

  if (!updated.length) return reply({ error: "not found" }, 404);
  return reply({ ok: true, listing: updated[0] }, 200);
}
