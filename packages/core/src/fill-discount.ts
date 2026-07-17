import type { MarginFloorViolation } from "./tier-pricing";

// Phase 26 slice 5 — fill-play discount math. Spec: MARGIN FLOOR STILL
// RESPECTED — the floor check runs on discounted totals, so a discount the
// list price would allow can still be clamped or refused here.

export interface FillDiscountLine {
  key: string;
  quantity: number;
  unitPriceCents: number;
  /** null = owner hasn't filled costs — the floor can't be verified. */
  unitCostCents: number | null;
  marginFloorBps?: number;
}

export interface FillDiscountResult {
  /** Bps actually applied — clamped to the largest floor-compliant rate. */
  discountBps: number;
  clamped: boolean;
  originalTotalCents: number;
  discountedTotalCents: number;
  /** Lines under floor at LIST price. NEVER auto-sent — callers surface a card. */
  violations: MarginFloorViolation[];
  needsCosts: string[];
  /** False when any violation or unverifiable cost exists. */
  sendable: boolean;
}

export function applyFillDiscount(input: {
  lines: FillDiscountLine[];
  requestedDiscountBps: number;
  defaultMarginFloorBps: number;
}): FillDiscountResult {
  const violations: MarginFloorViolation[] = [];
  const needsCosts: string[] = [];
  let maxCompliantBps = input.requestedDiscountBps;

  for (const line of input.lines) {
    if (line.unitCostCents == null) {
      needsCosts.push(`${line.key}:cost`);
      continue;
    }
    const floorBps = line.marginFloorBps ?? input.defaultMarginFloorBps;
    // Smallest unit price that keeps margin >= floor: p >= c / (1 - f).
    const minPriceCents = Math.ceil((line.unitCostCents * 10_000) / (10_000 - floorBps));
    if (line.unitPriceCents < minPriceCents) {
      violations.push({
        key: line.key,
        unitPriceCents: line.unitPriceCents,
        unitCostCents: line.unitCostCents,
        marginBps: marginBps(line.unitPriceCents, line.unitCostCents),
        floorBps,
      });
      continue;
    }
    const lineMaxBps = Math.floor(((line.unitPriceCents - minPriceCents) * 10_000) / line.unitPriceCents);
    maxCompliantBps = Math.min(maxCompliantBps, lineMaxBps);
  }

  const discountBps = violations.length > 0 ? 0 : maxCompliantBps;
  let originalTotalCents = 0;
  let discountedTotalCents = 0;
  for (const line of input.lines) {
    originalTotalCents += line.unitPriceCents * line.quantity;
    // Ceil keeps the rounded price on the floor-compliant side.
    discountedTotalCents += Math.ceil((line.unitPriceCents * (10_000 - discountBps)) / 10_000) * line.quantity;
  }

  return {
    discountBps,
    clamped: violations.length === 0 && discountBps < input.requestedDiscountBps,
    originalTotalCents,
    discountedTotalCents,
    violations,
    needsCosts,
    sendable: violations.length === 0 && needsCosts.length === 0,
  };
}

function marginBps(priceCents: number, costCents: number): number {
  if (priceCents <= 0) return 0;
  return Math.round(((priceCents - costCents) / priceCents) * 10_000);
}
