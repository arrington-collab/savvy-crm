import { NextResponse } from "next/server";
import {
  buildCanvassDossier,
  dossierBoundingBox,
  dossierCacheFresh,
  dossierCoordKey,
  escapeIlike,
  normalizeStreetName,
  shapeDossierProperty,
  shapeDossierStorm,
  DOSSIER_JOB_BBOX_DEG,
  DOSSIER_KNOCK_BBOX_DEG,
  DOSSIER_PROPERTY_TTL_DAYS,
  DOSSIER_STORM_MONTHS,
  DOSSIER_STORM_TTL_DAYS,
  type PropertyDataLike,
  type StormSummaryLike,
} from "@savvy/core";
import { httpStormProof, type StormProofGateway } from "@savvy/integrations";
import {
  withTenant,
  job,
  property,
  customer,
  canvassKnock,
  canvassRep,
  dossierCache,
  eq,
  and,
  gte,
  lte,
  ilike,
  isNotNull,
  desc,
  inArray,
  type Tx,
} from "@savvy/db";
import { verifyCanvassToken, bearerToken } from "@/lib/canvass-session";
import { canvassCors } from "@/lib/canvass-cors";

export const runtime = "nodejs";

// GET — the "door dossier" for the knock modal. Phase 1: nearby jobs/customers,
//   roofs on the same street, last knock at this door (tenant's own data).
//   Phase 2: verified storm history + roof age/material via the StormProof
//   gateway (read-only lookups; generateCertificate is never called here).
//   Bearer session ONLY (returns homeowner PII); tenant comes from the session.
export function OPTIONS(req: Request): NextResponse {
  return new NextResponse(null, { status: 204, headers: canvassCors(req, "GET, OPTIONS") });
}

// StormProof lookups, cached in dossier_cache by rounded coordinates so repeat
// knocks on the same door never re-hit (or re-charge) the gateway. When creds
// are unset we return nulls immediately and cache nothing — otherwise a
// pre-creds EMPTY result would mask real data for a full TTL once creds land.
// getProperty null (failure OR no coverage) is likewise never cached.
async function cachedStormProperty(
  tx: Tx,
  sp: StormProofGateway,
  tenantId: string,
  o: { lat: number; lng: number; address?: string },
): Promise<{ storms: StormSummaryLike | null; prop: PropertyDataLike | null }> {
  if (!process.env.STORMPROOF_API_BASE) return { storms: null, prop: null };

  const coordKey = dossierCoordKey(o.lat, o.lng);
  const cached = await tx
    .select({ kind: dossierCache.kind, payload: dossierCache.payload, fetchedAt: dossierCache.fetchedAt })
    .from(dossierCache)
    .where(and(eq(dossierCache.coordKey, coordKey), inArray(dossierCache.kind, ["storms", "property"])));

  const fresh = (kind: string, ttlDays: number) => {
    const row = cached.find((r) => r.kind === kind);
    return row && dossierCacheFresh(row.fetchedAt, ttlDays) ? row : undefined;
  };
  const put = (kind: string, payload: unknown) =>
    tx
      .insert(dossierCache)
      .values({ tenantId, kind, coordKey, payload, fetchedAt: new Date() })
      .onConflictDoUpdate({
        target: [dossierCache.tenantId, dossierCache.kind, dossierCache.coordKey],
        set: { payload, fetchedAt: new Date() },
      });

  const cachedStorms = fresh("storms", DOSSIER_STORM_TTL_DAYS);
  const cachedProp = fresh("property", DOSSIER_PROPERTY_TTL_DAYS);

  const [storms, prop] = await Promise.all([
    cachedStorms
      ? Promise.resolve(cachedStorms.payload as StormSummaryLike)
      : sp
          .lookupStorms({ lat: o.lat, lng: o.lng, months: DOSSIER_STORM_MONTHS })
          .then(async (s) => {
            await put("storms", s); // EMPTY is a legit cacheable answer ("no storms here")
            return s as StormSummaryLike;
          })
          .catch(() => null),
    cachedProp
      ? Promise.resolve(cachedProp.payload as PropertyDataLike)
      : sp
          .getProperty({ lat: o.lat, lng: o.lng, address: o.address })
          .then(async (p) => {
            // Cache only payloads with actual roof data. Some county assessors
            // are address-based, and the knock modal's FIRST dossier call fires
            // before reverse-geocoding resolves the address — caching that
            // empty {supported:true} answer would starve the address-carrying
            // second call (and every knock at this door) for a full TTL.
            if (p && (p.yearBuilt != null || p.roofAge != null || p.roofType != null)) await put("property", p);
            return p as PropertyDataLike | null;
          })
          .catch(() => null),
  ]);
  return { storms, prop };
}

async function internalDossierRows(tx: Tx, o: { lat: number; lng: number; street: string | null }) {
  const jobBox = dossierBoundingBox(o.lat, o.lng, DOSSIER_JOB_BBOX_DEG);
  const knockBox = dossierBoundingBox(o.lat, o.lng, DOSSIER_KNOCK_BBOX_DEG);

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
  const streetRows = o.street
    ? await tx
        .select({ address: property.address })
        .from(job)
        .innerJoin(property, eq(property.id, job.propertyId))
        .where(ilike(property.address, `%${escapeIlike(o.street)}%`))
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

  return { jobRows, streetAddresses: streetRows.map((r) => r.address), knockRows };
}

const gateway: { sp: StormProofGateway } = { sp: httpStormProof }; // injectable seam

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
  const street = normalizeStreetName(address);

  const dossier = await withTenant(sess.tenantId, async (tx) => {
    // External HTTP overlaps the internal SQL; a StormProof timeout can only
    // null those fields, never block or fail the dossier.
    const [internal, external] = await Promise.all([
      internalDossierRows(tx, { lat, lng, street }),
      cachedStormProperty(tx, gateway.sp, sess.tenantId, { lat, lng, address }),
    ]);
    return {
      ...buildCanvassDossier({ lat, lng, address, ...internal }),
      storm: shapeDossierStorm(external.storms),
      property: shapeDossierProperty(external.prop, { lat, lng }),
    };
  });

  return reply(dossier, 200);
}
