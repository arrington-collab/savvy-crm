import { NextResponse } from "next/server";
import { dossierCacheFresh, DOSSIER_STORM_MONTHS, DOSSIER_STORM_TTL_DAYS } from "@savvy/core";
import { httpStormProof, slimHailTracks, type StormProofGateway, type HailSwath } from "@savvy/integrations";
import { withTenant, dossierCache, eq, and } from "@savvy/db";
import { verifyCanvassToken, bearerToken } from "@/lib/canvass-session";
import { canvassCors } from "@/lib/canvass-cors";

export const runtime = "nodejs";

// GET — verified HAIL swath polygons around a point, for the field app's map
//   overlay (reps knock INTO the swath). Read-only StormProof lookup; wind
//   tracks are dropped server-side (they triple the payload for little
//   door-knocking value). Bearer session; cached in dossier_cache (kind
//   "stormtracks") on a ~1 km coord key — an area overlay, so nearby teammates
//   share the entry. generateCertificate is never called here.
export function OPTIONS(req: Request): NextResponse {
  return new NextResponse(null, { status: 204, headers: canvassCors(req, "GET, OPTIONS") });
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

  if (!process.env.STORMPROOF_API_BASE) return reply({ swaths: [] }, 200);

  const coordKey = `${lat.toFixed(2)},${lng.toFixed(2)}`;
  const swaths = await withTenant(sess.tenantId, async (tx) => {
    const [hit] = await tx
      .select({ payload: dossierCache.payload, fetchedAt: dossierCache.fetchedAt })
      .from(dossierCache)
      .where(and(eq(dossierCache.kind, "stormtracks"), eq(dossierCache.coordKey, coordKey)));
    if (hit && dossierCacheFresh(hit.fetchedAt, DOSSIER_STORM_TTL_DAYS)) return hit.payload as HailSwath[];

    const tracks = await gateway.sp.lookupStormTracks({ lat, lng, months: DOSSIER_STORM_MONTHS }).catch(() => []);
    const slim = slimHailTracks(tracks);
    if (tracks.length > 0) {
      // cache only real answers — a gateway failure returns [] and shouldn't
      // pin an empty overlay to this square for a week
      await tx
        .insert(dossierCache)
        .values({ tenantId: sess.tenantId, kind: "stormtracks", coordKey, payload: slim, fetchedAt: new Date() })
        .onConflictDoUpdate({
          target: [dossierCache.tenantId, dossierCache.kind, dossierCache.coordKey],
          set: { payload: slim, fetchedAt: new Date() },
        });
    }
    return slim;
  });

  return reply({ swaths }, 200);
}
