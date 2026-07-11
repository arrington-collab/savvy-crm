import { NextResponse } from "next/server";
import {
  buildCanvassDossier,
  dossierBoundingBox,
  escapeIlike,
  normalizeStreetName,
  DOSSIER_JOB_BBOX_DEG,
  DOSSIER_KNOCK_BBOX_DEG,
} from "@savvy/core";
import { withTenant, job, property, customer, canvassKnock, canvassRep, eq, and, gte, lte, ilike, isNotNull, desc } from "@savvy/db";
import { verifyCanvassToken, bearerToken } from "@/lib/canvass-session";
import { canvassCors } from "@/lib/canvass-cors";

export const runtime = "nodejs";

// GET — the "door dossier" for the knock modal: nearby jobs/customers, roofs on
//   the same street, and the last knock at this door — built ONLY from the
//   tenant's own data. Bearer session ONLY (returns homeowner PII); the tenant
//   comes from the session, never from a client-supplied key.
export function OPTIONS(req: Request): NextResponse {
  return new NextResponse(null, { status: 204, headers: canvassCors(req, "GET, OPTIONS") });
}

export async function GET(req: Request): Promise<NextResponse> {
  const headers = canvassCors(req, "GET, OPTIONS");
  const reply = (b: unknown, s: number) => NextResponse.json(b, { status: s, headers });

  const sess = verifyCanvassToken(bearerToken(req.headers));
  if (!sess) return reply({ error: "unauthorized" }, 401);

  const url = new URL(req.url);
  const lat = Number(url.searchParams.get("lat"));
  const lng = Number(url.searchParams.get("lng"));
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return reply({ error: "lat and lng are required numbers" }, 400);
  const address = url.searchParams.get("address") || undefined;

  const jobBox = dossierBoundingBox(lat, lng, DOSSIER_JOB_BBOX_DEG);
  const knockBox = dossierBoundingBox(lat, lng, DOSSIER_KNOCK_BBOX_DEG);
  const street = normalizeStreetName(address);

  const dossier = await withTenant(sess.tenantId, async (tx) => {
    // Bounding-box prefilter in SQL (RLS scopes the tenant); the precise
    // haversine cut happens in buildCanvassDossier.
    const jobRows = await tx
      .select({
        customerName: customer.name,
        address: property.address,
        lat: property.lat,
        lng: property.lng,
        stage: job.stage,
      })
      .from(job)
      .innerJoin(property, eq(property.id, job.propertyId))
      .innerJoin(customer, eq(customer.id, job.customerId))
      .where(
        and(
          isNotNull(property.lat),
          isNotNull(property.lng),
          gte(property.lat, jobBox.minLat),
          lte(property.lat, jobBox.maxLat),
          gte(property.lng, jobBox.minLng),
          lte(property.lng, jobBox.maxLng),
        ),
      )
      .limit(200);

    // ILIKE prefilter over the tenant's job addresses; the helper re-checks the
    // normalized street exactly ("Elm St" must not count "Helm St").
    const streetRows = street
      ? await tx
          .select({ address: property.address })
          .from(job)
          .innerJoin(property, eq(property.id, job.propertyId))
          .where(ilike(property.address, `%${escapeIlike(street)}%`))
          .limit(1000)
      : [];

    const knockRows = await tx
      .select({
        lat: canvassKnock.lat,
        lng: canvassKnock.lng,
        outcome: canvassKnock.outcome,
        createdAt: canvassKnock.createdAt,
        repName: canvassRep.name,
      })
      .from(canvassKnock)
      .leftJoin(canvassRep, eq(canvassRep.id, canvassKnock.repId))
      .where(
        and(
          gte(canvassKnock.lat, knockBox.minLat),
          lte(canvassKnock.lat, knockBox.maxLat),
          gte(canvassKnock.lng, knockBox.minLng),
          lte(canvassKnock.lng, knockBox.maxLng),
        ),
      )
      .orderBy(desc(canvassKnock.createdAt))
      .limit(50);

    return buildCanvassDossier({ lat, lng, address, jobRows, streetAddresses: streetRows.map((r) => r.address), knockRows });
  });

  return reply(dossier, 200);
}
