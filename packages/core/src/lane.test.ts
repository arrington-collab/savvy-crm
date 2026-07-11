import { describe, it, expect } from "vitest";
import { deriveLane } from "./lane";
import { parseScoringConfig } from "./lead-scoring";
import type { LeadFeatures } from "./lead-features";

const cfg = parseScoringConfig({});
const f = (over: Partial<LeadFeatures> = {}): LeadFeatures => ({
  source: "web", state: "AZ", inTerritory: true, hasContact: true,
  roofType: null, roofTypeSecondary: null, yearBuilt: null, roofAgeYears: null,
  roofReplacementYear: null,
  storm: { eventCount: 0, maxHailInches: 0, maxWindMph: 0, daysSinceWorst: null }, ...over,
});

describe("deriveLane", () => {
  it("storm takes precedence over tile", () => {
    expect(deriveLane(f({ roofType: "tile", storm: { eventCount: 1, maxHailInches: 1.5, maxWindMph: 0, daysSinceWorst: 30 } }), cfg)).toBe("storm");
  });
  it("tile when a tile roof has no qualifying storm", () => {
    expect(deriveLane(f({ roofType: "tile" }), cfg)).toBe("tile");
  });
  it("standard otherwise", () => {
    expect(deriveLane(f({ roofType: "asphalt_shingle" }), cfg)).toBe("standard");
  });
});

describe("deriveLane — secondary roof type", () => {
  it("routes to tile when the SECONDARY roof type is tile", () => {
    expect(deriveLane(f({ roofType: "asphalt_shingle", roofTypeSecondary: "tile" }), cfg)).toBe("tile");
  });
  it("routes to tile when the PRIMARY is tile (unchanged)", () => {
    expect(deriveLane(f({ roofType: "tile" }), cfg)).toBe("tile");
  });
  it("is standard when neither roof type is tile and no storm", () => {
    expect(deriveLane(f({ roofType: "asphalt_shingle" }), cfg)).toBe("standard");
  });
});
