import { describe, expect, it } from "vitest";
import { FINANCING_STATUS, shouldOfferFinancing, mapFinancingStatus } from "./financing";

describe("shouldOfferFinancing", () => {
  it("offers on a retail estimate at or above the floor", () => {
    expect(shouldOfferFinancing({ jobType: "retail", amountCents: 20_000_00 }, 15_000_00)).toBe(true);
    expect(shouldOfferFinancing({ jobType: "retail", amountCents: 15_000_00 }, 15_000_00)).toBe(true);
  });

  it("does not offer below the floor", () => {
    expect(shouldOfferFinancing({ jobType: "retail", amountCents: 9_999_00 }, 15_000_00)).toBe(false);
  });

  it("only offers on retail jobs (never insurance/repair/commercial)", () => {
    expect(shouldOfferFinancing({ jobType: "insurance", amountCents: 99_999_00 }, 100)).toBe(false);
    expect(shouldOfferFinancing({ jobType: "repair", amountCents: 99_999_00 }, 100)).toBe(false);
  });

  it("treats a zero/unset floor as financing-disabled (no offer)", () => {
    expect(shouldOfferFinancing({ jobType: "retail", amountCents: 50_000_00 }, 0)).toBe(false);
  });

  it("handles a null amount safely", () => {
    expect(shouldOfferFinancing({ jobType: "retail", amountCents: null }, 15_000_00)).toBe(false);
  });
});

describe("mapFinancingStatus (no credit data — status only)", () => {
  it("maps provider synonyms to the neutral enum", () => {
    expect(mapFinancingStatus("accepted")).toBe("approved");
    expect(mapFinancingStatus("DENIED")).toBe("declined");
    expect(mapFinancingStatus("disbursed")).toBe("funded");
    expect(mapFinancingStatus("submitted")).toBe("applied");
    expect(mapFinancingStatus("offer")).toBe("offered");
  });

  it("falls back to 'none' for unknown/blank status", () => {
    expect(mapFinancingStatus("weird")).toBe("none");
    expect(mapFinancingStatus(null)).toBe("none");
    expect(FINANCING_STATUS).toContain("none");
  });
});
