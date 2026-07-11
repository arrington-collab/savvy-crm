import { describe, it, expect } from "vitest";
import { deriveInstallRecommendation } from "./install-recommendation";
import type { LeadFeatures } from "./lead-features";

const f = (over: Partial<LeadFeatures> = {}): LeadFeatures => ({
  source: "web", state: "AZ", inTerritory: true, hasContact: true,
  roofType: null, roofTypeSecondary: null, yearBuilt: null, roofAgeYears: null,
  roofReplacementYear: null,
  storm: { eventCount: 0, maxHailInches: 0, maxWindMph: 0, daysSinceWorst: null }, ...over,
});

describe("deriveInstallRecommendation", () => {
  it("recommends high-wind install for strong wind", () => {
    const r = deriveInstallRecommendation(f({ storm: { eventCount: 1, maxHailInches: 0, maxWindMph: 115, daysSinceWorst: 3 } }));
    expect(r.windRating).toBe("high");
    expect(r.suggestedProducts.join(" ")).toMatch(/high-wind|6-nail/i);
  });
  it("recommends Class 4 for hail >= 1 inch", () => {
    const r = deriveInstallRecommendation(f({ storm: { eventCount: 1, maxHailInches: 1.25, maxWindMph: 0, daysSinceWorst: 3 } }));
    expect(r.impactResistance).toBe("class4");
    expect(r.suggestedProducts.join(" ")).toMatch(/class 4/i);
  });
  it("returns standard with no products when no storm", () => {
    const r = deriveInstallRecommendation(f());
    expect(r.windRating).toBe("standard");
    expect(r.impactResistance).toBe("standard");
    expect(r.suggestedProducts).toEqual([]);
  });
  it("notes replacement framing for old roof + storm", () => {
    const r = deriveInstallRecommendation(f({ roofAgeYears: 22, storm: { eventCount: 1, maxHailInches: 1.5, maxWindMph: 0, daysSinceWorst: 3 } }));
    expect(r.rationale.toLowerCase()).toContain("replace");
  });
});
