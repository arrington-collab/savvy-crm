import { NextResponse } from "next/server";
import { dossierCacheFresh } from "@savvy/core";
import { withTenant, dossierCache, eq, and } from "@savvy/db";
import { verifyCanvassToken, bearerToken } from "@/lib/canvass-session";
import { canvassCors } from "@/lib/canvass-cors";

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

type Geo = { address: string | null; label: string | null };

async function viaMapTiler(lat: number, lng: number, key: string): Promise<Geo | null> {
  const u = new URL(`https://api.maptiler.com/geocoding/${lng},${lat}.json`);
  u.searchParams.set("key", key);
  u.searchParams.set("types", "address");
  u.searchParams.set("limit", "1");
  const res = await fetch(u);
  if (!res.ok) return null;
  const d = (await res.json()) as { features?: { text?: string; address?: string; place_name?: string }[] };
  const f = d.features?.[0];
  if (!f) return { address: null, label: null };
  const address = [f.address, f.text].filter(Boolean).join(" ") || null;
  const label = f.place_name ? f.place_name.split(",").slice(0, 2).join(",") : address;
  return { address, label };
}

async function viaNominatim(lat: number, lng: number): Promise<Geo | null> {
  const u = new URL("https://nominatim.openstreetmap.org/reverse");
  u.searchParams.set("format", "jsonv2");
  u.searchParams.set("lat", String(lat));
  u.searchParams.set("lon", String(lng));
  // OSM policy requires an identifying UA; the browser default from phones was neither
  const res = await fetch(u, { headers: { "User-Agent": "savvy-canvass/1.0 (support@getsavvy.com)" } });
  if (!res.ok) return null;
  const d = (await res.json()) as { address?: { house_number?: string; road?: string }; display_name?: string };
  const address = [d.address?.house_number, d.address?.road].filter(Boolean).join(" ") || null;
  const label = address || (d.display_name ? d.display_name.split(",").slice(0, 2).join(",") : null);
  return { address, label };
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

  const coordKey = `${lat.toFixed(5)},${lng.toFixed(5)}`;
  const geo = await withTenant(sess.tenantId, async (tx) => {
    const [hit] = await tx
      .select({ payload: dossierCache.payload, fetchedAt: dossierCache.fetchedAt })
      .from(dossierCache)
      .where(and(eq(dossierCache.kind, "geocode"), eq(dossierCache.coordKey, coordKey)));
    if (hit && dossierCacheFresh(hit.fetchedAt, GEOCODE_TTL_DAYS)) return hit.payload as Geo;

    const key = process.env.MAPTILER_API_KEY;
    let fresh: Geo | null = null;
    try {
      fresh = key ? await viaMapTiler(lat, lng, key) : await viaNominatim(lat, lng);
    } catch {
      fresh = null;
    }
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
