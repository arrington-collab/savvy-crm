import { NextResponse } from "next/server";
import {
  optimizeRoute, haversineMiles, routeLengthMiles,
  SOLD_CLAIM_RADIUS_MILES, SOLD_CLAIM_RELEASE_DAYS, SOLD_CLAIM_COUNTS, z,
} from "@savvy/core";
import { withTenant, canvassSoldListing, eq, and, or, isNull, inArray, lt, gte, lte, sql } from "@savvy/db";
import { verifyCanvassToken, bearerToken } from "@/lib/canvass-session";
import { canvassCors } from "@/lib/canvass-cors";
import { checkRateLimit } from "@/lib/rate-limit";
import { log } from "@/lib/log";

export const runtime = "nodejs";

// POST /api/canvass/sold/claim — a rep drops a pin and takes the nearest 15 or
// 25 recently-sold homes. They're claimed for that rep and returned in an
// optimized walking order.
//
// PESTKEE CONSTRAINT: routes draw ONLY from canvass_sold_listing. This endpoint
// never selects arbitrary addresses, prior knocks, or territory polygons —
// recently-sold homes are the entire product for a pest-control crew.
export function OPTIONS(req: Request): NextResponse {
  return new NextResponse(null, { status: 204, headers: canvassCors(req, "POST, OPTIONS") });
}

const bodySchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  count: z.number().int().refine((n) => (SOLD_CLAIM_COUNTS as readonly number[]).includes(n), "count must be 15 or 25"),
  // Where the rep actually is, if known — the route seeds from here so the
  // first stop is genuinely the closest to them, not to the dropped pin.
  fromLat: z.number().min(-90).max(90).optional(),
  fromLng: z.number().min(-180).max(180).optional(),
});

// A degree of latitude is ~69 miles; longitude shrinks by cos(lat). Used only
// to pre-filter in SQL — the exact haversine cut happens in code below.
const MILES_PER_DEG_LAT = 69;

export async function POST(req: Request): Promise<NextResponse> {
  const headers = canvassCors(req, "POST, OPTIONS");
  const reply = (b: unknown, s: number) => NextResponse.json(b, { status: s, headers });

  const sess = verifyCanvassToken(bearerToken(req.headers));
  if (!sess) return reply({ error: "unauthorized" }, 401);

  const { ok } = await checkRateLimit("canvass", `soldclaim:${sess.tenantId}:${sess.repId}`);
  if (!ok) return reply({ error: "rate_limited" }, 429);

  let json: unknown;
  try { json = await req.json(); } catch { return reply({ error: "invalid json" }, 400); }
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) return reply({ error: parsed.error.flatten() }, 400);
  const { lat, lng, count, fromLat, fromLng } = parsed.data;

  const dLat = SOLD_CLAIM_RADIUS_MILES / MILES_PER_DEG_LAT;
  const dLng = SOLD_CLAIM_RADIUS_MILES / (MILES_PER_DEG_LAT * Math.max(0.1, Math.cos((lat * Math.PI) / 180)));

  const result = await withTenant(sess.tenantId, async (tx) => {
    // Candidates: still worth knocking, not expired, and either free or holding
    // a claim old enough to have auto-released. Bounding box first so we don't
    // scan the county; the true radius cut is applied after.
    const candidates = await tx
      .select({
        id: canvassSoldListing.id,
        lat: canvassSoldListing.lat,
        lng: canvassSoldListing.lng,
      })
      .from(canvassSoldListing)
      .where(
        and(
          eq(canvassSoldListing.tenantId, sess.tenantId),
          inArray(canvassSoldListing.status, ["new", "goback"]),
          gte(canvassSoldListing.expiresAt, sql`CURRENT_DATE`),
          gte(canvassSoldListing.lat, lat - dLat),
          lte(canvassSoldListing.lat, lat + dLat),
          gte(canvassSoldListing.lng, lng - dLng),
          lte(canvassSoldListing.lng, lng + dLng),
          or(
            isNull(canvassSoldListing.assignedRepId),
            eq(canvassSoldListing.assignedRepId, sess.repId), // re-claiming my own is fine
            lt(canvassSoldListing.assignedAt, sql`now() - interval '${sql.raw(String(SOLD_CLAIM_RELEASE_DAYS))} days'`),
          ),
        ),
      )
      .limit(500);

    // Exact radius, then nearest-first, then take the requested count.
    const near = candidates
      .map((c) => ({ ...c, d: haversineMiles(lat, lng, c.lat, c.lng) }))
      .filter((c) => c.d <= SOLD_CLAIM_RADIUS_MILES)
      .sort((a, b) => a.d - b.d)
      .slice(0, count);

    if (near.length === 0) return { claimed: [], found: 0 };

    // Atomic claim: the same predicate is re-checked in the UPDATE, so if
    // another rep grabbed one of these between the read and the write, we
    // simply don't get it — no double-booked doors. The loser gets fewer and
    // is told, rather than two reps knocking the same house.
    const wonRows = await tx
      .update(canvassSoldListing)
      .set({ assignedRepId: sess.repId, assignedAt: sql`now()` })
      .where(
        and(
          eq(canvassSoldListing.tenantId, sess.tenantId),
          inArray(canvassSoldListing.id, near.map((n) => n.id)),
          or(
            isNull(canvassSoldListing.assignedRepId),
            eq(canvassSoldListing.assignedRepId, sess.repId),
            lt(canvassSoldListing.assignedAt, sql`now() - interval '${sql.raw(String(SOLD_CLAIM_RELEASE_DAYS))} days'`),
          ),
        ),
      )
      .returning({
        id: canvassSoldListing.id,
        address: canvassSoldListing.address,
        city: canvassSoldListing.city,
        zip: canvassSoldListing.zip,
        lat: canvassSoldListing.lat,
        lng: canvassSoldListing.lng,
        soldDate: canvassSoldListing.soldDate,
        expiresAt: canvassSoldListing.expiresAt,
        price: canvassSoldListing.price,
        beds: canvassSoldListing.beds,
        baths: canvassSoldListing.baths,
        sqft: canvassSoldListing.sqft,
        url: canvassSoldListing.url,
        status: canvassSoldListing.status,
      });

    // Seed from the rep's real position when we have it, else the dropped pin.
    const start = fromLat != null && fromLng != null ? { lat: fromLat, lng: fromLng } : { lat, lng };
    const ordered = optimizeRoute(wonRows.map((r) => ({ id: r.id, lat: r.lat, lng: r.lng })), start);
    const byId = new Map(wonRows.map((r) => [r.id, r]));

    // Persist the order so the route survives a reinstall and a manager can see
    // what a rep is working.
    for (let i = 0; i < ordered.length; i++) {
      await tx
        .update(canvassSoldListing)
        .set({ routeSeq: i + 1 })
        .where(and(eq(canvassSoldListing.tenantId, sess.tenantId), eq(canvassSoldListing.id, ordered[i]!.id)));
    }

    return {
      claimed: ordered.map((p, i) => ({ ...byId.get(p.id)!, routeSeq: i + 1 })),
      found: wonRows.length,
      miles: Math.round(routeLengthMiles(ordered, start) * 10) / 10,
    };
  });

  log.info("canvass.sold.claim", {
    tenantId: sess.tenantId, repId: sess.repId, requested: count, found: result.found,
  });

  return reply(
    {
      ...result,
      requested: count,
      radiusMiles: SOLD_CLAIM_RADIUS_MILES,
      releaseDays: SOLD_CLAIM_RELEASE_DAYS,
    },
    200,
  );
}
