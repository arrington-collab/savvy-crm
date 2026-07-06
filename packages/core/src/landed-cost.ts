// Cell 12 remainder (#337) — pure landed-cost model. The true cost of a material
// order isn't the unit price: it's units × price + delivery + surcharges, floored
// at the supplier's minimum order. Comparing landed cost across suppliers is where
// the margin hides (the QXO cheap-unit-but-big-delivery-fee case). All cents.

export type SupplierQuote = {
  supplierName: string;
  unitCostCents: number;
  quantity: number;
  deliveryCents?: number; // flat delivery/freight fee
  surchargeCents?: number; // fuel / small-order / other surcharges
  minimumOrderCents?: number; // the order is billed at least this much
};

/** Landed cost for one supplier quote: units + delivery + surcharges, floored at the minimum order. */
export function landedCostCents(q: SupplierQuote): number {
  const units = q.unitCostCents * q.quantity;
  const subtotal = units + (q.deliveryCents ?? 0) + (q.surchargeCents ?? 0);
  return Math.max(subtotal, q.minimumOrderCents ?? 0);
}

export interface LandedSelection {
  winner: SupplierQuote;
  landedCents: number;
  /** True when the win is decisive enough to place the PO unattended. */
  autoPick: boolean;
  ranked: { supplierName: string; landedCents: number }[];
}

/**
 * Picks the lowest landed-cost supplier and decides whether it's an auto-pick or
 * needs a human card. Auto-pick when there's only one quote, or the winner beats
 * the runner-up by MORE than `confidenceMarginPct` of the winner's landed cost —
 * a near-tie is too close to place blind. Returns null for no quotes.
 */
export function selectLandedWinner(quotes: SupplierQuote[], confidenceMarginPct = 0.05): LandedSelection | null {
  if (quotes.length === 0) return null;
  const ranked = quotes
    .map((q) => ({ q, landed: landedCostCents(q) }))
    .sort((a, b) => a.landed - b.landed);
  const best = ranked[0]!;
  const second = ranked[1];
  const autoPick = !second || second.landed - best.landed >= best.landed * confidenceMarginPct;
  return {
    winner: best.q,
    landedCents: best.landed,
    autoPick,
    ranked: ranked.map((r) => ({ supplierName: r.q.supplierName, landedCents: r.landed })),
  };
}
