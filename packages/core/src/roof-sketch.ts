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

/** A coincident (shared) edge whose two+ facets disagree on its type — surfaced so the
 *  rep resolves it rather than the total silently absorbing one type or the other. */
export interface EdgeConflict {
  facetIds: string[];
  types: SketchEdgeType[];
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
  /** Linear feet by edge type (slope-corrected for rakes, hips, valleys). Edges shared
   *  between facets (e.g. a ridge between two planes) are counted ONCE. */
  edgeLf: Record<SketchEdgeType, number>;
  /** How many duplicate edges were removed by shared-edge dedup (physical shared edges). */
  sharedEdgeCount: number;
  /** Coincident edges whose facets disagree on the edge type. */
  edgeConflicts: EdgeConflict[];
}

/** Endpoints match within tolerance (either direction) ⇒ the two edges are the same
 *  physical edge shared by two facets. */
const COINCIDENT_TOL_FT = 0.5;
function edgesCoincident(a1: SketchPoint, b1: SketchPoint, a2: SketchPoint, b2: SketchPoint): boolean {
  const near = (p: SketchPoint, q: SketchPoint) => Math.hypot(p.x - q.x, p.y - q.y) <= COINCIDENT_TOL_FT;
  return (near(a1, a2) && near(b1, b2)) || (near(a1, b2) && near(b1, a2));
}

interface EdgeRec {
  facetId: string;
  idx: number;
  a: SketchPoint;
  b: SketchPoint;
  type: SketchEdgeType;
  pitch: string;
}

/** Flatten every facet edge into a comparable record. */
function collectEdges(sketch: RoofSketch): EdgeRec[] {
  const out: EdgeRec[] = [];
  for (const f of sketch.facets) {
    for (let i = 0; i < f.points.length; i++) {
      out.push({
        facetId: f.id,
        idx: i,
        a: f.points[i]!,
        b: f.points[(i + 1) % f.points.length]!,
        type: f.edges[i] ?? "unspecified",
        pitch: f.pitch,
      });
    }
  }
  return out;
}

/** Group edges that occupy the same physical segment (a shared edge appears once per
 *  adjoining facet). Returns index groups into `edges`. */
function groupCoincidentEdges(edges: EdgeRec[]): number[][] {
  const used = new Array(edges.length).fill(false);
  const groups: number[][] = [];
  for (let i = 0; i < edges.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    const group = [i];
    for (let j = i + 1; j < edges.length; j++) {
      if (used[j]) continue;
      if (edgesCoincident(edges[i]!.a, edges[i]!.b, edges[j]!.a, edges[j]!.b)) {
        used[j] = true;
        group.push(j);
      }
    }
    groups.push(group);
  }
  return groups;
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
  }

  // Edge LF: dedup coincident edges so a shared ridge/hip/valley is counted once, not
  // once per adjoining facet (the double-count bug). A physical edge = one group.
  const edges = collectEdges(sketch);
  const edgeConflicts: EdgeConflict[] = [];
  let sharedEdgeCount = 0;
  for (const group of groupCoincidentEdges(edges)) {
    const e = edges[group[0]!]!;
    if (group.length > 1) sharedEdgeCount += group.length - 1;
    // Resolve the counted type from the group's *specified* types.
    const specified = [...new Set(group.map((k) => edges[k]!.type).filter((t) => t !== "unspecified"))];
    let type: SketchEdgeType;
    if (specified.length > 1) {
      edgeConflicts.push({ facetIds: group.map((k) => edges[k]!.facetId), types: specified });
      type = specified[0]!; // deterministic (facet order); count once, never both
    } else {
      type = specified[0] ?? "unspecified";
    }
    edgeLf[type] += edgeLengthFt(e.a, e.b) * edgeSlopeFactor(type, e.pitch);
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
    sharedEdgeCount,
    edgeConflicts,
  };
}

/** Suggest edge types from adjacency for edges the rep hasn't set yet ("unspecified"):
 *  a shared edge between facets is (defaulted to) a ridge; an un-shared perimeter edge is
 *  an eave. Suggestions only — manual types are never returned/overridden, and the rep
 *  confirms. (Ridge-vs-valley needs elevation the plan sketch doesn't carry, so shared
 *  edges default to ridge; the rep flips to valley/hip where needed.) */
export function suggestEdgeTypes(
  sketch: RoofSketch,
): Array<{ facetId: string; edgeIndex: number; suggested: SketchEdgeType }> {
  const edges = collectEdges(sketch);
  const out: Array<{ facetId: string; edgeIndex: number; suggested: SketchEdgeType }> = [];
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i]!;
    if (e.type !== "unspecified") continue; // never override a manual type
    const shared = edges.some((o, j) => j !== i && edgesCoincident(e.a, e.b, o.a, o.b));
    out.push({ facetId: e.facetId, edgeIndex: e.idx, suggested: shared ? "ridge" : "eave" });
  }
  return out;
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

// ── Editor viewport + snapping helpers (slice 1: input precision) ──────────────
// Pure geometry the SketchEditor uses for cursor-centered zoom, zoom-scaled hit
// radii, and snap-to-existing-vertex/edge. Kept here (tested) so the interactive
// component stays a thin shell over verified math.

/** Canvas pixel → ground point in feet, given the viewport center (feet) and the
 *  effective ft/px (base ft/px ÷ current zoom scale). Mirror of the editor's toFt. */
export function screenToGround(
  cursorPx: SketchPoint,
  view: SketchPoint,
  ftPerPxEff: number,
  canvas: number,
): SketchPoint {
  return {
    x: (cursorPx.x - canvas / 2) * ftPerPxEff + view.x,
    y: (cursorPx.y - canvas / 2) * ftPerPxEff + view.y,
  };
}

/** New viewport center that keeps the ground point under the cursor fixed while the
 *  zoom scale changes scale0 → scale1 (cursor-centered zoom). */
export function zoomAround(opts: {
  view: SketchPoint;
  scale0: number;
  scale1: number;
  cursorPx: SketchPoint;
  ftPerPxBase: number;
  canvas: number;
}): SketchPoint {
  const { view, scale0, scale1, cursorPx, ftPerPxBase, canvas } = opts;
  const ground = screenToGround(cursorPx, view, ftPerPxBase / scale0, canvas);
  const ftPerPxEff1 = ftPerPxBase / scale1;
  return {
    x: ground.x - (cursorPx.x - canvas / 2) * ftPerPxEff1,
    y: ground.y - (cursorPx.y - canvas / 2) * ftPerPxEff1,
  };
}

/** A constant on-screen hit radius (px) expressed in feet at the current zoom, so
 *  vertices stay equally clickable and can be placed closer together when zoomed in. */
export function vertexHitRadiusFt(hitPx: number, ftPerPxEff: number): number {
  return hitPx * ftPerPxEff;
}

export type SnapResult =
  | { kind: "vertex"; point: SketchPoint; facetId: string; vertexIndex: number }
  | { kind: "edge"; point: SketchPoint; facetId: string; edgeIndex: number }
  | null;

/** Nearest existing vertex or edge across ALL facets within thresholdFt of `cursor`.
 *  Vertices win over edges when both are in range (endpoints). Returns the snap point:
 *  the vertex coordinate, or the perpendicular projection onto the edge. */
export function findSnap(cursor: SketchPoint, facets: SketchFacet[], thresholdFt: number): SnapResult {
  let bestV: { d: number; facetId: string; vertexIndex: number; point: SketchPoint } | null = null;
  for (const f of facets) {
    for (let i = 0; i < f.points.length; i++) {
      const p = f.points[i]!;
      const d = Math.hypot(p.x - cursor.x, p.y - cursor.y);
      if (d <= thresholdFt && (bestV === null || d < bestV.d)) {
        bestV = { d, facetId: f.id, vertexIndex: i, point: { x: p.x, y: p.y } };
      }
    }
  }
  if (bestV) return { kind: "vertex", point: bestV.point, facetId: bestV.facetId, vertexIndex: bestV.vertexIndex };

  let bestE: { d: number; facetId: string; edgeIndex: number; point: SketchPoint } | null = null;
  for (const f of facets) {
    for (let i = 0; i < f.points.length; i++) {
      const a = f.points[i]!;
      const b = f.points[(i + 1) % f.points.length]!;
      const proj = projectPointToSegment(cursor, a, b);
      if (proj.dist <= thresholdFt && (bestE === null || proj.dist < bestE.d)) {
        bestE = { d: proj.dist, facetId: f.id, edgeIndex: i, point: proj.point };
      }
    }
  }
  if (bestE) return { kind: "edge", point: bestE.point, facetId: bestE.facetId, edgeIndex: bestE.edgeIndex };
  return null;
}

/** Whether clicking now would close the in-progress draft polygon: ≥3 points and the
 *  cursor within thresholdFt of the first vertex (the "ringed" first vertex). */
export function canCloseDraft(cursor: SketchPoint, draft: SketchPoint[], thresholdFt: number): boolean {
  if (draft.length < 3) return false;
  const first = draft[0]!;
  return Math.hypot(first.x - cursor.x, first.y - cursor.y) <= thresholdFt;
}

/** Perpendicular projection of p onto segment ab (clamped to the segment), with distance. */
function projectPointToSegment(p: SketchPoint, a: SketchPoint, b: SketchPoint): { point: SketchPoint; dist: number } {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const len2 = abx * abx + aby * aby;
  let t = len2 === 0 ? 0 : ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2;
  t = Math.max(0, Math.min(1, t));
  const point = { x: a.x + t * abx, y: a.y + t * aby };
  return { point, dist: Math.hypot(p.x - point.x, p.y - point.y) };
}
