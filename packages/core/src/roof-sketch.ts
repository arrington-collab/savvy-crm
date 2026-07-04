import { z } from "zod";
import type { MeasurementAreas } from "./measurement";
import { parsePitch } from "./measurement";

/** Roofr-style DIY roof sketch: facet polygons drawn over aerial imagery.
 *  Vertices are stored in FEET offsets from the map center (+x east, +y south)
 *  so the sketch is independent of image zoom / display size. */

export const SKETCH_EDGE_TYPES = [
  "eave",
  "ridge",
  "hip",
  "valley",
  "rake",
  "wall_flashing",
  "step_flashing",
  "transition",
  "parapet",
  "unspecified",
] as const;
export type SketchEdgeType = (typeof SKETCH_EDGE_TYPES)[number];

export const SKETCH_EDGE_LABELS: Record<SketchEdgeType, string> = {
  eave: "Eave",
  ridge: "Ridge",
  hip: "Hip",
  valley: "Valley",
  rake: "Rake",
  wall_flashing: "Wall flashing",
  step_flashing: "Step flashing",
  transition: "Transition",
  parapet: "Parapet wall",
  unspecified: "Unspecified",
};

/** Display colors, mirroring Roofr's edge legend. */
export const SKETCH_EDGE_COLORS: Record<SketchEdgeType, string> = {
  eave: "#4caf50",
  ridge: "#8bc34a",
  hip: "#9c27b0",
  valley: "#f44336",
  rake: "#ffc107",
  wall_flashing: "#2196f3",
  step_flashing: "#a1887f",
  transition: "#e91e63",
  parapet: "#ff9800",
  unspecified: "#4fc3f7",
};

export const PITCH_OPTIONS = Array.from({ length: 17 }, (_, i) => `${i}/12`);

const pointSchema = z.object({ x: z.number(), y: z.number() });

export const sketchFacetSchema = z.object({
  id: z.string(),
  /** Polygon vertices in feet, ordered; edge i runs vertex i → i+1 (wrapping). */
  points: z.array(pointSchema).min(3),
  /** "X/12"; "0/12" is flat. */
  pitch: z.string().default("0/12"),
  /** Edge classification, one entry per polygon edge. */
  edges: z.array(z.enum(SKETCH_EDGE_TYPES)),
  label: z.enum(["none", "dormer", "two_story", "two_layer"]).default("none"),
});
export type SketchFacet = z.infer<typeof sketchFacetSchema>;

export const roofSketchSchema = z.object({
  version: z.literal(1).default(1),
  centerLat: z.number(),
  centerLng: z.number(),
  zoom: z.number().int().min(17).max(22).default(20),
  /** Manual scale correction from calibrating against a known length.
   *  Effective ft/px = mercator ft/px × calibration. Points are stored in
   *  already-calibrated feet; this factor re-anchors them to image pixels. */
  calibration: z.number().positive().default(1),
  facets: z.array(sketchFacetSchema).default([]),
});
export type RoofSketch = z.infer<typeof roofSketchSchema>;

export interface SketchPoint {
  x: number;
  y: number;
}

/** Plan (footprint) area of a polygon in sqft — shoelace formula. */
export function planAreaSqFt(points: SketchPoint[]): number {
  if (points.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

export function edgeLengthFt(a: SketchPoint, b: SketchPoint): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/** Slope multiplier for a pitch: sqrt(1 + (rise/12)^2). */
export function pitchFactor(pitch: string): number {
  const k = parsePitch(pitch) / 12;
  return Math.sqrt(1 + k * k);
}

/** Meters per CSS pixel of a Google static map (256px tiles, scale-independent). */
export function metersPerMapPixel(lat: number, zoom: number): number {
  return (156543.03392 * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom;
}

const FT_PER_METER = 3.28084;

/** Feet of ground distance represented by one "map pixel" (size= units). */
export function feetPerMapPixel(lat: number, zoom: number): number {
  return metersPerMapPixel(lat, zoom) * FT_PER_METER;
}

export interface FacetSummary {
  id: string;
  planSqft: number;
  surfaceSqft: number;
  pitch: string;
  label: SketchFacet["label"];
}

export interface SketchSummary {
  facetCount: number;
  totalPlanSqft: number;
  /** Pitch-adjusted roof surface area. */
  totalSurfaceSqft: number;
  pitchedSqft: number;
  flatSqft: number;
  squares: number;
  predominantPitch: string;
  facets: FacetSummary[];
  /** Linear feet by edge type (slope-corrected for rakes, hips, valleys). */
  edgeLf: Record<SketchEdgeType, number>;
}

/** True length multiplier for an edge type on a facet of the given pitch.
 *  Eaves/ridges/parapets etc. run level (plan length is true length); rakes
 *  run up the slope; hips/valleys run diagonally (≈ sqrt(1 + k²/2)). */
function edgeSlopeFactor(type: SketchEdgeType, pitch: string): number {
  const k = parsePitch(pitch) / 12;
  if (type === "rake") return Math.sqrt(1 + k * k);
  if (type === "hip" || type === "valley") return Math.sqrt(1 + (k * k) / 2);
  return 1;
}

export function summarizeSketch(sketch: RoofSketch): SketchSummary {
  const edgeLf = Object.fromEntries(SKETCH_EDGE_TYPES.map((t) => [t, 0])) as Record<
    SketchEdgeType,
    number
  >;
  const facets: FacetSummary[] = [];
  const areaByPitch = new Map<string, number>();
  let totalPlanSqft = 0;
  let totalSurfaceSqft = 0;
  let pitchedSqft = 0;
  let flatSqft = 0;

  for (const facet of sketch.facets) {
    const planSqft = planAreaSqFt(facet.points);
    const surfaceSqft = planSqft * pitchFactor(facet.pitch);
    totalPlanSqft += planSqft;
    totalSurfaceSqft += surfaceSqft;
    if (parsePitch(facet.pitch) > 0) pitchedSqft += surfaceSqft;
    else flatSqft += surfaceSqft;
    areaByPitch.set(facet.pitch, (areaByPitch.get(facet.pitch) ?? 0) + surfaceSqft);
    facets.push({ id: facet.id, planSqft, surfaceSqft, pitch: facet.pitch, label: facet.label });

    for (let i = 0; i < facet.points.length; i++) {
      const type = facet.edges[i] ?? "unspecified";
      const a = facet.points[i]!;
      const b = facet.points[(i + 1) % facet.points.length]!;
      edgeLf[type] += edgeLengthFt(a, b) * edgeSlopeFactor(type, facet.pitch);
    }
  }

  let predominantPitch = "0/12";
  let best = -1;
  for (const [pitch, area] of areaByPitch) {
    if (area > best) {
      best = area;
      predominantPitch = pitch;
    }
  }

  return {
    facetCount: sketch.facets.length,
    totalPlanSqft,
    totalSurfaceSqft,
    pitchedSqft,
    flatSqft,
    squares: totalSurfaceSqft / 100,
    predominantPitch,
    facets,
    edgeLf,
  };
}

/** Map a sketch summary onto the MeasurementAreas shape consumed by the
 *  estimate engine (same fields Roofr reports populate). */
export function sketchSummaryToAreas(s: SketchSummary): MeasurementAreas {
  return {
    squares: round2(s.squares),
    predominantPitch: s.predominantPitch,
    ridgeLf: round2(s.edgeLf.ridge),
    hipLf: round2(s.edgeLf.hip),
    valleyLf: round2(s.edgeLf.valley),
    eaveLf: round2(s.edgeLf.eave),
    rakeLf: round2(s.edgeLf.rake),
    stepFlashingLf: round2(s.edgeLf.step_flashing),
    penetrationCount: 0,
    facetCount: s.facetCount,
  };
}

export const WASTE_TABLE_PCTS = [0, 10, 12, 15, 17, 20, 22] as const;

export interface WasteRow {
  pct: number;
  sqft: number;
  squares: number;
}

/** Roofr-style waste table: surface area grossed up by each waste factor. */
export function wasteTable(
  surfaceSqft: number,
  pcts: readonly number[] = WASTE_TABLE_PCTS,
): WasteRow[] {
  return pcts.map((pct) => {
    const sqft = surfaceSqft * (1 + pct / 100);
    return { pct, sqft: Math.ceil(sqft), squares: round1(sqft / 100) };
  });
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
