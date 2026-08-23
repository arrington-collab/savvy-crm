import { NextResponse } from "next/server";
import { canvassKnockObject, canvassHaversineMeters, CANVASS_GPS_FLAG_METERS, evaluateAchievements } from "@savvy/core";
import { withTenant, upsertCanvassKnock, isCanvassRepActive, unlockAchievements, listAchievementKeys, tenant, canvassKnock, canvassRep, eq, gt, desc } from "@savvy/db";
import { inngest } from "@savvy/agents";
import { verifyCanvassToken, bearerToken } from "@/lib/canvass-session";
import { canvassCors } from "@/lib/canvass-cors";
import { log } from "@/lib/log";

export const runtime = "nodejs";

// POST — a rep logs OR EDITS a knock (bearer session). The client also sends its
//   live GPS (deviceLat/Lng); the server flags the knock if the marked door is
//   far from it. Upserts on (tenant, clientId): a replay is a no-op-shaped
//   update, and an edit (outcome change from the contact sheet, appt→sale after
//   a contract signs) overwrites the mutable fields instead of being dropped.
// GET  — the whole team's knocks for the shared map (bearer session, or ?key=).
export function OPTIONS(req: Request): NextResponse {
  return new NextResponse(null, { status: 204, headers: canvassCors(req, "GET, POST, OPTIONS") });
}

export async function POST(req: Request): Promise<NextResponse> {
  const headers = canvassCors(req, "GET, POST, OPTIONS");
  const reply = (b: unknown, s: number) => NextResponse.json(b, { status: s, headers });

  const sess = verifyCanvassToken(bearerToken(req.headers));
  if (!sess) return reply({ error: "unauthorized" }, 401);

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return reply({ error: "invalid json" }, 400);
  }
  const parsed = canvassKnockObject.safeParse(json);
  if (!parsed.success) return reply({ error: parsed.error.flatten() }, 400);
  const k = parsed.data;

  let gpsFlagged = false;
  let gpsDistanceM: number | undefined = undefined;
  if (typeof k.deviceLat === "number" && typeof k.deviceLng === "number") {
    gpsDistanceM = canvassHaversineMeters(k.lat, k.lng, k.deviceLat, k.deviceLng);
    gpsFlagged = gpsDistanceM > CANVASS_GPS_FLAG_METERS;
  }

  const result = await withTenant(sess.tenantId, async (tx) => {
    // reject a deactivated rep whose bearer token hasn't expired yet (distinct
    // from upsert returning id:null when setWhere blocks a teammate's-knock edit)
    if (!(await isCanvassRepActive(tx, sess.tenantId, sess.repId))) return { denied: true as const };
    return upsertCanvassKnock(tx, {
      tenantId: sess.tenantId,
      repId: sess.repId,
      clientId: k.clientId,
      lat: k.lat,
      lng: k.lng,
      outcome: k.outcome,
      address: k.address,
      contactName: k.contactName,
      contactPhone: k.contactPhone,
      notes: k.notes,
      amount: k.amount,
      scheduledAt: k.scheduledAt ? new Date(k.scheduledAt) : null,
      territoryClientId: k.territoryClientId,
      gpsFlagged,
      gpsDistanceM,
      contractSignedAt: k.contractSignedAt ? new Date(k.contractSignedAt) : null,
      leadId: k.leadId ?? null,
    });
  });
  if ("denied" in result) return reply({ error: "unauthorized" }, 401);
  if (gpsFlagged) log.warn("canvass gps-flagged knock", { route: "/api/canvass/knocks", tenantId: sess.tenantId, repId: sess.repId, m: gpsDistanceM });

  // A fresh sale with no contract yet starts the 30-min watch. Idempotent event
  // id so edits / appt→sale re-saves don't restart the clock.
  if (result.id && k.outcome === "sale" && !k.contractSignedAt) {
    try {
      await inngest.send({
        id: `sale:${result.id}`,
        name: "canvass/sale.logged",
        data: { tenantId: sess.tenantId, knockId: result.id, repId: sess.repId },
      });
    } catch (e) {
      log.error("canvass/sale.logged emit failed", { route: "/api/canvass/knocks", tenantId: sess.tenantId, msg: String(e) });
    }
  }

  // Re-evaluate this rep's badges from their full history; unlock any new ones.
  let newBadges: string[] = [];
  try {
    newBadges = await withTenant(sess.tenantId, async (tx) => {
      const [tRow] = await tx.select({ timezone: tenant.timezone }).from(tenant).where(eq(tenant.id, sess.tenantId));
      const tz = tRow?.timezone ?? "UTC";
      const rows = await tx
        .select({ outcome: canvassKnock.outcome, amount: canvassKnock.amount, createdAt: canvassKnock.createdAt })
        .from(canvassKnock)
        .where(eq(canvassKnock.repId, sess.repId));
      const earned = evaluateAchievements({ knocks: rows.map((r) => ({ outcome: r.outcome, amount: r.amount, at: r.createdAt })), tz });
      const already = new Set(await listAchievementKeys(tx, sess.tenantId, sess.repId));
      const toUnlock = earned.filter((k) => !already.has(k));
      return unlockAchievements(tx, sess.tenantId, sess.repId, toUnlock);
    });
  } catch {
    newBadges = []; // never fail a knock over gamification
  }
  return reply({ ok: true, id: result.id, gpsFlagged, gpsDistanceM, newBadges }, 201);
}

export async function GET(req: Request): Promise<NextResponse> {
  const headers = canvassCors(req, "GET, POST, OPTIONS");
  const url = new URL(req.url);

  // Bearer session ONLY: knock history is homeowner PII (names, phones, addresses,
  // notes, amounts) and the tenant publicKey ships in the app — never enough here.
  const sess = verifyCanvassToken(bearerToken(req.headers));
  const tenantId = sess?.tenantId;
  if (!tenantId) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers });

  const since = Number(url.searchParams.get("since") || 0);
  const knocks = await withTenant(tenantId, (tx) => {
    const base = tx
      .select({
        id: canvassKnock.id,
        clientId: canvassKnock.clientId,
        repId: canvassKnock.repId,
        repName: canvassRep.name,
        lat: canvassKnock.lat,
        lng: canvassKnock.lng,
        outcome: canvassKnock.outcome,
        address: canvassKnock.address,
        contactName: canvassKnock.contactName,
        contactPhone: canvassKnock.contactPhone,
        notes: canvassKnock.notes,
        amount: canvassKnock.amount,
        scheduledAt: canvassKnock.scheduledAt,
        leadId: canvassKnock.leadId,
        gpsFlagged: canvassKnock.gpsFlagged,
        gpsDistanceM: canvassKnock.gpsDistanceM,
        createdAt: canvassKnock.createdAt,
      })
      .from(canvassKnock)
      .leftJoin(canvassRep, eq(canvassRep.id, canvassKnock.repId))
      .$dynamic();
    const q = since ? base.where(gt(canvassKnock.createdAt, new Date(since))) : base;
    return q.orderBy(desc(canvassKnock.createdAt)).limit(2000);
  });
  return NextResponse.json({ knocks }, { status: 200, headers });
}
