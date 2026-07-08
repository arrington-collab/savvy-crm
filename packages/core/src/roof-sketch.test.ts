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
  screenToGround,
  zoomAround,
  vertexHitRadiusFt,
  findSnap,
  canCloseDraft,
  type RoofSketch,
  type SketchFacet,
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

describe("roofSketchSchema calibration", () => {
  it("defaults calibration to 1 for legacy sketches", () => {
    const s = roofSketchSchema.parse({ version: 1, centerLat: 0, centerLng: 0, zoom: 20, facets: [] });
    expect(s.calibration).toBe(1);
  });

  it("accepts a manual calibration factor", () => {
    const s = roofSketchSchema.parse({
      version: 1, centerLat: 0, centerLng: 0, zoom: 20, calibration: 1.05, facets: [],
    });
    expect(s.calibration).toBeCloseTo(1.05, 10);
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

// ── Slice 1: editor viewport + snapping (cursor-centered zoom, hit radius, snap) ──

const CANVAS = 640;

describe("screenToGround", () => {
  it("maps the canvas center to the viewport-center feet", () => {
    const g = screenToGround({ x: 320, y: 320 }, { x: 10, y: -5 }, 0.5, CANVAS);
    expect(g).toEqual({ x: 10, y: -5 });
  });

  it("maps offset pixels using ft-per-px", () => {
    // 100px right of center at 0.5 ft/px = +50ft east of view center.
    const g = screenToGround({ x: 420, y: 320 }, { x: 0, y: 0 }, 0.5, CANVAS);
    expect(g.x).toBeCloseTo(50, 10);
    expect(g.y).toBeCloseTo(0, 10);
  });
});

describe("zoomAround (cursor-centered zoom)", () => {
  const ftPerPxBase = 0.5;

  it("keeps the ground point under the cursor fixed while zooming in", () => {
    const view0 = { x: 12, y: -8 };
    const cursor = { x: 500, y: 210 }; // off-center
    const before = screenToGround(cursor, view0, ftPerPxBase / 1, CANVAS);
    const view1 = zoomAround({ view: view0, scale0: 1, scale1: 2.5, cursorPx: cursor, ftPerPxBase, canvas: CANVAS });
    const after = screenToGround(cursor, view1, ftPerPxBase / 2.5, CANVAS);
    expect(after.x).toBeCloseTo(before.x, 8);
    expect(after.y).toBeCloseTo(before.y, 8);
  });

  it("keeps the ground point fixed while zooming out too", () => {
    const view0 = { x: -3, y: 20 };
    const cursor = { x: 120, y: 590 };
    const before = screenToGround(cursor, view0, ftPerPxBase / 2, CANVAS);
    const view1 = zoomAround({ view: view0, scale0: 2, scale1: 0.8, cursorPx: cursor, ftPerPxBase, canvas: CANVAS });
    const after = screenToGround(cursor, view1, ftPerPxBase / 0.8, CANVAS);
    expect(after.x).toBeCloseTo(before.x, 8);
    expect(after.y).toBeCloseTo(before.y, 8);
  });

  it("leaves the view unchanged when zooming around the exact center", () => {
    const view0 = { x: 7, y: 7 };
    const view1 = zoomAround({ view: view0, scale0: 1, scale1: 3, cursorPx: { x: 320, y: 320 }, ftPerPxBase, canvas: CANVAS });
    expect(view1.x).toBeCloseTo(7, 10);
    expect(view1.y).toBeCloseTo(7, 10);
  });
});

describe("vertexHitRadiusFt", () => {
  it("is a constant screen-px radius expressed in feet (shrinks as you zoom in)", () => {
    expect(vertexHitRadiusFt(10, 0.5)).toBe(5); // ftPerPxEff 0.5
    expect(vertexHitRadiusFt(10, 0.2)).toBeCloseTo(2, 10); // zoomed in → tighter in feet
  });
});

describe("findSnap (across all facets)", () => {
  // Two separate 10ft squares, 100ft apart on x.
  const facets: SketchFacet[] = [
    {
      id: "a",
      points: [ { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 } ],
      pitch: "6/12",
      edges: ["eave", "rake", "ridge", "rake"],
      label: "none",
    },
    {
      id: "b",
      points: [ { x: 100, y: 0 }, { x: 110, y: 0 }, { x: 110, y: 10 }, { x: 100, y: 10 } ],
      pitch: "6/12",
      edges: ["eave", "rake", "ridge", "rake"],
      label: "none",
    },
  ];

  it("snaps to the nearest existing vertex within threshold (vertex wins over edge)", () => {
    const s = findSnap({ x: 10.4, y: 0.3 }, facets, 1);
    expect(s?.kind).toBe("vertex");
    expect(s).toMatchObject({ facetId: "a", vertexIndex: 1, point: { x: 10, y: 0 } });
  });

  it("snaps to a point on the nearest edge when not near any vertex", () => {
    // Mid-top edge of facet a (y=0), x=5 is 5ft from both endpoints → edge, not vertex.
    const s = findSnap({ x: 5, y: 0.4 }, facets, 1);
    expect(s?.kind).toBe("edge");
    expect(s).toMatchObject({ facetId: "a", edgeIndex: 0 });
    expect(s?.point.x).toBeCloseTo(5, 10);
    expect(s?.point.y).toBeCloseTo(0, 10);
  });

  it("finds a snap on the far facet too", () => {
    const s = findSnap({ x: 100.2, y: 0.2 }, facets, 1);
    expect(s).toMatchObject({ kind: "vertex", facetId: "b", vertexIndex: 0 });
  });

  it("returns null when nothing is within threshold", () => {
    expect(findSnap({ x: 50, y: 50 }, facets, 1)).toBeNull();
  });
});

describe("canCloseDraft", () => {
  const draft = [ { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 } ];

  it("is true when the cursor is within threshold of the first vertex and ≥3 points exist", () => {
    expect(canCloseDraft({ x: 0.3, y: 0.2 }, draft, 1)).toBe(true);
  });

  it("is false with fewer than 3 points", () => {
    expect(canCloseDraft({ x: 0.1, y: 0.1 }, draft.slice(0, 2), 1)).toBe(false);
  });

  it("is false when the cursor is far from the first vertex", () => {
    expect(canCloseDraft({ x: 5, y: 5 }, draft, 1)).toBe(false);
  });
});
