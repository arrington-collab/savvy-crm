import { describe, it, expect } from "vitest";
import { scoreLeadBaseline } from "./lead-scoring";
import type { LeadFeatures } from "./lead-features";

const f = (over: Partial<LeadFeatures> = {}): LeadFeatures => ({
  source: "web", state: "AZ", inTerritory: true, hasContact: true,
  roofType: null, yearBuilt: null, roofAgeYears: null,
  storm: { eventCount: 0, maxHailInches: 0, maxWindMph: 0, daysSinceWorst: null }, ...over,
});

describe("scoreLeadBaseline", () => {
  it("scores a referral higher than web (same everything else)", () => {
    expect(scoreLeadBaseline(f({ source: "referral" })).score)
      .toBeGreaterThan(scoreLeadBaseline(f({ source: "web" })).score);
  });
  it("adds points for recent significant hail", () => {
    const noStorm = scoreLeadBaseline(f()).score;
    const hail = scoreLeadBaseline(f({ storm: { eventCount: 1, maxHailInches: 2, maxWindMph: 0, daysSinceWorst: 5 } })).score;
    expect(hail).toBeGreaterThan(noStorm);
  });
  it("adds points for an old roof", () => {
    expect(scoreLeadBaseline(f({ roofAgeYears: 25 })).score)
      .toBeGreaterThan(scoreLeadBaseline(f({ roofAgeYears: 2 })).score);
  });
  it("clamps to 0..100 and returns labeled factors", () => {
    const r = scoreLeadBaseline(f({ source: "referral", roofAgeYears: 30,
      storm: { eventCount: 3, maxHailInches: 3, maxWindMph: 120, daysSinceWorst: 1 } }));
    expect(r.score).toBeLessThanOrEqual(100);
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.factors.every((x) => typeof x.label === "string" && typeof x.points === "number")).toBe(true);
  });
  it("is case-insensitive on source weights", () => {
    expect(scoreLeadBaseline(f({ source: "Referral" })).score)
      .toBe(scoreLeadBaseline(f({ source: "referral" })).score);
  });
});
