/** Pure price-guard helpers: line matching, overage detection, the auto-send confidence
 *  gate, and credit-memo reconciliation. All money is integer cents. */

export type SnapshotLine = { key: string; name: string; unitCostCents: number };
export type LineMatch = { matchedItemKey: string | null; expectedUnitCostCents: number | null; matchConfidence: number | null };

type ParsedLine = { description: string; sku?: string; unitBilledCents: number; quantity: number };

/** lowercase alphanumeric token set for fuzzy name matching. */
function tokens(s: string): Set<string> {
  return new Set(s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean));
}
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Match each parsed invoice line to a material-order snapshot line: exact sku==key (conf 1.0),
 *  else best normalized-name Jaccard ≥ 0.6 (conf = the overlap), else no-baseline (nulls). */
export function matchInvoiceLines(parsedLines: ParsedLine[], snapshot: SnapshotLine[]): LineMatch[] {
  const byKey = new Map(snapshot.map((s) => [s.key.toLowerCase(), s]));
  return parsedLines.map((line) => {
    if (line.sku) {
      const s = byKey.get(line.sku.toLowerCase());
      if (s) return { matchedItemKey: s.key, expectedUnitCostCents: s.unitCostCents, matchConfidence: 1 };
    }
    const lt = tokens(line.description);
    let best: SnapshotLine | null = null;
    let bestScore = 0;
    for (const s of snapshot) {
      const score = jaccard(lt, tokens(s.name));
      if (score > bestScore) { bestScore = score; best = s; }
    }
    if (best && bestScore >= 0.6) {
      return { matchedItemKey: best.key, expectedUnitCostCents: best.unitCostCents, matchConfidence: Number(bestScore.toFixed(2)) };
    }
    return { matchedItemKey: null, expectedUnitCostCents: null, matchConfidence: null };
  });
}

/** Per-line overage vs expected supplier cost; qualifies only when it clears max($floor, pct×expected line). */
export function computeLineOverage(
  line: { unitBilledCents: number; quantity: number; expectedUnitCostCents: number | null },
  cfg: { minOverageCents: number; overagePct: number },
): { overageCents: number; qualifies: boolean } {
  if (line.expectedUnitCostCents == null) return { overageCents: 0, qualifies: false };
  const overageCents = Math.max(0, (line.unitBilledCents - line.expectedUnitCostCents) * line.quantity);
  const expectedLineCents = line.expectedUnitCostCents * line.quantity;
  const threshold = Math.max(cfg.minOverageCents, Math.round(expectedLineCents * cfg.overagePct));
  return { overageCents, qualifies: overageCents >= threshold };
}

/** The confidence gate: only unattended-send a large, high-confidence, cleanly-matched claim. */
export function shouldAutoSendCredit(input: {
  claimedCents: number; parseConfidence: number | null; allOverageLinesMatched: boolean;
  cfg: { autoSendMinCents: number; highConfidence: number };
}): boolean {
  return input.claimedCents >= input.cfg.autoSendMinCents
    && (input.parseConfidence ?? 0) >= input.cfg.highConfidence
    && input.allOverageLinesMatched;
}

/** Reconcile a credit memo (abs total) to exactly one open sent request by supplier + near-equal amount. */
export function matchCreditMemo(
  memo: { supplierName: string | null; amountCents: number },
  open: { id: string; supplierName: string | null; claimedCents: number }[],
): string | null {
  const norm = (s: string | null) => (s ?? "").trim().toLowerCase();
  const hits = open.filter((r) =>
    norm(r.supplierName) === norm(memo.supplierName) &&
    Math.abs(r.claimedCents - memo.amountCents) <= Math.max(500, Math.round(r.claimedCents * 0.1)));
  return hits.length === 1 ? hits[0]!.id : null;
}
