import { describe, it, expect } from "vitest";
import { roofAgeRange } from "./roof-age";

const NOW = new Date("2026-07-13T12:00:00Z");

describe("roofAgeRange — always a range, never a point", () => {
  it("known replacement date → a range around the true age, citing the source", () => {
    const r = roofAgeRange({ lastRoofReplacementAt: "2016-05-01", lastRoofReplacementSource: "owner", yearBuilt: 1998 }, NOW);
    expect(r).toEqual({ minYears: 8, maxYears: 11, source: "replaced 2016 per owner" });
  });

  it("young home with no replacement record → the roof is the original build", () => {
    const r = roofAgeRange({ lastRoofReplacementAt: null, lastRoofReplacementSource: null, yearBuilt: 2019 }, NOW);
    expect(r).toEqual({ minYears: 6, maxYears: 8, source: "original roof — built 2019" });
  });

  it("older home with no replacement record → honest null (unknown beats invented)", () => {
    const r = roofAgeRange({ lastRoofReplacementAt: null, lastRoofReplacementSource: null, yearBuilt: 1998 }, NOW);
    expect(r).toBeNull();
  });

  it("no data at all → null", () => {
    expect(roofAgeRange({ lastRoofReplacementAt: null, lastRoofReplacementSource: null, yearBuilt: null }, NOW)).toBeNull();
  });

  it("a fresh replacement never goes below zero", () => {
    const r = roofAgeRange({ lastRoofReplacementAt: "2026-01-10", lastRoofReplacementSource: "permit", yearBuilt: 2001 }, NOW);
    expect(r!.minYears).toBe(0);
    expect(r!.maxYears).toBeGreaterThanOrEqual(1);
    expect(r!.source).toBe("replaced 2026 per permit");
  });
});
