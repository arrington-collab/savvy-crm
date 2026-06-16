import { describe, it, expect } from "vitest";
import { computeEstimateTotals } from "./estimate";

describe("computeEstimateTotals", () => {
  it("sums line amounts and applies tax in bps", () => {
    const items = [{ amountCents: 100000 }, { amountCents: 52050 }];
    expect(computeEstimateTotals(items, 830)).toEqual({
      subtotalCents: 152050, taxCents: 12620, totalCents: 164670, // 152050 * 0.083 = 12620.15 -> 12620
    });
  });
  it("zero tax", () => {
    expect(computeEstimateTotals([{ amountCents: 5000 }], 0)).toEqual({ subtotalCents: 5000, taxCents: 0, totalCents: 5000 });
  });
});
