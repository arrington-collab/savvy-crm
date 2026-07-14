import { NextResponse } from "next/server";
import { dossierCoordKey } from "@savvy/core";
import { httpStormProof, type StormProofGateway } from "@savvy/integrations";
import { withTenant, dossierCache, isCanvassRepActive, eq, and } from "@savvy/db";
import { verifyCanvassToken, bearerToken } from "@/lib/canvass-session";
import { canvassCors } from "@/lib/canvass-cors";
import { checkRateLimit } from "@/lib/rate-limit";
import { log } from "@/lib/log";

export const runtime = "nodejs";
export const maxDuration = 60; // cert generation hits IEM/SPC + renders a PDF upstream

// POST — mint a StormProof verification certificate for a door, fired by the
//   field app when a knock becomes an APPOINTMENT or SALE (never from browse
//   paths — generateCertificate has cost/side effects). Idempotent per
//   (tenant, ~11 m coord key): repeat appointments at the same door reuse the
//   existing cert instead of minting again. The response returns the verify
//   URL + storm facts; the PDF stays with StormProof (reps share the URL).
export function OPTIONS(req: Request): NextResponse {
  return new NextResponse(null, { status: 204, headers: canvassCors(req, "POST, OPTIONS") });
}

const gateway: { sp: StormProofGateway } = { sp: httpStormProof }; // injectable seam

type CertPayload = { certId: string | null; verifyUrl: string | null; pdfUrl: string | null; verified: boolean; storm: unknown };

export async function POST(req: Request): Promise<NextResponse> {
  const headers = canvassCors(req, "POST, OPTIONS");
  const reply = (b: unknown, s: number) => NextResponse.json(b, { status: s, headers });

  const sess = verifyCanvassToken(bearerToken(req.headers));
  if (!sess) return reply({ error: "unauthorized" }, 401);

  // Cost-bearing mint: throttle per rep and reject deactivated reps whose
  // token hasn't expired yet.
  const { ok } = await checkRateLimit("canvass-cert", `${sess.tenantId}:${sess.repId}`);
  if (!ok) return reply({ error: "rate_limited" }, 429);
  const active = await withTenant(sess.tenantId, (tx) => isCanvassRepActive(tx, sess.tenantId, sess.repId));
  if (!active) return reply({ error: "unauthorized" }, 401);

  let json: { lat?: number; lng?: number; address?: string };
  try {
    json = (await req.json()) as typeof json;
  } catch {
    return reply({ error: "invalid json" }, 400);
  }
  const lat = Number(json.lat);
  const lng = Number(json.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return reply({ error: "lat and lng are required numbers" }, 400);
  const address = typeof json.address === "string" && json.address.trim() ? json.address.trim().slice(0, 300) : undefined;

  if (!process.env.STORMPROOF_API_BASE) return reply({ certId: null, verifyUrl: null, pdfUrl: null, verified: false, storm: null }, 200);

  const coordKey = dossierCoordKey(lat, lng);
  const cert = await withTenant(sess.tenantId, async (tx): Promise<CertPayload | null> => {
    const [hit] = await tx
      .select({ payload: dossierCache.payload })
      .from(dossierCache)
      .where(and(eq(dossierCache.kind, "cert"), eq(dossierCache.coordKey, coordKey)));
    if (hit) return hit.payload as CertPayload; // certs don't expire — no TTL

    let fresh: CertPayload | null = null;
    try {
      const r = await gateway.sp.generateCertificate({ lat, lng, address, months: 24 });
      fresh = { certId: r.certId ?? null, verifyUrl: r.verifyUrl ?? null, pdfUrl: r.pdfUrl ?? null, verified: r.verified, storm: r.storm ?? null };
    } catch (e) {
      log.warn("canvass cert generation failed", { route: "/api/canvass/certificate", tenantId: sess.tenantId, err: String(e) });
      return null;
    }
    if (fresh.certId) {
      await tx
        .insert(dossierCache)
        .values({ tenantId: sess.tenantId, kind: "cert", coordKey, payload: fresh, fetchedAt: new Date() })
        .onConflictDoUpdate({
          target: [dossierCache.tenantId, dossierCache.kind, dossierCache.coordKey],
          set: { payload: fresh, fetchedAt: new Date() },
        });
      log.info("canvass cert minted", { route: "/api/canvass/certificate", tenantId: sess.tenantId, certId: fresh.certId });
    }
    return fresh;
  });

  if (!cert) return reply({ error: "certificate unavailable" }, 502);
  return reply(cert, 200);
}
