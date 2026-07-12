import { NextResponse } from "next/server";
import { scoreRep, levelFor, currentStreak, dateKeyInTimeZone, DEFAULT_POINT_WEIGHTS } from "@savvy/core";
import { withTenant, tenant, canvassRep, canvassKnock, eq, and, gte } from "@savvy/db";
import { verifyCanvassToken, bearerToken } from "@/lib/canvass-session";
import { canvassCors } from "@/lib/canvass-cors";
import { checkRateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

// GET — team scoreboard: per-rep points/rank/tier/streak for a period, derived
// from canvass_knock. Points/period windowing use the tenant's timezone; streak
// uses the rep's full history (last 120 days pulled). Bearer session only.
export function OPTIONS(req: Request): NextResponse {
  return new NextResponse(null, { status: 204, headers: canvassCors(req, "GET, OPTIONS") });
}

const PERIODS = new Set(["day", "week", "month", "all"]);

export async function GET(req: Request): Promise<NextResponse> {
  const headers = canvassCors(req, "GET, OPTIONS");
  const reply = (b: unknown, s: number) => NextResponse.json(b, { status: s, headers });

  const sess = verifyCanvassToken(bearerToken(req.headers));
  if (!sess) return reply({ error: "unauthorized" }, 401);
  const { ok } = await checkRateLimit("canvass-read", `${sess.tenantId}:${sess.repId}`);
  if (!ok) return reply({ error: "rate_limited" }, 429);

  const url = new URL(req.url);
  const period = url.searchParams.get("period") || "week";
  if (!PERIODS.has(period)) return reply({ error: "bad period" }, 400);

  const result = await withTenant(sess.tenantId, async (tx) => {
    const [tRow] = await tx.select({ timezone: tenant.timezone }).from(tenant).where(eq(tenant.id, sess.tenantId));
    const tz = tRow?.timezone ?? "UTC";
    const reps = await tx.select({ id: canvassRep.id, name: canvassRep.name }).from(canvassRep).where(eq(canvassRep.active, true));

    // Pull the last 120 days of knocks once; window for points in JS by tz-day.
    const since = new Date(Date.now() - 120 * 86_400_000);
    const knocks = await tx
      .select({ repId: canvassKnock.repId, outcome: canvassKnock.outcome, amount: canvassKnock.amount, createdAt: canvassKnock.createdAt })
      .from(canvassKnock)
      .where(gte(canvassKnock.createdAt, since));

    const now = new Date();
    const startKey =
      period === "day" ? dateKeyInTimeZone(now, tz)
      : period === "week" ? dateKeyInTimeZone(new Date(now.getTime() - 6 * 86_400_000), tz)
      : period === "month" ? dateKeyInTimeZone(new Date(now.getTime() - 29 * 86_400_000), tz)
      : "0000-00-00";

    const byRep = new Map(reps.map((r) => [r.id, { repId: r.id, name: r.name, times: [] as Date[], windowed: [] as { outcome: string; amount: number | null }[] }]));
    for (const k of knocks) {
      const b = byRep.get(k.repId);
      if (!b) continue;
      b.times.push(k.createdAt);
      if (dateKeyInTimeZone(k.createdAt, tz) >= startKey) b.windowed.push({ outcome: k.outcome, amount: k.amount });
    }

    const leaders = [...byRep.values()].map((b) => {
      const points = scoreRep(b.windowed, DEFAULT_POINT_WEIGHTS);
      const doors = b.windowed.length;
      const appts = b.windowed.filter((k) => k.outcome === "appt").length;
      const sales = b.windowed.filter((k) => k.outcome === "sale");
      return {
        repId: b.repId,
        name: b.name,
        points,
        tier: levelFor(scoreRep(b.windowed)).tier, // period tier from period points
        streak: currentStreak(b.times, tz, now), // streak from full history
        doors,
        appts,
        sales: sales.length,
        revenue: sales.reduce((s, k) => s + (k.amount ?? 0), 0),
      };
    });
    leaders.sort((x, y) => y.points - x.points || y.sales - x.sales);
    return leaders.map((l, i) => ({ ...l, rank: i + 1 }));
  });

  return reply({ period, leaders: result }, 200);
}
