import type { RoofSketch } from "@savvy/core";

/**
 * A minimal but valid DIY sketch: one 20×20ft facet at 6/12. Passes
 * `roofSketchSchema.safeParse` (copied from packages/db/tests/save-sketch-measurement.test.ts).
 */
export function squareSketch(pitch = "6/12"): RoofSketch {
  return {
    version: 1,
    centerLat: 33.4,
    centerLng: -112.0,
    zoom: 20,
    calibration: 1,
    facets: [
      {
        id: "facet-1",
        points: [
          { x: 0, y: 0 },
          { x: 20, y: 0 },
          { x: 20, y: 20 },
          { x: 0, y: 20 },
        ],
        pitch,
        edges: ["eave", "rake", "ridge", "rake"],
        label: "none",
        ventilated: true,
      },
    ],
  };
}
