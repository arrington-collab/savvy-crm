import { describe, it, expect } from "vitest";
import { proposePriceBookDiff, type DiffBookItem } from "./price-book-diff";

const book: DiffBookItem[] = [
  { key: "field-shingles", name: "Field shingles", unitPriceCents: 12000, unitCostCents: 7800 },
  { key: "drip-edge", name: "Drip edge", unitPriceCents: 150, unitCostCents: 100 },
  { key: "underlayment", name: "Underlayment", unitPriceCents: 1500, unitCostCents: 975, marginFloorBps: 500 },
];

describe("proposePriceBookDiff", () => {
  it("matches by explicit key and reports old vs new cost with margin impact", () => {
    const out = proposePriceBookDiff({
      parsedLines: [{ key: "field-shingles", name: "whatever", unitCostCents: 9100 }],
      book,
      defaultMarginFloorBps: 2000,
    });
    expect(out.changes).toHaveLength(1);
    const c = out.changes[0]!;
    expect(c.key).toBe("field-shingles");
    expect(c.oldCostCents).toBe(7800);
    expect(c.newCostCents).toBe(9100);
    expect(c.deltaCents).toBe(1300);
    // margin at the CURRENT price with the NEW cost: (12000-9100)/12000 ≈ 24.17%
    expect(c.newMarginBps).toBe(2417);
    expect(c.underFloor).toBe(false);
  });

  it("matches by normalized name when no key is given", () => {
    const out = proposePriceBookDiff({
      parsedLines: [{ name: "  DRIP-EDGE!! ", unitCostCents: 120 }],
      book,
      defaultMarginFloorBps: 2000,
    });
    expect(out.changes[0]!.key).toBe("drip-edge");
    expect(out.changes[0]!.newCostCents).toBe(120);
  });

  it("flags under-floor changes using the item override when present", () => {
    const out = proposePriceBookDiff({
      parsedLines: [
        // drip-edge: new cost 130 → margin (150-130)/150 ≈ 13.3% < default 20% floor
        { key: "drip-edge", name: "Drip edge", unitCostCents: 130 },
        // underlayment: new cost 1450 → margin ≈ 3.3% < its 5% override floor
        { key: "underlayment", name: "Underlayment", unitCostCents: 1450 },
      ],
      book,
      defaultMarginFloorBps: 2000,
    });
    const drip = out.changes.find((c) => c.key === "drip-edge")!;
    const under = out.changes.find((c) => c.key === "underlayment")!;
    expect(drip.underFloor).toBe(true);
    expect(drip.floorBps).toBe(2000);
    expect(under.underFloor).toBe(true);
    expect(under.floorBps).toBe(500);
  });

  it("lists unmatched lines instead of guessing, and drops no-op costs", () => {
    const out = proposePriceBookDiff({
      parsedLines: [
        { name: "Mystery fastener 9000", unitCostCents: 400 },
        { key: "field-shingles", name: "Field shingles", unitCostCents: 7800 }, // unchanged
      ],
      book,
      defaultMarginFloorBps: 2000,
    });
    expect(out.changes).toHaveLength(0);
    expect(out.unmatched).toEqual([{ name: "Mystery fastener 9000", unitCostCents: 400 }]);
  });
});
