import type { Standing } from "./canvass-challenge";

export const SPIFF_KINDS = ["wager", "contest_prize", "manual"] as const;
export type SpiffKind = (typeof SPIFF_KINDS)[number];

export const SPIFF_STATUSES = ["owed", "paid", "void"] as const;
export type SpiffStatus = (typeof SPIFF_STATUSES)[number];

export interface SpiffDescriptor {
  kind: SpiffKind;
  amountCents: number;
  winnerRepId: string;
  fromRepId: string | null;
}

interface SettledChallenge {
  kind: string;
  meta: Record<string, unknown>;
}

function posInt(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

// Given a just-settled challenge, its final standings, and the winner, derive
// the money-ledger rows to write. Pure — no DB, no side effects. Returns [] when
// there is no winner (tie) or no wager/prize configured.
export function settlementSpiffs(
  ch: SettledChallenge,
  standings: Standing[],
  winnerRepId: string | null,
): SpiffDescriptor[] {
  if (!winnerRepId) return [];

  if (ch.kind === "contest") {
    const pool = posInt(ch.meta.prizePoolCents);
    if (pool === 0) return [];
    return [{ kind: "contest_prize", amountCents: pool, winnerRepId, fromRepId: null }];
  }

  // h2h / koth wager: every non-winner owes the winner the wager amount.
  const wager = posInt(ch.meta.wagerCents);
  if (wager === 0) return [];
  return standings
    .filter((s) => s.repId !== winnerRepId)
    .map((s) => ({ kind: "wager" as const, amountCents: wager, winnerRepId, fromRepId: s.repId }));
}
