import { NextResponse } from "next/server";
import { dossierCacheFresh } from "@savvy/core";
import { withTenant, dossierCache, eq, and } from "@savvy/db";
import { verifyCanvassToken, bearerToken } from "@/lib/canvass-session";
import { canvassCors } from "@/lib/canvass-cors";
import { reverseGeocode, type Geo } from "@/lib/geocode";

export const runtime = "nodejs";

// GET — reverse-geocode a knock point for the field app. The app used to call
//   Nominatim straight from every phone, which violates OSM's usage policy and
//   puts a third party on the critical path. Proxying it here lets us swap the
//   provider server-side (MapTiler when MAPTILER_API_KEY is set, Nominatim with
//   a proper identifying User-Agent otherwise) and cache per door.
//   Bearer session required; addresses cache in dossier_cache (kind "geocode",
//   5-dp coord key ≈ 1 m — per-tap precision; addresses don't move, TTL 30 d).
export function OPTIONS(req: Request): NextResponse {
  return new NextResponse(null, { status: 204, headers: canvassCors(req, "GET, OPTIONS") });
}

const GEOCODE_TTL_DAYS = 30;

export async function GET(req: Request): Promise<NextResponse> {
  const headers = canvassCors(req, "GET, OPTIONS");
  const reply = (b: unknown, s: number) => NextResponse.json(b, { status: s, headers });

  const sess = verifyCanvassToken(bearerToken(req.headers));
  if (!sess) return reply({ error: "unauthorized" }, 401);

  const url = new URL(req.url);
  const lat = Number(url.searchParams.get("lat"));
  const lng = Number(url.searchParams.get("lng"));
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return reply({ error: "lat and lng are required numbers" }, 400);

  const coordKey = `${lat.toFixed(5)},${lng.toFixed(5)}`;
  const geo = await withTenant(sess.tenantId, async (tx) => {
    const [hit] = await tx
      .select({ payload: dossierCache.payload, fetchedAt: dossierCache.fetchedAt })
      .from(dossierCache)
      .where(and(eq(dossierCache.kind, "geocode"), eq(dossierCache.coordKey, coordKey)));
    if (hit && dossierCacheFresh(hit.fetchedAt, GEOCODE_TTL_DAYS)) return hit.payload as Geo;

    const fresh: Geo | null = await reverseGeocode(lat, lng);
    if (fresh?.address) {
      await tx
        .insert(dossierCache)
        .values({ tenantId: sess.tenantId, kind: "geocode", coordKey, payload: fresh, fetchedAt: new Date() })
        .onConflictDoUpdate({
          target: [dossierCache.tenantId, dossierCache.kind, dossierCache.coordKey],
          set: { payload: fresh, fetchedAt: new Date() },
        });
    }
    return fresh;
  });

  return reply(geo ?? { address: null, label: null }, 200);
}
