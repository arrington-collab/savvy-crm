import { describe, it, expect } from "vitest";
import { measurementAreasSchema, parsePitch, pitchTier } from "./measurement";
import { parseEstimateConfig } from "./estimate-settings";

const TIERS = parseEstimateConfig(undefined).steepPitchTiers;

describe("measurement", () => {
  it("parses areas with defaults for missing numeric fields", () => {
    const a = measurementAreasSchema.parse({ squares: 24.5, predominantPitch: "8/12", eaveLf: 120 });
    expect(a.squares).toBe(24.5);
    expect(a.ridgeLf).toBe(0); // default
    expect(a.predominantPitch).toBe("8/12");
  });
  it("parsePitch reads the rise", () => {
    expect(parsePitch("8/12")).toBe(8);
    expect(parsePitch("12/12")).toBe(12);
    expect(parsePitch("flat")).toBe(0);
  });
  it("pitchTier selects by rise", () => {
    expect(pitchTier(4, TIERS).laborSurchargePct).toBe(0);
    expect(pitchTier(8, TIERS).laborSurchargePct).toBe(2000);
    expect(pitchTier(11, TIERS).laborSurchargePct).toBe(3500);
    expect(pitchTier(16, TIERS).laborSurchargePct).toBe(5000); // maxRise null = catch-all
  });
});
