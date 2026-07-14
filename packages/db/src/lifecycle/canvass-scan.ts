import { desc, eq } from "drizzle-orm";
import type { Tx } from "../tenant";
import { canvassScan, canvassRep } from "../schema/index";

export interface CreateScanArgs {
  tenantId: string; repId: string;
  name?: string | null; phone?: string | null; ack?: boolean; userAgent?: string | null;
}

// Homeowner scanned a rep's ID and submitted the capture form.
export async function createScan(tx: Tx, a: CreateScanArgs): Promise<{ id: string }> {
  const now = new Date();
  const [row] = await tx.insert(canvassScan).values({
    tenantId: a.tenantId, repId: a.repId,
    name: a.name ?? null, phone: a.phone ?? null,
    ack: !!a.ack, ackAt: a.ack ? now : null,
    userAgent: a.userAgent ?? null,
  }).returning({ id: canvassScan.id });
  return { id: row!.id };
}

export interface ScanRow {
  id: string; repId: string; repName: string | null;
  name: string | null; phone: string | null; ack: boolean; createdAt: Date;
}

// Recent scans for the manager dashboard card.
export async function listScans(tx: Tx, tenantId: string, limit = 50): Promise<ScanRow[]> {
  const rows = await tx
    .select({ id: canvassScan.id, repId: canvassScan.repId, repName: canvassRep.name,
      name: canvassScan.name, phone: canvassScan.phone, ack: canvassScan.ack, createdAt: canvassScan.createdAt })
    .from(canvassScan)
    .leftJoin(canvassRep, eq(canvassRep.id, canvassScan.repId))
    .orderBy(desc(canvassScan.createdAt)).limit(limit);
  return rows;
}
