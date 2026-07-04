import { describe, it, expect } from "vitest";
import { computeMtdGrossMargin } from "./money-margin";

describe("computeMtdGrossMargin", () => {
  it("computes GM% from revenue and cost across jobs with known cost", () => {
    const gm = computeMtdGrossMargin([
      { revenueCents: 100_000, costCents: 60_000 },
      { revenueCents: 100_000, costCents: 62_000 },
    ]);
    expect(gm).toBe(39); // (200000 - 122000) / 200000 = 39%
  });
  it("ignores jobs with unknown cost", () => {
    const gm = computeMtdGrossMargin([
      { revenueCents: 100_000, costCents: 60_000 },
      { revenueCents: 100_000, costCents: null },
    ]);
    expect(gm).toBe(40); // only the first job counts
  });
  it("returns null when no job has a known cost (render as —)", () => {
    expect(computeMtdGrossMargin([{ revenueCents: 100_000, costCents: null }])).toBeNull();
    expect(computeMtdGrossMargin([])).toBeNull();
  });
});
