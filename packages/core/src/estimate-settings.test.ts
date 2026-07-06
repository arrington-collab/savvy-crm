import { describe, it, expect } from "vitest";
import { parseEstimateConfig, estimateRequiresApproval } from "./estimate-settings";

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
  it("defaults approvalThresholdCents to null (no gating)", () => {
    expect(parseEstimateConfig(undefined).approvalThresholdCents).toBeNull();
  });
});

describe("estimateRequiresApproval", () => {
  it("never requires approval when no threshold is set", () => {
    const cfg = parseEstimateConfig(undefined);
    expect(estimateRequiresApproval(9_999_999, cfg)).toBe(false);
  });
  it("requires approval only when the total exceeds the threshold", () => {
    const cfg = parseEstimateConfig({ approvalThresholdCents: 1_000_000 });
    expect(estimateRequiresApproval(1_000_001, cfg)).toBe(true);
    expect(estimateRequiresApproval(1_000_000, cfg)).toBe(false); // at threshold → auto-send
    expect(estimateRequiresApproval(500_000, cfg)).toBe(false);
  });
});
