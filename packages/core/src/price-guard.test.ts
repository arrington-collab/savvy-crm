import { describe, it, expect } from "vitest";
import { matchInvoiceLines, computeLineOverage, shouldAutoSendCredit, matchCreditMemo } from "./price-guard";

const snap = [
  { key: "shingle-hdz", name: "GAF Timberline HDZ", unitCostCents: 7000 },
  { key: "pipe-boot", name: "Pipe Boot 3in", unitCostCents: 900 },
];

describe("matchInvoiceLines", () => {
  it("matches by sku==key with full confidence and carries expected cost", () => {
    const [m] = matchInvoiceLines([{ description: "x", sku: "shingle-hdz", unitBilledCents: 8000, quantity: 30 }], snap);
    expect(m).toEqual({ matchedItemKey: "shingle-hdz", expectedUnitCostCents: 7000, matchConfidence: 1 });
  });
  it("falls back to normalized-description match with partial confidence", () => {
    const [m] = matchInvoiceLines([{ description: "GAF TIMBERLINE HDZ shingle", unitBilledCents: 8000, quantity: 30 }], snap);
    expect(m!.matchedItemKey).toBe("shingle-hdz");
    expect(m!.matchConfidence).toBeGreaterThan(0.5);
    expect(m!.matchConfidence).toBeLessThan(1);
  });
  it("returns no-baseline (null) when nothing matches", () => {
    const [m] = matchInvoiceLines([{ description: "mystery flashing", unitBilledCents: 500, quantity: 1 }], snap);
    expect(m).toEqual({ matchedItemKey: null, expectedUnitCostCents: null, matchConfidence: null });
  });
});

describe("computeLineOverage", () => {
  const cfg = { minOverageCents: 2500, overagePct: 0.05 };
  it("flags a qualifying overage above max($25, 5% of expected line)", () => {
    // billed 8000 vs expected 7000, qty 30 → overage 30000; threshold max(2500, 5%*210000=10500)=10500
    expect(computeLineOverage({ unitBilledCents: 8000, quantity: 30, expectedUnitCostCents: 7000 }, cfg))
      .toEqual({ overageCents: 30000, qualifies: true });
  });
  it("does not flag a trivial overage below the threshold", () => {
    // billed 7010 vs 7000, qty 1 → overage 10; threshold max(2500, 350)=2500
    expect(computeLineOverage({ unitBilledCents: 7010, quantity: 1, expectedUnitCostCents: 7000 }, cfg))
      .toEqual({ overageCents: 10, qualifies: false });
  });
  it("is a no-op (no baseline) when expected cost is unknown", () => {
    expect(computeLineOverage({ unitBilledCents: 9999, quantity: 5, expectedUnitCostCents: null }, cfg))
      .toEqual({ overageCents: 0, qualifies: false });
  });
});

describe("shouldAutoSendCredit", () => {
  const cfg = { autoSendMinCents: 2500, highConfidence: 0.8 };
  it("auto-sends when claim clears the floor, parse is confident, and all overage lines matched", () => {
    expect(shouldAutoSendCredit({ claimedCents: 30000, parseConfidence: 0.92, allOverageLinesMatched: true, cfg })).toBe(true);
  });
  it("holds for review when parse confidence is low", () => {
    expect(shouldAutoSendCredit({ claimedCents: 30000, parseConfidence: 0.6, allOverageLinesMatched: true, cfg })).toBe(false);
  });
  it("holds for review when an overage line did not match cleanly", () => {
    expect(shouldAutoSendCredit({ claimedCents: 30000, parseConfidence: 0.92, allOverageLinesMatched: false, cfg })).toBe(false);
  });
  it("holds for a trivial claim below the floor", () => {
    expect(shouldAutoSendCredit({ claimedCents: 100, parseConfidence: 0.99, allOverageLinesMatched: true, cfg })).toBe(false);
  });
});

describe("matchCreditMemo", () => {
  const open = [{ id: "cr1", supplierName: "ABC Supply", claimedCents: 30000 }];
  it("matches one open request by supplier + near-equal amount", () => {
    expect(matchCreditMemo({ supplierName: "abc supply", amountCents: 30000 }, open)).toBe("cr1");
  });
  it("returns null when amount is off or supplier differs", () => {
    expect(matchCreditMemo({ supplierName: "ABC Supply", amountCents: 5000 }, open)).toBeNull();
    expect(matchCreditMemo({ supplierName: "SRS", amountCents: 30000 }, open)).toBeNull();
  });
});
