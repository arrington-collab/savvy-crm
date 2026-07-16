import type { PartnerLedgerConfig } from "./partner-ledger";

// Partner Ledger slice 3 — value, grades, decision cards (spec:
// docs/superpowers/specs/prompts-partner-ledger.md). Grades produce CARDS,
// never automatic cutoffs: humans end relationships; the machine ranks them.

export type PartnerGrade = "A" | "B" | "C";

/**
 * A = proven producer (net over threshold AND at least one win).
 * C = proven cost (enough referrals to judge, zero wins in the window).
 * B = everyone else, including partners too new to judge.
 */
export function assignPartnerGrade(
  input: { netCents: number; wins: number; sent: number },
  cfg: PartnerLedgerConfig,
): PartnerGrade {
  if (input.wins >= 1 && input.netCents > cfg.gradeANetCentsMin) return "A";
  if (input.wins === 0 && input.sent >= cfg.gradeCMinReferrals) return "C";
  return "B";
}

export function funnelConversions(f: { sent: number; inspected: number; estimated: number; won: number }): {
  inspectedPct: number | null;
  estimatedPct: number | null;
  wonPct: number | null;
} {
  const pct = (n: number): number | null => (f.sent > 0 ? Math.round((n / f.sent) * 100) : null);
  return { inspectedPct: pct(f.inspected), estimatedPct: pct(f.estimated), wonPct: pct(f.won) };
}

/** Median of day counts; even length averages the middle pair. */
export function medianDays(days: number[]): number | null {
  if (days.length === 0) return null;
  const s = [...days].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
}

export type PartnerClassRollup = {
  class: string;
  partners: number;
  sent: number;
  won: number;
  collectedGmCents: number;
  cost12moCents: number;
  netCents: number;
};

/** Per-class sums, net-desc — makes the realtor-vs-insurance conversion gap visible data. */
export function rollupByClass(
  rows: Array<{ class: string; sent: number; won: number; collectedGmCents: number; cost12moCents: number; netCents: number }>,
): PartnerClassRollup[] {
  const byClass = new Map<string, PartnerClassRollup>();
  for (const r of rows) {
    const roll = byClass.get(r.class) ?? {
      class: r.class, partners: 0, sent: 0, won: 0, collectedGmCents: 0, cost12moCents: 0, netCents: 0,
    };
    roll.partners += 1;
    roll.sent += r.sent;
    roll.won += r.won;
    roll.collectedGmCents += r.collectedGmCents;
    roll.cost12moCents += r.cost12moCents;
    roll.netCents += r.netCents;
    byClass.set(r.class, roll);
  }
  return [...byClass.values()].sort((a, b) => b.netCents - a.netCents);
}
