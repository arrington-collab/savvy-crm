// Estimate Experience slice 1: turn parsed supplier price lines into a proposed
// cost diff against the current price book. Pure — the caller loads the book
// and applies the result via applyPriceBookVersion (never in-place).

export interface DiffBookItem {
  key: string;
  name: string;
  unitPriceCents: number;
  unitCostCents: number;
  marginFloorBps?: number | null;
}

export interface ParsedPriceLine {
  /** Explicit price-book key (e.g. from a guard-matched invoice line). */
  key?: string | null;
  name: string;
  unitCostCents: number;
}

export interface PriceBookDiffChange {
  key: string;
  name: string;
  oldCostCents: number;
  newCostCents: number;
  deltaCents: number;
  unitPriceCents: number;
  /** Margin at the CURRENT retail price with the NEW cost. */
  newMarginBps: number;
  floorBps: number;
  underFloor: boolean;
}

function normalizeName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function marginBps(priceCents: number, costCents: number): number {
  if (priceCents <= 0) return 0;
  return Math.round(((priceCents - costCents) / priceCents) * 10_000);
}

export function proposePriceBookDiff(input: {
  parsedLines: ParsedPriceLine[];
  book: DiffBookItem[];
  defaultMarginFloorBps: number;
}): { changes: PriceBookDiffChange[]; unmatched: { name: string; unitCostCents: number }[] } {
  const byKey = new Map(input.book.map((b) => [b.key, b]));
  const byName = new Map(input.book.map((b) => [normalizeName(b.name), b]));

  const changes: PriceBookDiffChange[] = [];
  const unmatched: { name: string; unitCostCents: number }[] = [];

  for (const line of input.parsedLines) {
    const item = (line.key ? byKey.get(line.key) : undefined) ?? byName.get(normalizeName(line.name));
    if (!item) {
      unmatched.push({ name: line.name, unitCostCents: line.unitCostCents });
      continue;
    }
    if (line.unitCostCents === item.unitCostCents) continue; // no-op

    const floorBps = item.marginFloorBps ?? input.defaultMarginFloorBps;
    const newMarginBps = marginBps(item.unitPriceCents, line.unitCostCents);
    changes.push({
      key: item.key,
      name: item.name,
      oldCostCents: item.unitCostCents,
      newCostCents: line.unitCostCents,
      deltaCents: line.unitCostCents - item.unitCostCents,
      unitPriceCents: item.unitPriceCents,
      newMarginBps,
      floorBps,
      underFloor: newMarginBps < floorBps,
    });
  }

  return { changes, unmatched };
}
