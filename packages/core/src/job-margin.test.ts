import { describe, it, expect } from "vitest";
import { computeJobMargin } from "./job-margin";

describe("computeJobMargin", () => {
  it("computes margin and percent from revenue and cost", () => {
    expect(computeJobMargin({ revenueCents: 1_000_000, costCents: 400_000 })).toEqual({
      revenueCents: 1_000_000,
      costCents: 400_000,
      marginCents: 600_000,
      marginPct: 60,
      costKnown: true,
    });
  });

  it("treats a null cost as 0 but flags costKnown=false", () => {
    const r = computeJobMargin({ revenueCents: 1_000_000, costCents: null });
    expect(r.marginCents).toBe(1_000_000);
    expect(r.marginPct).toBe(100);
    expect(r.costKnown).toBe(false);
  });

  it("returns null percent when revenue is 0 or null (no basis)", () => {
    expect(computeJobMargin({ revenueCents: 0, costCents: 0 }).marginPct).toBeNull();
    expect(computeJobMargin({ revenueCents: null, costCents: 5000 }).marginPct).toBeNull();
    expect(computeJobMargin({ revenueCents: null, costCents: 5000 }).marginCents).toBe(-5000);
  });

  it("rounds the percent to a whole number and allows negative margin", () => {
    const r = computeJobMargin({ revenueCents: 300, costCents: 200 }); // 33.33%
    expect(r.marginPct).toBe(33);
    const neg = computeJobMargin({ revenueCents: 1000, costCents: 1500 });
    expect(neg.marginCents).toBe(-500);
    expect(neg.marginPct).toBe(-50);
  });
});
