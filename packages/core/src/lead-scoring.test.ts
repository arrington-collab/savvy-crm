import { describe, it, expect } from "vitest";
import { scoreLead, deriveBand, stormSubScore, parseScoringConfig, scoreBandLegend } from "./lead-scoring";
import type { LeadFeatures } from "./lead-features";

const cfg = parseScoringConfig({});
const f = (over: Partial<LeadFeatures> = {}): LeadFeatures => ({
  source: "web", state: "AZ", inTerritory: true, hasContact: true,
  roofType: null, roofTypeSecondary: null, yearBuilt: null, roofAgeYears: null,
  roofReplacementYear: null,
  storm: { eventCount: 0, maxHailInches: 0, maxWindMph: 0, daysSinceWorst: null },
  ...over,
});

describe("stormSubScore", () => {
  it("severe recent hail scores near 1", () => {
    expect(stormSubScore({ eventCount: 1, maxHailInches: 1.5, maxWindMph: 0, daysSinceWorst: 30 }, cfg)).toBeCloseTo(1, 1);
  });
  it("recency tiers reduce the score", () => {
    const recent = stormSubScore({ eventCount: 1, maxHailInches: 1.5, maxWindMph: 0, daysSinceWorst: 30 }, cfg);
    const old = stormSubScore({ eventCount: 1, maxHailInches: 1.5, maxWindMph: 0, daysSinceWorst: 800 }, cfg);
    expect(old).toBeLessThan(recent);
    expect(old).toBe(0); // 800 days ≈ 26 months => >24 months => factor 0
  });
  it("keeps a storm in the 18–24 month window at the spec's 0.30 factor (not zero)", () => {
    // 610 days ≈ 20 months → recency 0.30; severe hail base 1.0 → sub-score 0.30
    const s = stormSubScore({ eventCount: 1, maxHailInches: 1.5, maxWindMph: 0, daysSinceWorst: 610 }, cfg);
    expect(s).toBeCloseTo(0.3, 5);
  });
  it("hail size thresholds step down (1.5 vs 1.0 vs 0.75)", () => {
    const big = stormSubScore({ eventCount: 1, maxHailInches: 1.5, maxWindMph: 0, daysSinceWorst: 30 }, cfg);
    const mid = stormSubScore({ eventCount: 1, maxHailInches: 1.0, maxWindMph: 0, daysSinceWorst: 30 }, cfg);
    const sm = stormSubScore({ eventCount: 1, maxHailInches: 0.75, maxWindMph: 0, daysSinceWorst: 30 }, cfg);
    expect(big).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(sm);
  });
  it("adds a multi-event bump, capped at 1", () => {
    const one = stormSubScore({ eventCount: 1, maxHailInches: 1.0, maxWindMph: 0, daysSinceWorst: 30 }, cfg);
    const two = stormSubScore({ eventCount: 2, maxHailInches: 1.0, maxWindMph: 0, daysSinceWorst: 30 }, cfg);
    expect(two).toBeGreaterThan(one);
    expect(stormSubScore({ eventCount: 5, maxHailInches: 1.5, maxWindMph: 0, daysSinceWorst: 10 }, cfg)).toBeLessThanOrEqual(1);
  });
});

describe("deriveBand", () => {
  it("maps the cutoffs", () => {
    expect(deriveBand(80, cfg)).toBe("hot");
    expect(deriveBand(79, cfg)).toBe("warm");
    expect(deriveBand(60, cfg)).toBe("warm");
    expect(deriveBand(59, cfg)).toBe("cool");
    expect(deriveBand(40, cfg)).toBe("cool");
    expect(deriveBand(39, cfg)).toBe("cold");
  });
});

describe("scoreLead", () => {
  it("weights storm/roof/source (severe-storm referral old-roof scores high)", () => {
    const r = scoreLead(f({
      source: "referral", roofType: "tile", yearBuilt: 1996, roofAgeYears: 30,
      storm: { eventCount: 2, maxHailInches: 1.75, maxWindMph: 0, daysSinceWorst: 60 },
    }), cfg);
    expect(r.score).toBeGreaterThanOrEqual(80);
    expect(r.band).toBe("hot");
    expect(r.reasons.length).toBeGreaterThan(0);
    expect(r.disqualified).toBe(false);
  });
  it("a cold-source no-storm new-roof lead is cold", () => {
    const r = scoreLead(f({ source: "other", roofType: "asphalt_shingle", yearBuilt: 2024, roofAgeYears: 1 }), cfg);
    expect(r.band).toBe("cold");
  });
  it("unknown roof age scores neutral, not zero", () => {
    const known0 = scoreLead(f({ roofAgeYears: 1 }), cfg).components.roof;
    const unknown = scoreLead(f({ roofAgeYears: null }), cfg).components.roof;
    expect(unknown).toBeGreaterThan(known0);
  });
  it("out-of-service-area gate zeroes the score and disqualifies", () => {
    const gated = parseScoringConfig({ serviceAreaStates: ["TX"] });
    const r = scoreLead(f({ state: "AZ", source: "referral", roofAgeYears: 30,
      storm: { eventCount: 1, maxHailInches: 1.5, maxWindMph: 0, daysSinceWorst: 10 } }), gated);
    expect(r.score).toBe(0);
    expect(r.disqualified).toBe(true);
    expect(r.band).toBe("cold");
    expect(r.reasons.some((x) => /out of area/i.test(x))).toBe(true);
  });
});

describe("scoreLead — slice 5: rationale cites effective roof age", () => {
  it("cites the replacement year when the age comes from a known replacement", () => {
    // roof effectively ~9 yrs because it was replaced in 2017 (not ~28 from a 1997 build).
    const r = scoreLead(f({ roofType: "asphalt_shingle", yearBuilt: 1997, roofAgeYears: 9, roofReplacementYear: 2017 }), cfg);
    const roofReason = r.reasons.find((x) => /roof/i.test(x));
    expect(roofReason).toBeDefined();
    expect(roofReason).toMatch(/replaced 2017/);
    expect(roofReason).toMatch(/~9\s*yrs/);
  });

  it("does NOT claim a replacement when the age is from build year", () => {
    const r = scoreLead(f({ roofType: "asphalt_shingle", yearBuilt: 1997, roofAgeYears: 28, roofReplacementYear: null }), cfg);
    const roofReason = r.reasons.find((x) => /roof/i.test(x));
    expect(roofReason).toBeDefined();
    expect(roofReason).not.toMatch(/replaced/i);
  });
});

describe("scoreLead — slice 5: secondary roof type contributes", () => {
  it("a tile SECONDARY roof earns the tile bump like a tile primary", () => {
    const primaryTile = scoreLead(f({ roofType: "tile", roofTypeSecondary: null, roofAgeYears: 15 }), cfg).components.roof;
    const secondaryTile = scoreLead(f({ roofType: "asphalt_shingle", roofTypeSecondary: "tile", roofAgeYears: 15 }), cfg).components.roof;
    const noTile = scoreLead(f({ roofType: "asphalt_shingle", roofTypeSecondary: null, roofAgeYears: 15 }), cfg).components.roof;
    expect(secondaryTile).toBeGreaterThan(noTile);
    expect(secondaryTile).toBeCloseTo(primaryTile, 10);
  });
});

describe("scoreBandLegend — slice 5: the in-app scale documentation", () => {
  it("documents 0–100 with contiguous Hot/Warm/Cool/Cold ranges from the config cutoffs", () => {
    const legend = scoreBandLegend(cfg);
    expect(legend).toEqual([
      { band: "hot", label: "Hot", min: 80, max: 100 },
      { band: "warm", label: "Warm", min: 60, max: 79 },
      { band: "cool", label: "Cool", min: 40, max: 59 },
      { band: "cold", label: "Cold", min: 0, max: 39 },
    ]);
  });

  it("tracks custom band cutoffs", () => {
    const legend = scoreBandLegend(parseScoringConfig({ bands: { hot: 90, warm: 70, cool: 50 } }));
    expect(legend.map((b) => [b.label, b.min, b.max])).toEqual([
      ["Hot", 90, 100], ["Warm", 70, 89], ["Cool", 50, 69], ["Cold", 0, 49],
    ]);
  });
});

describe("scoreLead — slice 5: source intent ordering", () => {
  it("referral > insurance_agent/realtor > web > ads baseline", () => {
    const q = (source: string) => scoreLead(f({ source, roofAgeYears: 12 }), cfg).components.source;
    expect(q("referral")).toBeGreaterThan(q("insurance_agent"));
    expect(q("insurance_agent")).toBeCloseTo(q("realtor"), 10);
    expect(q("insurance_agent")).toBeGreaterThan(q("web"));
    expect(q("web")).toBeGreaterThan(q("ads"));
  });
});
