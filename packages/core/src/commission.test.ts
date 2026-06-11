import { describe, it, expect } from "vitest";
import { computeCommission } from "./commission";

describe("computeCommission", () => {
  it("flat: rate × basis", () => {
    expect(computeCommission({ model: "flat", basisCents: 100000, rate: 1000, priorPeriodTotalCents: 0 }))
      .toEqual({ amountCents: 10000, appliedRate: 1000 });
  });

  it("profit: caller passes profit as basis", () => {
    expect(computeCommission({ model: "profit", basisCents: 80000, rate: 1500, priorPeriodTotalCents: 0 }))
      .toEqual({ amountCents: 12000, appliedRate: 1500 });
  });

  it("tiered: picks the tier the prior-period total has reached", () => {
    const tiers = [{ thresholdCents: 5000000, rate: 1200 }];
    expect(computeCommission({ model: "tiered", basisCents: 100000, rate: 800, tiers, priorPeriodTotalCents: 0 }).appliedRate).toBe(800);
    expect(computeCommission({ model: "tiered", basisCents: 100000, rate: 800, tiers, priorPeriodTotalCents: 5000000 }).appliedRate).toBe(1200);
  });

  it("tiered: selects the highest REACHED tier among multiple tiers", () => {
    const tiers = [
      { thresholdCents: 1_000_000, rate: 1000 },
      { thresholdCents: 5_000_000, rate: 1500 },
    ];
    expect(computeCommission({ model: "tiered", basisCents: 100000, rate: 800, tiers, priorPeriodTotalCents: 0 }).appliedRate).toBe(800);
    expect(computeCommission({ model: "tiered", basisCents: 100000, rate: 800, tiers, priorPeriodTotalCents: 2_000_000 }).appliedRate).toBe(1000);
    expect(computeCommission({ model: "tiered", basisCents: 100000, rate: 800, tiers, priorPeriodTotalCents: 6_000_000 }).appliedRate).toBe(1500);
    expect(computeCommission({ model: "tiered", basisCents: 100000, rate: 800, tiers, priorPeriodTotalCents: 5_000_000 }).appliedRate).toBe(1500); // exact boundary
  });

  it("tiered: falls back to base rate when tiers missing or empty", () => {
    expect(computeCommission({ model: "tiered", basisCents: 100000, rate: 800, priorPeriodTotalCents: 9_999_999 }).appliedRate).toBe(800);
    expect(computeCommission({ model: "tiered", basisCents: 100000, rate: 800, tiers: [], priorPeriodTotalCents: 9_999_999 }).appliedRate).toBe(800);
  });

  it("rounds half-up to whole cents", () => {
    expect(computeCommission({ model: "flat", basisCents: 12345, rate: 1000, priorPeriodTotalCents: 0 }).amountCents).toBe(1235);
  });

  it("never returns negative (clamps basis at 0)", () => {
    expect(computeCommission({ model: "profit", basisCents: -5000, rate: 1000, priorPeriodTotalCents: 0 }).amountCents).toBe(0);
  });
});
