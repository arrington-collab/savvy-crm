import { NextResponse } from "next/server";
import { withTenant, canvassRep, canvassKnock, eq, sql } from "@savvy/db";
import { tenantByKey } from "@/lib/intake";
import { verifyCanvassToken, bearerToken } from "@/lib/canvass-session";
import { canvassCors } from "@/lib/canvass-cors";

export const runtime = "nodejs";

// End-of-day team rollup for a date (?date=YYYY-MM-DD, default today): per active
// rep — doors, contacts, appts, sales, sale $, and GPS-flagged count.
// Auth = bearer session or ?key=.
export function OPTIONS(req: Request): NextResponse {
  return new NextResponse(null, { status: 204, headers: canvassCors(req, "GET, OPTIONS") });
}

export async function GET(req: Request): Promise<NextResponse> {
  const headers = canvassCors(req, "GET, OPTIONS");
  const url = new URL(req.url);
  const sess = verifyCanvassToken(bearerToken(req.headers));
  let tenantId = sess?.tenantId;
  if (!tenantId) {
    const key = url.searchParams.get("key");
    if (key) tenantId = (await tenantByKey(key))?.id;
  }
  if (!tenantId) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers });

  const date = url.searchParams.get("date") || new Date().toISOString().slice(0, 10);

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
      .where(sql`${canvassKnock.createdAt}::date = ${date}::date`),
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
