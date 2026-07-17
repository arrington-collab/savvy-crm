import { describe, expect, it } from "vitest";
import { applyFillDiscount, type FillDiscountLine } from "./fill-discount";

function line(over: Partial<FillDiscountLine> = {}): FillDiscountLine {
  // 40% margin at list: price $100, cost $60.
  return { key: "shingles", quantity: 1, unitPriceCents: 10000, unitCostCents: 6000, ...over };
}

describe("applyFillDiscount", () => {
  it("applies the requested discount when every line clears the floor", () => {
    const r = applyFillDiscount({
      lines: [line()],
      requestedDiscountBps: 500, // 5% off → margin 36.8%, floor 20%
      defaultMarginFloorBps: 2000,
    });
    expect(r.discountBps).toBe(500);
    expect(r.clamped).toBe(false);
    expect(r.sendable).toBe(true);
    expect(r.originalTotalCents).toBe(10000);
    expect(r.discountedTotalCents).toBe(9500);
    expect(r.violations).toEqual([]);
  });

  it("SPEC RED PATH: floor check runs on DISCOUNTED totals — clamps a discount the list price would allow", () => {
    // price $100, cost $79: 21% margin at list (clears 20% floor),
    // but 5% off → margin 16.8% (breach). Max compliant discount:
    // p' >= c/(1-f) = 7900/0.8 = 9875 → d <= 125bps → clamp to 125.
    const r = applyFillDiscount({
      lines: [line({ unitCostCents: 7900 })],
      requestedDiscountBps: 500,
      defaultMarginFloorBps: 2000,
    });
    expect(r.clamped).toBe(true);
    expect(r.discountBps).toBe(125);
    expect(r.sendable).toBe(true);
    expect(r.discountedTotalCents).toBe(9875);
    expect(r.violations).toEqual([]);
  });

  it("a line under floor at list price is a violation and blocks send even at zero discount", () => {
    const r = applyFillDiscount({
      lines: [line(), line({ key: "underlayment", unitPriceCents: 1000, unitCostCents: 900 })],
      requestedDiscountBps: 500,
      defaultMarginFloorBps: 2000,
    });
    expect(r.discountBps).toBe(0);
    expect(r.sendable).toBe(false);
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0]).toMatchObject({ key: "underlayment", floorBps: 2000 });
  });

  it("respects per-item floor overrides", () => {
    // 10% margin line with a 5% custom floor: fine at list, clamps at 5%.
    // p' >= 900/0.95 = 947.4 → ceil 948 → maxD = 1 - 948/1000 = 520bps... clamp ≤ requested.
    const r = applyFillDiscount({
      lines: [line({ key: "underlayment", unitPriceCents: 1000, unitCostCents: 900, marginFloorBps: 500 })],
      requestedDiscountBps: 300,
      defaultMarginFloorBps: 2000,
    });
    expect(r.sendable).toBe(true);
    expect(r.discountBps).toBe(300);
  });

  it("unknown cost cannot verify the floor: flagged in needsCosts and not sendable", () => {
    const r = applyFillDiscount({
      lines: [line({ key: "vents", unitCostCents: null })],
      requestedDiscountBps: 500,
      defaultMarginFloorBps: 2000,
    });
    expect(r.needsCosts).toEqual(["vents:cost"]);
    expect(r.sendable).toBe(false);
  });

  it("totals multiply by quantity", () => {
    const r = applyFillDiscount({
      lines: [line({ quantity: 3 })],
      requestedDiscountBps: 1000,
      defaultMarginFloorBps: 2000,
    });
    expect(r.originalTotalCents).toBe(30000);
    expect(r.discountedTotalCents).toBe(27000);
  });
});
