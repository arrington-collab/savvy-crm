import { and, desc, eq, or } from "drizzle-orm";
import { settlementSpiffs, type SpiffDescriptor, type Standing } from "@savvy/core";
import type { Tx } from "../tenant";
import { canvassSpiff } from "../schema/index";

export interface SpiffRow {
  id: string;
  challengeId: string | null;
  kind: string;
  amountCents: number;
  winnerRepId: string;
  fromRepId: string | null;
  status: string;
  note: string | null;
  createdAt: Date;
  settledAt: Date | null;
}

function toRow(r: typeof canvassSpiff.$inferSelect): SpiffRow {
  return {
    id: r.id, challengeId: r.challengeId, kind: r.kind, amountCents: r.amountCents,
    winnerRepId: r.winnerRepId, fromRepId: r.fromRepId, status: r.status,
    note: r.note, createdAt: r.createdAt, settledAt: r.settledAt,
  };
}

export interface ManualSpiffArgs {
  tenantId: string;
  winnerRepId: string;
  amountCents: number;
  note?: string;
}

// Manager awards a one-off spiff (kind manual, status owed).
export async function createManualSpiff(tx: Tx, a: ManualSpiffArgs): Promise<{ id: string }> {
  const [row] = await tx
    .insert(canvassSpiff)
    .values({
      tenantId: a.tenantId, kind: "manual", amountCents: Math.floor(a.amountCents),
      winnerRepId: a.winnerRepId, fromRepId: null, status: "owed", note: a.note ?? null,
    })
    .returning({ id: canvassSpiff.id });
  return { id: row!.id };
}

// scope "mine": rows where the rep is the winner OR the payer. scope "all": every row.
export async function listSpiffs(tx: Tx, tenantId: string, scope: "mine" | "all", repId?: string): Promise<SpiffRow[]> {
  const rows =
    scope === "mine" && repId
      ? await tx.select().from(canvassSpiff)
          .where(or(eq(canvassSpiff.winnerRepId, repId), eq(canvassSpiff.fromRepId, repId)))
          .orderBy(desc(canvassSpiff.createdAt))
      : await tx.select().from(canvassSpiff).orderBy(desc(canvassSpiff.createdAt));
  return rows.map(toRow);
}

// Flip owed → paid, stamp settled_at. Only affects an owed row (idempotent-ish:
// re-marking a paid row is a no-op). Returns whether a row changed.
export async function markSpiffPaid(tx: Tx, tenantId: string, spiffId: string, now: Date): Promise<boolean> {
  const rows = await tx
    .update(canvassSpiff)
    .set({ status: "paid", settledAt: now })
    .where(and(eq(canvassSpiff.id, spiffId), eq(canvassSpiff.status, "owed")))
    .returning({ id: canvassSpiff.id });
  return rows.length > 0;
}

// Called from settleDueChallenges the moment a challenge closes. Writes the
// wager/prize ledger rows derived from the final standings + winner.
export async function createSettlementSpiffs(
  tx: Tx,
  tenantId: string,
  challengeId: string,
  ch: { kind: string; meta: Record<string, unknown> },
  standings: Standing[],
  winnerRepId: string | null,
): Promise<number> {
  const descriptors: SpiffDescriptor[] = settlementSpiffs(ch, standings, winnerRepId);
  if (descriptors.length === 0) return 0;
  await tx.insert(canvassSpiff).values(
    descriptors.map((d) => ({
      tenantId, challengeId, kind: d.kind, amountCents: d.amountCents,
      winnerRepId: d.winnerRepId, fromRepId: d.fromRepId, status: "owed" as const,
    })),
  );
  return descriptors.length;
}
