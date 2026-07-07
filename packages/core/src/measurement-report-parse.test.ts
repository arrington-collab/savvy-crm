import { describe, it, expect } from "vitest";
import { measurementReportParseSchema, MEASUREMENT_PARSE_MIN_CONFIDENCE } from "./measurement-report-parse";

describe("measurementReportParseSchema", () => {
  it("parses a full report with confidence and defaults missing areas to 0", () => {
    const out = measurementReportParseSchema.parse({
      squares: 24, predominantPitch: "8/12", eaveLf: 120, rakeLf: 60, confidence: 0.92,
    });
    expect(out.squares).toBe(24);
    expect(out.predominantPitch).toBe("8/12");
    expect(out.ridgeLf).toBe(0); // defaulted
    expect(out.confidence).toBeCloseTo(0.92);
  });

  it("rejects confidence outside 0-1", () => {
    expect(() => measurementReportParseSchema.parse({ confidence: 1.5 })).toThrow();
  });

  it("exposes a 0.8 minimum-confidence threshold", () => {
    expect(MEASUREMENT_PARSE_MIN_CONFIDENCE).toBe(0.8);
  });
});
