import { NextResponse } from "next/server";
import { dossierCacheFresh, isTileDue, DOSSIER_STORM_TTL_DAYS } from "@savvy/core";
import {
  httpStormProof,
  slimStormSwaths,
  computeHotCells,
  SWATH_HAIL_MONTHS,
  type StormProofGateway,
  type StormSwath,
  type HotCell,
} from "@savvy/integrations";
import { withTenant, dossierCache, canvassKnock, eq, and, gte, lte, type Tx } from "@savvy/db";
import { verifyCanvassToken, bearerToken } from "@/lib/canvass-session";
import { canvassCors } from "@/lib/canvass-cors";
import { reverseGeocode } from "@/lib/geocode";

export const runtime = "nodejs";
// Enrichment fans out to external county services (~5 s per uncached cell) —
// the 15 s default killed cold-cache requests mid-flight ("off and on" overlay).
export const maxDuration = 60;

// GET — the storm-targeting overlay for the field app map:
//   swaths  — verified HAIL (≤24 mo) + severe WIND (≤12 mo, ≥58 mph) polygons;
//   targets — ~1.1 km cells hit by 2+ wind events, the "where to knock" layer,
//             enriched with assessor year-built (gold = older roofs). Maricopa's
//             assessor needs an address, so each cell is reverse-geocoded first.
//   Read-only lookups; generateCertificate is never called. Bearer session;
//   cached in dossier_cache (kind "stormtargets", ~1 km key, 7 d) so the team
//   shares one fetch — enrichment costs (geocode + assessor) are paid once.
export function OPTIONS(req: Request): NextResponse {
  return new NextResponse(null, { status: 204, headers: canvassCors(req, "GET, OPTIONS") });
}

const gateway: { sp: StormProofGateway } = { sp: httpStormProof }; // injectable seam

// Gold tier: 2+ wind hits AND the sampled parcel is ≥15 years old. The cell
// center's parcel stands in for the tract — subdivisions build out together,
// so one year-built is a fair neighborhood proxy.
const GOLD_MIN_ROOF_YEARS = 15;
const ENRICH_CELL_CAP = 16;
// Stop starting new enrichment batches past this point. Uncached county
// lookups run ~5 s each; cells left unenriched come back gold:false and the
// payload is marked partial (not cached), so the next fetch retries — by then
// StormProof's own 30-day property cache has warmed those cells and the pass
// completes, at which point we cache for 7 days.
const ENRICH_BUDGET_MS = 20_000;

type Target = HotCell & { yearBuilt: number | null; gold: boolean; tile: boolean };
type Payload = { swaths: StormSwath[]; targets: Target[] };
// wire shape adds per-request fields the cache must not freeze:
type TargetOut = Target & { knocks: number };

// Fresh-doors dimming: knocks by the whole team in the last 45 days, bucketed
// per target cell. Computed at REQUEST time and merged into the (possibly
// cached) payload — a cell your team worked yesterday must dim today, not
// when the 7-day storm cache expires.
const KNOCK_WINDOW_DAYS = 45;
async function knockCounts(tx: Tx, targets: Target[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (!targets.length) return counts;
  const lats = targets.map((t) => t.lat);
  const lngs = targets.map((t) => t.lng);
  const pad = 0.006;
  const rows = await tx
    .select({ lat: canvassKnock.lat, lng: canvassKnock.lng })
    .from(canvassKnock)
    .where(
      and(
        gte(canvassKnock.createdAt, new Date(Date.now() - KNOCK_WINDOW_DAYS * 86_400_000)),
        gte(canvassKnock.lat, Math.min(...lats) - pad),
        lte(canvassKnock.lat, Math.max(...lats) + pad),
        gte(canvassKnock.lng, Math.min(...lngs) - pad),
        lte(canvassKnock.lng, Math.max(...lngs) + pad),
      ),
    )
    .limit(5000);
  for (const k of rows) {
    for (const t of targets) {
      if (Math.abs(k.lat - t.lat) <= 0.005 && Math.abs(k.lng - t.lng) <= 0.005) {
        const key = `${t.lat},${t.lng}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
        break;
      }
    }
  }
  return counts;
}

async function enrichCells(sp: StormProofGateway, cells: HotCell[]): Promise<{ targets: Target[]; partial: boolean }> {
  const nowYear = new Date().getFullYear();
  const started = Date.now();
  const targets: Target[] = [];
  let partial = false;
  for (let i = 0; i < cells.length; i += 8) {
    if (Date.now() - started > ENRICH_BUDGET_MS) {
      targets.push(...cells.slice(i).map((c) => ({ ...c, yearBuilt: null, gold: false, tile: false })));
      partial = true;
      break;
    }
    const batch = await Promise.all(
      cells.slice(i, i + 8).map(async (c): Promise<Target> => {
        try {
          const geo = await reverseGeocode(c.lat, c.lng);
          const prop = await sp.getProperty({ lat: c.lat, lng: c.lng, address: geo?.address ?? undefined });
          const yearBuilt = prop?.yearBuilt ?? null;
          // approximate (block-median) data is exactly right here — gold/tile
          // are neighborhood flags, not parcel claims
          return {
            ...c,
            yearBuilt,
            gold: yearBuilt != null && nowYear - yearBuilt >= GOLD_MIN_ROOF_YEARS,
            tile: isTileDue({ roofType: prop?.roofType, yearBuilt, lat: c.lat, lng: c.lng }),
          };
        } catch {
          return { ...c, yearBuilt: null, gold: false, tile: false };
        }
      }),
    );
    targets.push(...batch);
  }
  return { targets, partial };
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

  if (!process.env.STORMPROOF_API_BASE) return reply({ swaths: [], targets: [] }, 200);

  const coordKey = `${lat.toFixed(2)},${lng.toFixed(2)}`;
  const payload = await withTenant(sess.tenantId, async (tx): Promise<{ swaths: StormSwath[]; targets: TargetOut[] }> => {
    const withKnocks = async (p: Payload) => {
      const counts = await knockCounts(tx, p.targets);
      return { swaths: p.swaths, targets: p.targets.map((t) => ({ ...t, knocks: counts.get(`${t.lat},${t.lng}`) ?? 0 })) };
    };
    const [hit] = await tx
      .select({ payload: dossierCache.payload, fetchedAt: dossierCache.fetchedAt })
      .from(dossierCache)
      .where(and(eq(dossierCache.kind, "stormtargets"), eq(dossierCache.coordKey, coordKey)));
    if (hit && dossierCacheFresh(hit.fetchedAt, DOSSIER_STORM_TTL_DAYS)) return withKnocks(hit.payload as Payload);

    // one 24-mo pull covers both perils; the wind window narrows in slimStormSwaths
    const tracks = await gateway.sp.lookupStormTracks({ lat, lng, months: SWATH_HAIL_MONTHS }).catch(() => []);
    const swaths = slimStormSwaths(tracks);
    const cells = computeHotCells(swaths, { lat, lng }).slice(0, ENRICH_CELL_CAP); // cells already carry ≥2 wind hits
    const { targets, partial } = cells.length ? await enrichCells(gateway.sp, cells) : { targets: [], partial: false };
    const fresh: Payload = { swaths, targets };

    if (tracks.length > 0 && !partial) {
      // cache only complete answers: a gateway failure ([]) or a budget-cut
      // enrichment shouldn't pin a degraded overlay to this square for a week
      await tx
        .insert(dossierCache)
        .values({ tenantId: sess.tenantId, kind: "stormtargets", coordKey, payload: fresh, fetchedAt: new Date() })
        .onConflictDoUpdate({
          target: [dossierCache.tenantId, dossierCache.kind, dossierCache.coordKey],
          set: { payload: fresh, fetchedAt: new Date() },
        });
    }
    return withKnocks(fresh);
  });

  return reply(payload, 200);
}
