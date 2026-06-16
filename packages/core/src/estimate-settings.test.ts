import { describe, it, expect } from "vitest";
import { parseEstimateConfig } from "./estimate-settings";

describe("parseEstimateConfig", () => {
  it("fills defaults", () => {
    const c = parseEstimateConfig(undefined);
    expect(c.taxRateBps).toBe(0);
    expect(c.defaultWastePct).toBe(1200); // 12%
    expect(c.steepPitchTiers.length).toBe(4);
    expect(c.steepPitchTiers[0]).toEqual({ minRise: 0, maxRise: 6, laborSurchargePct: 0, wasteBumpPct: 0 });
    expect(c.steepPitchTiers[3]).toEqual({ minRise: 13, maxRise: null, laborSurchargePct: 5000, wasteBumpPct: 0 });
  });
  it("merges partial overrides", () => {
    const c = parseEstimateConfig({ taxRateBps: 830, defaultWastePct: 1000 });
    expect(c.taxRateBps).toBe(830);
    expect(c.defaultWastePct).toBe(1000);
    expect(c.steepPitchTiers.length).toBe(4); // default tiers still applied
  });
});
