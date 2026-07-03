import { describe, it, expect } from "vitest";
import { recoverableDepreciationCents } from "./depreciation";

describe("recoverableDepreciationCents", () => {
  it("is RCV minus ACV — the holdback the carrier releases after completion", () => {
    expect(recoverableDepreciationCents({ rcvCents: 2_000_000, acvCents: 1_400_000 })).toBe(600_000);
  });

  it("is zero when there is no recoverable depreciation (RCV == ACV)", () => {
    expect(recoverableDepreciationCents({ rcvCents: 1_500_000, acvCents: 1_500_000 })).toBe(0);
  });

  it("never goes negative", () => {
    expect(recoverableDepreciationCents({ rcvCents: 1_000_000, acvCents: 1_200_000 })).toBe(0);
  });

  it("treats missing RCV/ACV as zero (no data → nothing to recover)", () => {
    expect(recoverableDepreciationCents({ rcvCents: null, acvCents: null })).toBe(0);
    expect(recoverableDepreciationCents({ rcvCents: 900_000, acvCents: null })).toBe(900_000);
  });
});
