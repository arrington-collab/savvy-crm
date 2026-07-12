import type { BallparkConfig } from "./config";
import type { RoofSizeBasis } from "./size";

const BASIS_RANK: Record<RoofSizeBasis, number> = { measured: 3, assessor: 2, footprint: 1 };
const CONFIDENCE: Record<RoofSizeBasis, "high" | "medium" | "low"> = { measured: "high", assessor: "medium", footprint: "low" };
const BASIS_LABEL: Record<RoofSizeBasis, string> = { measured: "measured roof", assessor: "assessor sq ft", footprint: "footprint estimate" };

/** Per-square installed sell + cost from the tenant's price book (unit === "square"). */
export function perSquareFromPriceBook(
  items: { unit: string; unitPriceCents: number; unitCostCents: number }[],
): { sellCents: number; costCents: number } {
  let sellCents = 0;
  let costCents = 0;
  for (const it of items) {
    if (it.unit !== "square") continue;
    sellCents += it.unitPriceCents;
    costCents += it.unitCostCents;
  }
  return { sellCents, costCents };
}

const dollars = (cents: number) => `$${Math.round(cents / 100).toLocaleString("en-US")}`;

/** The mandated spoken/sent framing — always a range, always subject to inspection. */
export function subjectToInspectionLine(lowCents: number, highCents: number): string {
  return `typically runs ${dollars(lowCents)}–${dollars(highCents)} — the exact number comes from a free inspection`;
}

/**
 * A conservative price *range* from roof size × per-square price-book economics.
 * Returns null (never a guess) when the feature is off, the intent is an
 * insurance claim, there is no size, or the size basis is below the tenant's
 * confidence floor. The low end never drops below the price-book margin floor.
 */
export function ballparkRange(input: {
  size: { squares: number; basis: RoofSizeBasis } | null;
  sell: { sellCents: number; costCents: number }; // per-square, from perSquareFromPriceBook
  config: BallparkConfig;
  isClaim: boolean;
}): { lowCents: number; highCents: number; confidence: "high" | "medium" | "low"; basis: string } | null {
  const { size, config, isClaim } = input;
  if (!config.enabled || isClaim || !size) return null;
  if (BASIS_RANK[size.basis] < BASIS_RANK[config.confidenceFloor]) return null;

  const sellPerSq = input.sell.sellCents;
  const costPerSq = input.sell.costCents;

  const good = size.squares * sellPerSq;
  const better = good * (config.betterMultiplierBps / 10000);
  const spread = config.spreadBps / 10000;
  const lowRaw = Math.round(good * (1 - spread));
  const high = Math.round(better * (1 + spread));
  const marginFloor = Math.round(size.squares * costPerSq * (1 + config.marginFloorBps / 10000));
  const low = Math.max(lowRaw, marginFloor);

  return { lowCents: low, highCents: high, confidence: CONFIDENCE[size.basis], basis: BASIS_LABEL[size.basis] };
}
