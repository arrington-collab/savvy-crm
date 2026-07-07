import { describe, it, expect } from "vitest";
import { insuranceEstimateParseSchema, INSURANCE_PARSE_MIN_CONFIDENCE } from "./insurance-estimate-parse";

describe("insuranceEstimateParseSchema", () => {
  it("parses a carrier estimate with money in cents and line items", () => {
    const out = insuranceEstimateParseSchema.parse({
      carrierName: "State Farm", claimNumber: "12-3456", acvCents: 800000, rcvCents: 1000000, deductibleCents: 200000,
      lines: [{ description: "Remove & replace shingles", quantity: 25, unit: "SQ", unitPriceCents: 30000, amountCents: 750000 }],
      confidence: 0.93,
    });
    expect(out.carrierName).toBe("State Farm");
    expect(out.rcvCents).toBe(1000000);
    expect(out.lines[0]!.amountCents).toBe(750000);
  });

  it("allows null money fields and an empty line list", () => {
    const out = insuranceEstimateParseSchema.parse({
      carrierName: null, claimNumber: null, acvCents: null, rcvCents: null, deductibleCents: null, lines: [], confidence: 0.5,
    });
    expect(out.acvCents).toBeNull();
    expect(out.lines).toEqual([]);
  });

  it("rejects confidence outside 0-1 and exposes a 0.8 threshold", () => {
    expect(() => insuranceEstimateParseSchema.parse({ carrierName: null, claimNumber: null, acvCents: null, rcvCents: null, deductibleCents: null, lines: [], confidence: 2 })).toThrow();
    expect(INSURANCE_PARSE_MIN_CONFIDENCE).toBe(0.8);
  });
});
