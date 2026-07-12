import { NextResponse } from "next/server";
import { dateKeyInTimeZone } from "@savvy/core";
import { withTenant, tenant, canvassRep, canvassKnock, eq, sql } from "@savvy/db";
import { verifyCanvassToken, bearerToken } from "@/lib/canvass-session";
import { canvassCors } from "@/lib/canvass-cors";

export const runtime = "nodejs";

// End-of-day team rollup for a date (?date=YYYY-MM-DD, default today): per active
// rep — doors, contacts, appts, sales, sale $, and GPS-flagged count.
// Auth = bearer session ONLY. The tenant publicKey ships in the app and is not a
// secret; team PII must never be readable with it (beta hardening).
export function OPTIONS(req: Request): NextResponse {
  return new NextResponse(null, { status: 204, headers: canvassCors(req, "GET, OPTIONS") });
}

export async function GET(req: Request): Promise<NextResponse> {
  const headers = canvassCors(req, "GET, OPTIONS");
  const url = new URL(req.url);
  const sess = verifyCanvassToken(bearerToken(req.headers));
  const tenantId = sess?.tenantId;
  if (!tenantId) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers });

  // Bucket by the tenant's local day, not the server's UTC day: created_at is
  // UTC, and `::date` in a UTC session would roll every after-5pm-Phoenix knock
  // onto the next day and default "today" to the wrong date each evening.
  const [tRow] = await withTenant(tenantId, (tx) =>
    tx.select({ timezone: tenant.timezone }).from(tenant).where(eq(tenant.id, tenantId)),
  );
  const tz = tRow?.timezone ?? "UTC";
  const date = url.searchParams.get("date") || dateKeyInTimeZone(new Date(), tz);

  const reps = await withTenant(tenantId, (tx) =>
    tx.select({ id: canvassRep.id, name: canvassRep.name }).from(canvassRep).where(eq(canvassRep.active, true)),
  );
  const knocks = await withTenant(tenantId, (tx) =>
    tx
      .select({
        repId: canvassKnock.repId,
        outcome: canvassKnock.outcome,
        contactName: canvassKnock.contactName,
        amount: canvassKnock.amount,
        gpsFlagged: canvassKnock.gpsFlagged,
      })
      .from(canvassKnock)
      .where(sql`(${canvassKnock.createdAt} AT TIME ZONE ${tz})::date = ${date}::date`),
  );

  const by = new Map(
    reps.map((r) => [r.id, { repId: r.id, repName: r.name, doors: 0, contacts: 0, appts: 0, sales: 0, saleAmount: 0, flagged: 0 }]),
  );
  for (const k of knocks) {
    const a = by.get(k.repId);
    if (!a) continue;
    a.doors++;
    if (k.contactName || k.outcome === "callback" || k.outcome === "appt" || k.outcome === "sale") a.contacts++;
    if (k.outcome === "appt") a.appts++;
    if (k.outcome === "sale") {
      a.sales++;
      a.saleAmount += k.amount ?? 0;
    }
    if (k.gpsFlagged) a.flagged++;
  }
  const report = [...by.values()].sort((x, y) => y.doors - x.doors || y.sales - x.sales);
  const totals = report.reduce(
    (t, r) => ({
      doors: t.doors + r.doors,
      contacts: t.contacts + r.contacts,
      appts: t.appts + r.appts,
      sales: t.sales + r.sales,
      saleAmount: t.saleAmount + r.saleAmount,
      flagged: t.flagged + r.flagged,
    }),
    { doors: 0, contacts: 0, appts: 0, sales: 0, saleAmount: 0, flagged: 0 },
  );
  return NextResponse.json({ date, report, totals }, { status: 200, headers });
}
