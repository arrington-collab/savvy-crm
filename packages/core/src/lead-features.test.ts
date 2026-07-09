import { describe, it, expect } from "vitest";
import { buildLeadFeatures } from "./lead-features";

const storm = { eventCount: 1, maxHailInches: 1.5, maxWindMph: 0, daysSinceWorst: 30 };

describe("buildLeadFeatures", () => {
  it("computes roof age from year built", () => {
    const f = buildLeadFeatures({ source: "referral", state: "AZ", phone: "+14805551234",
      roofType: "tile", yearBuilt: 2004, storm });
    expect(f.roofAgeYears).toBe(new Date().getFullYear() - 2004);
    expect(f.inTerritory).toBe(true);
    expect(f.hasContact).toBe(true);
    expect(f.storm.maxHailInches).toBe(1.5);
  });
  it("handles missing year/state/contact", () => {
    const f = buildLeadFeatures({ source: "web", state: null, phone: "",
      roofType: null, yearBuilt: null, storm });
    expect(f.roofAgeYears).toBeNull();
    expect(f.inTerritory).toBe(false);
    expect(f.hasContact).toBe(false);
  });
});

describe("buildLeadFeatures — effective roof age", () => {
  it("uses the replacement date over year_built when present", () => {
    const f = buildLeadFeatures({
      source: "web", state: "AZ", roofType: "tile", roofTypeSecondary: null,
      yearBuilt: 1990, lastRoofReplacementAt: "2015-06-01",
      storm: { eventCount: 0, maxHailInches: 0, maxWindMph: 0, daysSinceWorst: null },
    });
    expect(f.roofAgeYears).toBe(new Date().getFullYear() - 2015);
  });
  it("carries roofTypeSecondary through", () => {
    const f = buildLeadFeatures({
      source: "web", state: "AZ", roofType: "tile", roofTypeSecondary: "flat_foam",
      yearBuilt: 1990, lastRoofReplacementAt: null,
      storm: { eventCount: 0, maxHailInches: 0, maxWindMph: 0, daysSinceWorst: null },
    });
    expect(f.roofTypeSecondary).toBe("flat_foam");
    expect(f.roofAgeYears).toBe(new Date().getFullYear() - 1990);
  });
});
