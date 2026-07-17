import type { InputQuality, ValuationAdjustment } from "./valuation";
import type { ValueLever } from "./valuation-levers";

// Owner's Room slice 3 — it speaks, but is never needy. One digest line a
// month; threshold CARDS only when something actually moved; break-glass
// never (nothing here is urgent by definition).

export interface ValuationPulseSnapshot {
  periodKey: string;
  status: string;
  valueLowCents: number | null;
  valueLikelyCents: number | null;
  valueHighCents: number | null;
  adjustments: ValuationAdjustment[];
  inputQuality: { real: number; estimated: number; missing: number; flags: Record<string, InputQuality> } | null;
}

const LABEL: Record<string, string> = {
  owner_independence: "owner independence",
  customer_concentration: "customer concentration",
  insurance_dependence: "insurance dependence",
  maintenance_mrr: "maintenance MRR",
  clean_books: "clean books",
  ar_aging: "AR aging",
  data_gaps: "data gaps",
};

function usdM(cents: number): string {
  const m = cents / 100_000_000;
  return m >= 1 ? `$${m.toFixed(1)}M` : `$${Math.round(cents / 100_000)}K`;
}
function signedK(cents: number): string {
  return `${cents >= 0 ? "+" : "−"}${usdM(Math.abs(cents))}`;
}

/** The ledger key whose net delta changed most between snapshots (null if none). */
function biggestMover(current: ValuationPulseSnapshot, prior: ValuationPulseSnapshot | null): string | null {
  if (!prior) return null;
  const mid = (a: ValuationAdjustment) => (a.deltaLow + a.deltaHigh) / 2;
  const cur = new Map(current.adjustments.map((a) => [a.key, mid(a)]));
  const was = new Map(prior.adjustments.map((a) => [a.key, mid(a)]));
  let best: string | null = null;
  let bestAbs = 0;
  for (const key of new Set([...cur.keys(), ...was.keys()])) {
    const change = Math.abs((cur.get(key) ?? 0) - (was.get(key) ?? 0));
    if (change > bestAbs) { bestAbs = change; best = key; }
  }
  return bestAbs > 0 ? best : null;
}

/** Monthly digest section; silent when there is nothing honest to say. */
export function buildValuationLine(
  current: ValuationPulseSnapshot,
  prior: ValuationPulseSnapshot | null,
  levers: ValueLever[],
): string | null {
  if (current.status !== "ok" || current.valueLowCents == null || current.valueHighCents == null) return null;
  const parts = [`Value: ${usdM(current.valueLowCents)} – ${usdM(current.valueHighCents)}`];
  if (prior?.valueLikelyCents != null && current.valueLikelyCents != null) {
    parts.push(signedK(current.valueLikelyCents - prior.valueLikelyCents));
  }
  const mover = biggestMover(current, prior);
  if (mover) parts.push(`biggest mover: ${LABEL[mover] ?? mover}`);
  const lever = levers[0];
  if (lever) parts.push(`lever: ${lever.label} (${signedK(lever.impactLowCents)}–${signedK(lever.impactHighCents)} est.)`);
  return parts.join(" · ");
}

export interface ValuationCard {
  kind: "valuation_move" | "valuation_input_degraded";
  severity: "medium";
  title: string;
  detail: string;
  href: string;
}

/** Threshold cards from snapshot-to-snapshot movement — exceptions, not chatter. */
export function detectValuationCards(
  current: ValuationPulseSnapshot,
  prior: ValuationPulseSnapshot | null,
): ValuationCard[] {
  if (!prior) return [];
  const cards: ValuationCard[] = [];
  const cur = new Map(current.adjustments.map((a) => [a.key, a]));
  const was = new Map(prior.adjustments.map((a) => [a.key, a]));

  const deltaText = current.valueLikelyCents != null && prior.valueLikelyCents != null
    ? ` — value range moved ${signedK(current.valueLikelyCents - prior.valueLikelyCents)}`
    : "";

  for (const [key, adj] of was) {
    if (key === "data_gaps" || cur.has(key)) continue;
    // A penalty disappearing or premium lapsing: the ledger moved.
    cards.push({
      kind: "valuation_move", severity: "medium",
      title: `Valuation: ${LABEL[key] ?? key} ${adj.deltaHigh < 0 ? "resolved" : "lapsed"}`,
      detail: `${adj.rationale}${deltaText}`,
      href: "/money/owners-room",
    });
  }
  for (const [key, adj] of cur) {
    if (key === "data_gaps" || was.has(key)) continue;
    cards.push({
      kind: "valuation_move", severity: "medium",
      title: `Valuation: ${LABEL[key] ?? key} ${adj.deltaHigh < 0 ? "threshold crossed" : "earned"}`,
      detail: `${adj.rationale}${deltaText}`,
      href: "/money/owners-room",
    });
  }

  const curFlags = current.inputQuality?.flags ?? {};
  const wasFlags = prior.inputQuality?.flags ?? {};
  const degraded = Object.keys(curFlags).filter((k) => curFlags[k] === "missing" && wasFlags[k] && wasFlags[k] !== "missing");
  if (degraded.length > 0) {
    cards.push({
      kind: "valuation_input_degraded", severity: "medium",
      title: "Valuation input went dark",
      detail: `${degraded.join(", ")} degraded to unavailable — the range widened until it comes back`,
      href: "/money/owners-room#methodology",
    });
  }
  return cards;
}
