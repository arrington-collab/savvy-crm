import { and, eq, sql, asc } from "drizzle-orm";
import type { Tx } from "../tenant";
import { canvassPing } from "../schema/index";

export interface PingPoint { lat: number; lng: number; ts: number }

// Batch-insert a rep's trail points (max 200/batch, clamped).
export async function insertPings(tx: Tx, tenantId: string, repId: string, points: PingPoint[]): Promise<number> {
  const clean = points
    .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng) && Number.isFinite(p.ts))
    .slice(0, 200);
  if (clean.length === 0) return 0;
  await tx.insert(canvassPing).values(
    clean.map((p) => ({ tenantId, repId, lat: p.lat, lng: p.lng, at: new Date(p.ts) })),
  );
  return clean.length;
}

// All reps' points for one tenant-local day, grouped per rep, time-ordered.
export async function listPingsForDay(
  tx: Tx, tenantId: string, tz: string, date: string,
): Promise<{ repId: string; points: [number, number, number][] }[]> {
  const rows = await tx
    .select({ repId: canvassPing.repId, lat: canvassPing.lat, lng: canvassPing.lng, at: canvassPing.at })
    .from(canvassPing)
    .where(sql`(${canvassPing.at} AT TIME ZONE ${tz})::date = ${date}::date`)
    .orderBy(asc(canvassPing.at));
  const by = new Map<string, [number, number, number][]>();
  for (const r of rows) {
    if (!by.has(r.repId)) by.set(r.repId, []);
    by.get(r.repId)!.push([r.lat, r.lng, r.at.getTime()]);
  }
  return [...by.entries()].map(([repId, points]) => ({ repId, points }));
}
