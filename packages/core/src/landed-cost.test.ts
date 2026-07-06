import { describe, expect, it } from "vitest";
import { landedCostCents, selectLandedWinner, type SupplierQuote } from "./landed-cost";

const q = (over: Partial<SupplierQuote> & { supplierName: string; unitCostCents: number; quantity: number }): SupplierQuote => ({
  deliveryCents: 0,
  surchargeCents: 0,
  minimumOrderCents: 0,
  ...over,
});

describe("landedCostCents (units × price + delivery + surcharges + minimum floor)", () => {
  it("sums units, delivery and surcharges", () => {
    // 30 sq × 7000 = 210000 + 5000 delivery + 1500 surcharge = 216500
    expect(landedCostCents(q({ supplierName: "ABC", unitCostCents: 7000, quantity: 30, deliveryCents: 5000, surchargeCents: 1500 }))).toBe(216_500);
  });

  it("floors the order at the supplier minimum when the subtotal is below it", () => {
    // 1 × 5000 = 5000 subtotal, but minimum order is 25000 → pay 25000
    expect(landedCostCents(q({ supplierName: "ABC", unitCostCents: 5000, quantity: 1, minimumOrderCents: 25_000 }))).toBe(25_000);
  });

  it("ignores the minimum when the subtotal already clears it", () => {
    expect(landedCostCents(q({ supplierName: "ABC", unitCostCents: 7000, quantity: 30, minimumOrderCents: 25_000 }))).toBe(210_000);
  });
});

describe("selectLandedWinner (auto-pick above the confidence margin, else card)", () => {
  it("returns null for no quotes", () => {
    expect(selectLandedWinner([])).toBeNull();
  });

  it("picks the lowest landed cost and ranks all suppliers", () => {
    // QXO cheap unit but big delivery fee vs ABC pricier unit no delivery — the classic case.
    const quotes = [
      q({ supplierName: "QXO", unitCostCents: 6500, quantity: 30, deliveryCents: 40_000 }), // 195000+40000 = 235000
      q({ supplierName: "ABC", unitCostCents: 7000, quantity: 30, deliveryCents: 0 }),       // 210000
    ];
    const r = selectLandedWinner(quotes)!;
    expect(r.winner.supplierName).toBe("ABC");
    expect(r.landedCents).toBe(210_000);
    expect(r.ranked.map((x) => x.supplierName)).toEqual(["ABC", "QXO"]);
  });

  it("auto-picks when the winner beats the runner-up by more than the margin", () => {
    const quotes = [
      q({ supplierName: "A", unitCostCents: 6000, quantity: 30 }), // 180000
      q({ supplierName: "B", unitCostCents: 7000, quantity: 30 }), // 210000 — 16.7% costlier
    ];
    const r = selectLandedWinner(quotes, 0.05)!;
    expect(r.winner.supplierName).toBe("A");
    expect(r.autoPick).toBe(true);
  });

  it("requires a human card when the top two are within the margin (too close to auto-pick)", () => {
    const quotes = [
      q({ supplierName: "A", unitCostCents: 7000, quantity: 30 }),  // 210000
      q({ supplierName: "B", unitCostCents: 7050, quantity: 30 }),  // 211500 — 0.7% costlier < 5%
    ];
    const r = selectLandedWinner(quotes, 0.05)!;
    expect(r.autoPick).toBe(false);
  });

  it("auto-picks a lone quote (nothing to compare against)", () => {
    const r = selectLandedWinner([q({ supplierName: "Solo", unitCostCents: 7000, quantity: 30 })])!;
    expect(r.autoPick).toBe(true);
  });
});
