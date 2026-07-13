import { describe, it, expect } from "vitest";
import { resolveRoofSize } from "./size";

describe("resolveRoofSize", () => {
  it("prefers a measured area (in squares) over everything else", () => {
    expect(
      resolveRoofSize({ measurementSquares: 24, assessorRoofSqft: 3000, footprintSqft: 2500, roofType: "asphalt_shingle" }),
    ).toEqual({ squares: 24, basis: "measured" });
  });

  it("falls back to assessor roof sqft / 100 when no measurement", () => {
    expect(
      resolveRoofSize({ measurementSquares: null, assessorRoofSqft: 3000, footprintSqft: 2500, roofType: "asphalt_shingle" }),
    ).toEqual({ squares: 30, basis: "assessor" });
  });

  it("falls back to footprint × pitch factor when no measurement or assessor sqft", () => {
    // 2000 sqft footprint × 1.3 default factor = 2600 sqft = 26 squares
    expect(
      resolveRoofSize({ measurementSquares: null, assessorRoofSqft: null, footprintSqft: 2000, roofType: "asphalt_shingle" }),
    ).toEqual({ squares: 26, basis: "footprint" });
  });

  it("returns null when no size input is available", () => {
    expect(resolveRoofSize({ measurementSquares: null, assessorRoofSqft: null, footprintSqft: null, roofType: null })).toBeNull();
  });

  it("ignores non-positive sizes", () => {
    expect(resolveRoofSize({ measurementSquares: 0, assessorRoofSqft: 0, footprintSqft: 0, roofType: null })).toBeNull();
  });
});
