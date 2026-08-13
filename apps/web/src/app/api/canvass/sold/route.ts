import { NextResponse } from "next/server";
import { soldConfigFrom } from "@savvy/core";
import { withTenant, canvassSoldListing, tenant, eq, and, gte, lte, sql } from "@savvy/db";
import { verifyCanvassToken, bearerToken } from "@/lib/canvass-session";
import { canvassCors } from "@/lib/canvass-cors";
import { checkRateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

// GET /api/canvass/sold?lat&lng — the "Recently Sold" overlay for the field-app
// map: homes that changed hands recently, so reps can reach new homeowners
// early. Mirrors /api/canvass/storms — same bearer session, same CORS helper,
// same rate limiter, and viewport-scoped so a rep loads their neighborhood
// rather than every row in the county.
export function OPTIONS(req: Request): NextResponse {
  return new NextResponse(null, { status: 204, headers: canvassCors(req, "GET, OPTIONS") });
}

// ~0.35 deg latitude ≈ 24 mi — comfortably past what fits on screen at the
// zoom reps actually knock at, without pulling the whole metro.
const BOX_DEG = 0.35;

export async function GET(req: Request): Promise<NextResponse> {
  const headers = canvassCors(req, "GET, OPTIONS");
  const reply = (b: unknown, s: number) => NextResponse.json(b, { status: s, headers });

  const sess = verifyCanvassToken(bearerToken(req.headers));
  if (!sess) return reply({ error: "unauthorized" }, 401);

  const { ok } = await checkRateLimit("canvass", `sold:${sess.tenantId}:${sess.repId}`);
  if (!ok) return reply({ error: "rate_limited" }, 429);

  const url = new URL(req.url);
  const lat = Number(url.searchParams.get("lat"));
  const lng = Number(url.searchParams.get("lng"));
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return reply({ error: "lat and lng are required" }, 400);
  }

  const listings = await withTenant(sess.tenantId, async (tx) => {
    const [t] = await tx
      .select({ settings: tenant.settings })
      .from(tenant)
      .where(eq(tenant.id, sess.tenantId));
    const cfg = soldConfigFrom(t?.settings ?? {});
    // Off for this tenant → an empty layer, not an error. The field app simply
    // renders nothing and the toggle stays inert.
    if (!cfg.enabled) return [];

    return tx
      .select({
        id: canvassSoldListing.id,
        address: canvassSoldListing.address,
        city: canvassSoldListing.city,
        zip: canvassSoldListing.zip,
        lat: canvassSoldListing.lat,
        lng: canvassSoldListing.lng,
        soldDate: canvassSoldListing.soldDate,
        // Sent so the client can run its own expiry filter — without this the
        // app-side safety net silently never fires.
        expiresAt: canvassSoldListing.expiresAt,
        // Sign lifecycle — drives the pin colour and the "hide notint after a
        // week" rule, which is applied on both sides so a failed sweep can't
        // resurrect dead doors.
        status: canvassSoldListing.status,
        statusAt: canvassSoldListing.statusAt,
        assignedRepId: canvassSoldListing.assignedRepId,
        routeSeq: canvassSoldListing.routeSeq,
        price: canvassSoldListing.price,
        beds: canvassSoldListing.beds,
        baths: canvassSoldListing.baths,
        sqft: canvassSoldListing.sqft,
        url: canvassSoldListing.url,
      })
      .from(canvassSoldListing)
      .where(
        and(
          eq(canvassSoldListing.tenantId, sess.tenantId),
          // Belt and braces with the weekly prune: a failed prune must never
          // surface a stale pin to a rep.
          gte(canvassSoldListing.expiresAt, sql`CURRENT_DATE`),
          // Not-interested signs fade off the map after a week so it doesn't
          // fill with dead doors. `dnk` is deliberately NOT hidden — it exists
          // to stop the next rep walking up to that door.
          sql`(${canvassSoldListing.status} <> 'notint'
               OR ${canvassSoldListing.statusAt} > now() - interval '7 days')`,
          // A home actively claimed by ANOTHER rep is hidden entirely, not just
          // unclaimable: leaving it on the map invites two reps knocking the
          // same door, which is the exact collision claiming exists to prevent.
          // Own claims stay visible (numbered), and a claim past its 30-day
          // release is visible again to everyone.
          sql`(${canvassSoldListing.assignedRepId} IS NULL
               OR ${canvassSoldListing.assignedRepId} = ${sess.repId}
               OR ${canvassSoldListing.assignedAt} < now() - interval '30 days')`,
          gte(canvassSoldListing.lat, lat - BOX_DEG),
          lte(canvassSoldListing.lat, lat + BOX_DEG),
          gte(canvassSoldListing.lng, lng - BOX_DEG),
          lte(canvassSoldListing.lng, lng + BOX_DEG),
        ),
      )
      .limit(2000);
  });

  return reply({ listings }, 200);
}
