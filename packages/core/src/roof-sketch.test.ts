import { describe, expect, it } from "vitest";
import {
  planAreaSqFt,
  pitchFactor,
  edgeLengthFt,
  summarizeSketch,
  sketchSummaryToAreas,
  wasteTable,
  feetPerMapPixel,
  roofSketchSchema,
  type RoofSketch,
} from "./roof-sketch";

// 30ft x 40ft rectangle, clockwise from top-left. Edge order: top, right, bottom, left.
const rect = (pitch: string, edges: [string, string, string, string]): RoofSketch =>
  roofSketchSchema.parse({
    version: 1,
    centerLat: 33.45,
    centerLng: -112.07,
    zoom: 20,
    facets: [
      {
        id: "f1",
        points: [
          { x: 0, y: 0 },
          { x: 40, y: 0 },
          { x: 40, y: 30 },
          { x: 0, y: 30 },
        ],
        pitch,
        edges,
        label: "none",
      },
    ],
  });

describe("roof-sketch geometry", () => {
  it("computes shoelace plan area", () => {
    expect(planAreaSqFt([{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 30 }, { x: 0, y: 30 }])).toBe(1200);
  });

  it("computes edge length", () => {
    expect(edgeLengthFt({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
  });

  it("flat pitch factor is 1; 12/12 is sqrt(2)", () => {
    expect(pitchFactor("0/12")).toBe(1);
    expect(pitchFactor("12/12")).toBeCloseTo(Math.SQRT2, 10);
  });
});

describe("summarizeSketch", () => {
  it("summarizes a flat rectangle", () => {
    const s = summarizeSketch(rect("0/12", ["ridge", "rake", "eave", "rake"]));
    expect(s.totalPlanSqft).toBe(1200);
    expect(s.totalSurfaceSqft).toBe(1200);
    expect(s.flatSqft).toBe(1200);
    expect(s.pitchedSqft).toBe(0);
    expect(s.squares).toBe(12);
    expect(s.predominantPitch).toBe("0/12");
    expect(s.edgeLf.ridge).toBe(40);
    expect(s.edgeLf.eave).toBe(40);
    expect(s.edgeLf.rake).toBe(60); // flat: no slope correction
  });

  it("applies pitch factor to area and slope-corrects rakes", () => {
    const s = summarizeSketch(rect("6/12", ["ridge", "rake", "eave", "rake"]));
    const factor = Math.sqrt(1 + 0.25);
    expect(s.totalSurfaceSqft).toBeCloseTo(1200 * factor, 6);
    expect(s.pitchedSqft).toBeCloseTo(1200 * factor, 6);
    expect(s.edgeLf.rake).toBeCloseTo(60 * factor, 6);
    expect(s.edgeLf.ridge).toBe(40); // level edges unchanged
    expect(s.predominantPitch).toBe("6/12");
  });

  it("maps to MeasurementAreas for the estimate engine", () => {
    const areas = sketchSummaryToAreas(summarizeSketch(rect("0/12", ["ridge", "rake", "eave", "rake"])));
    expect(areas.squares).toBe(12);
    expect(areas.eaveLf).toBe(40);
    expect(areas.facetCount).toBe(1);
    expect(areas.predominantPitch).toBe("0/12");
  });
});

describe("wasteTable", () => {
  it("grosses up surface area by each waste factor", () => {
    const rows = wasteTable(1000, [0, 10, 20]);
    expect(rows).toEqual([
      { pct: 0, sqft: 1000, squares: 10 },
      { pct: 10, sqft: 1100, squares: 11 },
      { pct: 20, sqft: 1200, squares: 12 },
    ]);
  });
});

describe("feetPerMapPixel", () => {
  it("matches web-mercator ground resolution at the equator", () => {
    // zoom 0: 156543.03392 m/px * 3.28084 ft/m
    expect(feetPerMapPixel(0, 0)).toBeCloseTo(156543.03392 * 3.28084, 3);
    // Higher zoom halves the resolution per step.
    expect(feetPerMapPixel(0, 1)).toBeCloseTo(feetPerMapPixel(0, 0) / 2, 6);
  });
});
