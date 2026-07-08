"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  SKETCH_EDGE_TYPES,
  SKETCH_EDGE_LABELS,
  SKETCH_EDGE_COLORS,
  PITCH_OPTIONS,
  feetPerMapPixel,
  edgeLengthFt,
  planAreaSqFt,
  pitchFactor,
  summarizeSketch,
  ventilationSummary,
  suggestEdgeTypes,
  wasteTable,
  zoomAround,
  vertexHitRadiusFt,
  findSnap,
  canCloseDraft,
  roofSketchSchema,
  type RoofSketch,
  type SketchFacet,
  type SketchEdgeType,
  type SketchPoint,
  type SnapResult,
} from "@savvy/core";
import { saveSketchMeasurementAction } from "@/lib/measurement-actions";

/** Canvas size in CSS px. The static map is requested as MAP_PX map-pixels
 *  (scale=2 for retina), so 1 CSS px == MAP_PX / CANVAS px of map. */
const CANVAS = 640;
const MAP_PX = 640;
const SNAP_PX = 10;
const DEFAULT_ZOOM = 20;
/** Continuous zoom bounds; imagery integer-zoom is rebased to keep viewScale here. */
const MIN_SCALE = 0.5;
const MAX_SCALE = 6;
const MIN_MAP_ZOOM = 17;
const MAX_MAP_ZOOM = 21;
/** Snap drawn segments to 45° multiples when within this tolerance. */
const ANGLE_SNAP_TOLERANCE_RAD = (7 * Math.PI) / 180;

type Mode = "draw" | "select" | "edges" | "pan" | "calibrate";

interface SketchEditorProps {
  /** The sketch's owner: a lead (pre-job) or a job. Both share the property that
   *  carries the measurement across the lead → job lifecycle. */
  scope: { kind: "lead" | "job"; id: string };
  measurementId: string | null;
  address: string | null;
  lat: number | null;
  lng: number | null;
  mapsApiKey: string;
  initialSketch: RoofSketch | null;
}

function fmtFt(ft: number): string {
  const whole = Math.floor(ft);
  const inches = Math.round((ft - whole) * 12);
  if (inches === 12) return `${whole + 1}ft 0in`;
  return `${whole}ft ${inches}in`;
}

function pointInPolygon(p: SketchPoint, poly: SketchPoint[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

/** Offset a lat/lng by feet east (+x) and feet south (+y). */
function offsetLatLng(lat: number, lng: number, xFt: number, yFt: number): { lat: number; lng: number } {
  const mPerDegLat = 111320;
  const xM = xFt / 3.28084;
  const yM = yFt / 3.28084;
  return {
    lat: lat - yM / mPerDegLat,
    lng: lng + xM / (mPerDegLat * Math.cos((lat * Math.PI) / 180)),
  };
}

let facetSeq = 0;
function newFacetId(): string {
  facetSeq += 1;
  return `facet-${Date.now()}-${facetSeq}`;
}

export function SketchEditor({
  scope,
  measurementId,
  address,
  lat,
  lng,
  mapsApiKey,
  initialSketch,
}: SketchEditorProps) {
  const router = useRouter();
  const backHref = scope.kind === "lead" ? `/leads/${scope.id}` : `/jobs/${scope.id}`;
  const backLabel = scope.kind === "lead" ? "← Back to lead" : "← Back to job";
  const centerLat = initialSketch?.centerLat ?? lat ?? 33.4484;
  const centerLng = initialSketch?.centerLng ?? lng ?? -112.074;
  const [zoom, setZoom] = useState<number>(initialSketch?.zoom ?? DEFAULT_ZOOM);

  const [facets, setFacets] = useState<SketchFacet[]>(initialSketch?.facets ?? []);
  const [calibration, setCalibration] = useState<number>(initialSketch?.calibration ?? 1);
  const [history, setHistory] = useState<SketchFacet[][]>([]);
  const [future, setFuture] = useState<SketchFacet[][]>([]);

  const [mode, setMode] = useState<Mode>("draw");
  const [draft, setDraft] = useState<SketchPoint[]>([]);
  const [hover, setHover] = useState<SketchPoint | null>(null);
  const [angleSnap, setAngleSnap] = useState(true);
  const [selectedFacetId, setSelectedFacetId] = useState<string | null>(null);
  const [edgeTool, setEdgeTool] = useState<SketchEdgeType>("eave");
  const [drag, setDrag] = useState<{ facetId: string; vertexIdx: number } | null>(null);

  // Pan: `view` is the committed viewport-center offset from the sketch anchor
  // (in feet). While dragging, `panPx` translates the layers without refetching.
  const [view, setView] = useState<SketchPoint>({ x: 0, y: 0 });
  const [panDrag, setPanDrag] = useState<{ startX: number; startY: number; origin: SketchPoint } | null>(null);
  const [panPx, setPanPx] = useState<{ dx: number; dy: number }>({ dx: 0, dy: 0 });
  // Continuous zoom on top of the integer imagery zoom (cursor-centered).
  const [viewScale, setViewScale] = useState<number>(1);
  // Active snap target under the cursor (vertex/edge across all facets) — drives the
  // snap indicator + the magnifier loupe. `cursorPx` is the raw pointer position.
  const [snap, setSnap] = useState<SnapResult>(null);
  const [cursorPx, setCursorPx] = useState<{ x: number; y: number } | null>(null);
  // Two-pointer pinch (touch): active pointers + the gesture baseline.
  const pointers = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinch = useRef<{ dist: number; scale: number } | null>(null);

  // Calibration: two clicked points + the user-entered true length.
  const [calPoints, setCalPoints] = useState<SketchPoint[]>([]);
  const [calInput, setCalInput] = useState("");

  const [savePending, startSave] = useTransition();
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedMeasurementId, setSavedMeasurementId] = useState<string | null>(measurementId);

  const svgRef = useRef<SVGSVGElement>(null);

  // ft per CSS pixel of the base imagery (integer zoom) × manual calibration…
  const ftPerPxBase = useMemo(
    () => ((feetPerMapPixel(centerLat, zoom) * MAP_PX) / CANVAS) * calibration,
    [centerLat, zoom, calibration],
  );
  // …and the effective ft/px once the continuous cursor-zoom scale is applied.
  const ftPerPx = ftPerPxBase / viewScale;

  const toFt = useCallback(
    (px: number, py: number): SketchPoint => ({
      x: (px - CANVAS / 2) * ftPerPx + view.x,
      y: (py - CANVAS / 2) * ftPerPx + view.y,
    }),
    [ftPerPx, view],
  );
  const toPx = useCallback(
    (p: SketchPoint): { x: number; y: number } => ({
      x: (p.x - view.x) / ftPerPx + CANVAS / 2,
      y: (p.y - view.y) / ftPerPx + CANVAS / 2,
    }),
    [ftPerPx, view],
  );

  const mapUrl = useMemo(() => {
    if (!mapsApiKey) return null;
    const c = offsetLatLng(centerLat, centerLng, view.x, view.y);
    const loc = `${c.lat},${c.lng}`;
    return (
      `https://maps.googleapis.com/maps/api/staticmap?center=${encodeURIComponent(loc)}` +
      `&zoom=${zoom}&size=${MAP_PX}x${MAP_PX}&scale=2&maptype=satellite&key=${mapsApiKey}`
    );
  }, [mapsApiKey, centerLat, centerLng, view, zoom]);

  const sketch: RoofSketch = useMemo(
    () => ({ version: 1, centerLat, centerLng, zoom, calibration, facets }),
    [centerLat, centerLng, zoom, calibration, facets],
  );
  const summary = useMemo(() => summarizeSketch(sketch), [sketch]);
  const vent = useMemo(() => ventilationSummary(sketch), [sketch]);
  const waste = useMemo(() => wasteTable(summary.totalSurfaceSqft), [summary]);
  const selectedFacet = facets.find((f) => f.id === selectedFacetId) ?? null;

  // Local autosave: guards against a lost tab/refresh before an explicit Save. Keyed by
  // the sketch owner; cleared once the measurement is persisted server-side.
  const draftKey = `savvy:sketch-draft:${jobId}`;
  const [restoredDraft, setRestoredDraft] = useState(false);

  useEffect(() => {
    if (measurementId) return; // a saved measurement is the source of truth
    let restored: RoofSketch | null = null;
    try {
      const raw = window.localStorage.getItem(draftKey);
      if (raw) {
        const parsed = roofSketchSchema.safeParse(JSON.parse(raw));
        if (parsed.success && parsed.data.facets.length > 0) restored = parsed.data;
      }
    } catch {
      /* corrupt draft — ignore */
    }
    if (!restored || facets.length > 0) return;
    // Defer out of the effect body: applies the external (localStorage) draft after mount
    // without a synchronous cascading render, and without a hydration mismatch.
    const r = restored;
    queueMicrotask(() => {
      setFacets(r.facets);
      setCalibration(r.calibration);
      setRestoredDraft(true);
    });
    // Mount-only restore.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const t = setTimeout(() => {
      try {
        window.localStorage.setItem(draftKey, JSON.stringify(sketch));
      } catch {
        /* storage full / unavailable — non-fatal */
      }
    }, 800);
    return () => clearTimeout(t);
  }, [sketch, draftKey]);

  const pushHistory = useCallback((prev: SketchFacet[]) => {
    setHistory((h) => [...h.slice(-49), prev]);
    setFuture([]);
  }, []);

  function undo() {
    // While drawing, undo removes the last placed draft point before touching facets.
    if (draft.length > 0) {
      setDraft((d) => d.slice(0, -1));
      setHover(null);
      return;
    }
    setHistory((h) => {
      if (h.length === 0) return h;
      const prev = h[h.length - 1]!;
      setFacets((cur) => {
        setFuture((f) => [...f, cur]);
        return prev;
      });
      return h.slice(0, -1);
    });
  }
  function redo() {
    setFuture((f) => {
      if (f.length === 0) return f;
      const next = f[f.length - 1]!;
      setFacets((cur) => {
        setHistory((h) => [...h, cur]);
        return next;
      });
      return f.slice(0, -1);
    });
  }

  function svgPoint(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const rect = svgRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  /** On-screen snap tolerance (SNAP_PX) expressed in feet at the current zoom, so the
   *  hit radius is a constant number of screen pixels regardless of how far you zoom. */
  const hitRadiusFt = () => vertexHitRadiusFt(SNAP_PX, ftPerPx);

  /** Facets treated as snap targets, optionally with the in-progress draft as one more
   *  polygon and optionally excluding one vertex (the one being dragged, to avoid self-snap). */
  function snapTargets(opts?: { includeDraft?: boolean; exclude?: { facetId: string; vertexIdx: number } }): SketchFacet[] {
    const base = opts?.exclude
      ? facets.map((f) =>
          f.id === opts.exclude!.facetId
            ? { ...f, points: f.points.filter((_, i) => i !== opts.exclude!.vertexIdx) }
            : f,
        )
      : facets;
    if (opts?.includeDraft && draft.length > 0) {
      return [...base, { id: "__draft__", points: draft, pitch: "0/12", edges: [], label: "none", ventilated: true } as SketchFacet];
    }
    return base;
  }

  /** Set the render-time snap indicator from a raw pointer position (draw/select modes). */
  function updateSnapIndicator(raw: { x: number; y: number }) {
    setCursorPx(raw);
    if (mode === "draw" || mode === "select") {
      setSnap(findSnap(toFt(raw.x, raw.y), snapTargets({ includeDraft: mode === "draw" }), hitRadiusFt()));
    } else if (snap) {
      setSnap(null);
    }
  }

  /** Cursor-centered continuous zoom by `factor` about `cursorPx`. Also rebases the
   *  integer imagery zoom when the scale crosses a 2× step so the map stays crisp — the
   *  geometry (kept in feet) never moves, so this is invisible to the user. */
  function applyZoom(factor: number, at: { x: number; y: number }) {
    const scale0 = viewScale;
    let scale1 = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale0 * factor));
    if (scale1 === scale0) return;
    const newView = zoomAround({ view, scale0, scale1, cursorPx: at, ftPerPxBase, canvas: CANVAS });
    let nz = zoom;
    while (scale1 >= 2 && nz < MAX_MAP_ZOOM) { nz += 1; scale1 /= 2; }
    while (scale1 <= 0.5 && nz > MIN_MAP_ZOOM) { nz -= 1; scale1 *= 2; }
    setView(newView);
    setViewScale(scale1);
    if (nz !== zoom) setZoom(nz);
  }

  function handleWheel(e: React.WheelEvent) {
    e.preventDefault();
    applyZoom(Math.exp(-e.deltaY * 0.0015), svgPoint(e));
  }

  /** Snap the segment prev→p to the nearest 45° multiple. The reference axis
   *  is the previous draft edge when one exists, else the screen axes — so
   *  rectangles stay square even on rotated buildings. */
  function snapSegmentAngle(p: SketchPoint, prev: SketchPoint, prevPrev: SketchPoint | null): SketchPoint {
    const dx = p.x - prev.x;
    const dy = p.y - prev.y;
    const len = Math.hypot(dx, dy);
    if (len < 0.5) return p;
    const ref = prevPrev ? Math.atan2(prev.y - prevPrev.y, prev.x - prevPrev.x) : 0;
    const rel = Math.atan2(dy, dx) - ref;
    const step = Math.PI / 4;
    const snappedRel = Math.round(rel / step) * step;
    let diff = rel - snappedRel;
    if (diff > Math.PI) diff -= 2 * Math.PI;
    if (diff < -Math.PI) diff += 2 * Math.PI;
    if (Math.abs(diff) > ANGLE_SNAP_TOLERANCE_RAD) return p;
    const ang = ref + snappedRel;
    return { x: prev.x + len * Math.cos(ang), y: prev.y + len * Math.sin(ang) };
  }

  /** Raw pointer px → drawing point in feet. Snapping to an existing vertex/edge (any
   *  facet or the draft) wins; otherwise fall back to 90°/45° angle snap. */
  function drawPoint(raw: { x: number; y: number }, bypassAngle: boolean): SketchPoint {
    const ftp = toFt(raw.x, raw.y);
    const s = findSnap(ftp, snapTargets({ includeDraft: true }), hitRadiusFt());
    if (s) return s.point;
    if (!angleSnap || bypassAngle || draft.length === 0) return ftp;
    const prev = draft[draft.length - 1]!;
    const prevPrev = draft.length >= 2 ? draft[draft.length - 2]! : null;
    return snapSegmentAngle(ftp, prev, prevPrev);
  }

  function closeDraft() {
    if (draft.length < 3) return;
    pushHistory(facets);
    setFacets((prev) => [
      ...prev,
      {
        id: newFacetId(),
        points: draft,
        pitch: "0/12",
        edges: draft.map(() => "unspecified" as SketchEdgeType),
        label: "none",
        ventilated: true,
      },
    ]);
    setDraft([]);
    setHover(null);
  }

  /** Multiply every stored foot value by f so geometry stays glued to the same
   *  image pixels when the scale factor changes. */
  function rescaleAll(f: number) {
    setFacets((prev) =>
      prev.map((fa) => ({ ...fa, points: fa.points.map((p) => ({ x: p.x * f, y: p.y * f })) })),
    );
    setDraft((d) => d.map((p) => ({ x: p.x * f, y: p.y * f })));
    setView((v) => ({ x: v.x * f, y: v.y * f }));
    // Old history entries are in pre-calibration feet — drop them to avoid desync.
    setHistory([]);
    setFuture([]);
  }

  function applyCalibration() {
    const trueFt = parseFloat(calInput);
    if (!Number.isFinite(trueFt) || trueFt <= 0 || calPoints.length !== 2) return;
    const measured = edgeLengthFt(calPoints[0]!, calPoints[1]!);
    if (measured <= 0) return;
    const f = trueFt / measured;
    setCalibration((c) => c * f);
    rescaleAll(f);
    setCalPoints([]);
    setCalInput("");
    setMode("draw");
  }

  function resetCalibration() {
    if (calibration === 1) return;
    rescaleAll(1 / calibration);
    setCalibration(1);
    setCalPoints([]);
    setCalInput("");
  }

  function handlePointerDown(e: React.PointerEvent) {
    const raw = svgPoint(e);
    (e.target as Element).setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, raw);
    // Second finger down ⇒ pinch gesture; abandon any single-touch draft-in-progress action.
    if (pointers.current.size >= 2) {
      pinch.current = null;
      setPanDrag(null);
      setDrag(null);
      return;
    }

    if (mode === "pan") {
      setPanDrag({ startX: raw.x, startY: raw.y, origin: view });
      return;
    }

    if (mode === "calibrate") {
      if (calPoints.length >= 2) return;
      setCalPoints((pts) => [...pts, toFt(raw.x, raw.y)]);
      return;
    }

    if (mode === "draw") {
      // Close when clicking the first draft vertex (only while it's visually ringed).
      if (canCloseDraft(toFt(raw.x, raw.y), draft, hitRadiusFt())) {
        closeDraft();
        return;
      }
      setDraft((d) => [...d, drawPoint(raw, e.altKey)]);
      return;
    }

    if (mode === "select") {
      // Vertex hit → start drag; else facet hit → select.
      for (const f of facets) {
        for (let i = 0; i < f.points.length; i++) {
          const v = toPx(f.points[i]!);
          if (Math.hypot(v.x - raw.x, v.y - raw.y) <= SNAP_PX) {
            pushHistory(facets);
            setSelectedFacetId(f.id);
            setDrag({ facetId: f.id, vertexIdx: i });
            return;
          }
        }
      }
      const ftp = toFt(raw.x, raw.y);
      const hit = [...facets].reverse().find((f) => pointInPolygon(ftp, f.points));
      setSelectedFacetId(hit?.id ?? null);
      return;
    }

    if (mode === "edges") {
      // Nearest edge within threshold gets the current edge tool.
      const ftp = toFt(raw.x, raw.y);
      let best: { facetId: string; idx: number; dist: number } | null = null;
      for (const f of facets) {
        for (let i = 0; i < f.points.length; i++) {
          const a = f.points[i]!;
          const b = f.points[(i + 1) % f.points.length]!;
          const d = distToSegmentFt(ftp, a, b);
          if (best === null || d < best.dist) best = { facetId: f.id, idx: i, dist: d };
        }
      }
      if (best && best.dist <= SNAP_PX * ftPerPx) {
        pushHistory(facets);
        const target = best;
        setFacets((prev) =>
          prev.map((f) =>
            f.id === target.facetId
              ? { ...f, edges: f.edges.map((t, i) => (i === target.idx ? edgeTool : t)) }
              : f,
          ),
        );
      }
    }
  }

  /** Two active pointers ⇒ pinch-zoom about their midpoint (touch). */
  function handlePinch() {
    const pts = [...pointers.current.values()];
    if (pts.length < 2) return;
    const dist = Math.hypot(pts[0]!.x - pts[1]!.x, pts[0]!.y - pts[1]!.y);
    const mid = { x: (pts[0]!.x + pts[1]!.x) / 2, y: (pts[0]!.y + pts[1]!.y) / 2 };
    if (!pinch.current || pinch.current.dist === 0) {
      pinch.current = { dist, scale: viewScale };
      return;
    }
    applyZoom(dist / pinch.current.dist, mid);
    pinch.current = { dist, scale: viewScale };
  }

  function handlePointerMove(e: React.PointerEvent) {
    const raw = svgPoint(e);
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, raw);
    if (pointers.current.size >= 2) {
      handlePinch();
      return;
    }
    if (panDrag) {
      setPanPx({ dx: raw.x - panDrag.startX, dy: raw.y - panDrag.startY });
      return;
    }
    updateSnapIndicator(raw);
    if (mode === "draw" && draft.length > 0) {
      setHover(drawPoint(raw, e.altKey));
    }
    if (mode === "calibrate" && calPoints.length === 1) {
      setHover(toFt(raw.x, raw.y));
    }
    if (drag) {
      const d = drag;
      const ftp0 = toFt(raw.x, raw.y);
      const s = findSnap(ftp0, snapTargets({ exclude: { facetId: d.facetId, vertexIdx: d.vertexIdx } }), hitRadiusFt());
      const ftp = s ? s.point : ftp0;
      setFacets((prev) =>
        prev.map((f) =>
          f.id === d.facetId
            ? { ...f, points: f.points.map((p, i) => (i === d.vertexIdx ? ftp : p)) }
            : f,
        ),
      );
    }
  }

  function endGesture() {
    if (panDrag) {
      setView({
        x: panDrag.origin.x - panPx.dx * ftPerPx,
        y: panDrag.origin.y - panPx.dy * ftPerPx,
      });
      setPanDrag(null);
      setPanPx({ dx: 0, dy: 0 });
    }
    setDrag(null);
  }

  function handlePointerUp(e: React.PointerEvent) {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    endGesture();
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      setDraft([]);
      setHover(null);
      setSelectedFacetId(null);
      setCalPoints([]);
      setCalInput("");
    }
    if (e.key === "Enter" && mode === "draw") closeDraft();
    if ((e.key === "Backspace" || e.key === "Delete") && selectedFacetId && mode === "select") {
      deleteFacet(selectedFacetId);
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
    }
  }

  function deleteFacet(id: string) {
    pushHistory(facets);
    setFacets((prev) => prev.filter((f) => f.id !== id));
    setSelectedFacetId(null);
  }

  function setFacetPitch(id: string, pitch: string) {
    pushHistory(facets);
    setFacets((prev) => prev.map((f) => (f.id === id ? { ...f, pitch } : f)));
  }

  function setFacetLabel(id: string, label: SketchFacet["label"]) {
    pushHistory(facets);
    setFacets((prev) => prev.map((f) => (f.id === id ? { ...f, label } : f)));
  }

  function setFacetVentilated(id: string, ventilated: boolean) {
    pushHistory(facets);
    setFacets((prev) => prev.map((f) => (f.id === id ? { ...f, ventilated } : f)));
  }

  /** Fill only the still-unspecified edges from adjacency (shared→ridge, else eave).
   *  Manual types are left untouched — this is a suggestion the rep can then refine. */
  function applyEdgeSuggestions() {
    const suggestions = suggestEdgeTypes(sketch);
    if (suggestions.length === 0) return;
    pushHistory(facets);
    setFacets((prev) =>
      prev.map((f) => ({
        ...f,
        edges: f.edges.map((t, i) => suggestions.find((s) => s.facetId === f.id && s.edgeIndex === i)?.suggested ?? t),
      })),
    );
  }

  function handleSave() {
    setSaveError(null);
    startSave(async () => {
      const result = await saveSketchMeasurementAction({
        scope,
        sketch,
        measurementId: savedMeasurementId,
      });
      if ("ok" in result) {
        setSavedMeasurementId(result.measurementId);
        setSavedAt(new Date());
        setRestoredDraft(false);
        try { window.localStorage.removeItem(draftKey); } catch { /* non-fatal */ }
        router.refresh();
      } else {
        setSaveError(result.error);
      }
    });
  }

  function switchMode(m: Mode) {
    setMode(m);
    setDraft([]);
    setHover(null);
    setPanDrag(null);
    setPanPx({ dx: 0, dy: 0 });
    if (m !== "calibrate") {
      setCalPoints([]);
      setCalInput("");
    }
  }

  const modeBtn = (m: Mode, label: string) => (
    <Button
      key={m}
      size="sm"
      variant={mode === m ? "default" : "outline"}
      onClick={() => switchMode(m)}
      data-testid={`sketch-mode-${m}`}
    >
      {label}
    </Button>
  );

  const cursor =
    mode === "pan"
      ? panDrag
        ? "grabbing"
        : "grab"
      : mode === "draw" || mode === "calibrate"
        ? "crosshair"
        : "default";

  const measuredCal = calPoints.length === 2 ? edgeLengthFt(calPoints[0]!, calPoints[1]!) : null;

  return (
    <div className="space-y-4 p-6" data-testid="sketch-editor">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1">
          <Link href={backHref} className="text-sm text-muted-foreground hover:underline">
            {backLabel}
          </Link>
          <h1 className="text-xl font-semibold">Roof sketch</h1>
          {address && <p className="text-sm text-muted-foreground">{address}</p>}
        </div>
        <div className="flex items-center gap-2">
          {savedMeasurementId && scope.kind === "job" && (
            <Link
              href={`/jobs/${scope.id}/measure/report`}
              className="text-sm underline underline-offset-2 text-muted-foreground hover:text-foreground"
            >
              View report
            </Link>
          )}
          <Button size="sm" variant="outline" onClick={undo} disabled={history.length === 0}>
            Undo
          </Button>
          <Button size="sm" variant="outline" onClick={redo} disabled={future.length === 0}>
            Redo
          </Button>
          <Button size="sm" onClick={handleSave} disabled={savePending || facets.length === 0} data-testid="sketch-save-btn">
            {savePending ? "Saving…" : "Save measurement"}
          </Button>
        </div>
      </div>

      {saveError && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">
          Could not save: {saveError}
        </div>
      )}
      {summary.edgeConflicts.length > 0 && (
        <div className="rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-sm" data-testid="edge-conflicts">
          <span className="font-medium">Shared-edge type conflict</span> — {summary.edgeConflicts.length}{" "}
          edge{summary.edgeConflicts.length > 1 ? "s" : ""} where adjoining facets disagree:{" "}
          {summary.edgeConflicts
            .map((c) => c.types.map((t) => SKETCH_EDGE_LABELS[t]).join(" vs "))
            .join("; ")}
          . Fix them in Edges mode — until then each is counted once, under one type.
        </div>
      )}
      {savedAt && !saveError && (
        <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
          Measurement saved {savedAt.toLocaleTimeString()} — {summary.squares.toFixed(1)} squares,{" "}
          {summary.facetCount} facets. Generate an estimate from the {scope.kind} page.
        </div>
      )}
      {restoredDraft && !savedAt && (
        <div className="flex items-center justify-between gap-2 rounded-md border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-sm" data-testid="draft-restored">
          <span>Restored an unsaved draft from this device — Save to keep it.</span>
          <button
            type="button"
            className="underline underline-offset-2"
            onClick={() => {
              pushHistory(facets);
              setFacets([]);
              setRestoredDraft(false);
              try { window.localStorage.removeItem(draftKey); } catch { /* non-fatal */ }
            }}
          >
            Discard
          </button>
        </div>
      )}

      <div className="flex flex-wrap gap-4">
        {/* Canvas */}
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            {modeBtn("draw", "✏️ Draw")}
            {modeBtn("select", "☝︎ Select")}
            {modeBtn("edges", "▬ Edges")}
            {modeBtn("pan", "✋ Pan")}
            {modeBtn("calibrate", "📏 Calibrate")}
            <span className="mx-1 h-5 w-px bg-border" />
            <div className="flex items-center gap-1 text-sm text-muted-foreground">
              <Button size="sm" variant="outline" onClick={() => applyZoom(1 / 1.3, { x: CANVAS / 2, y: CANVAS / 2 })} aria-label="Zoom out" data-testid="zoom-out">
                −
              </Button>
              <span className="w-12 text-center tabular-nums" data-testid="zoom-readout">
                ×{(Math.pow(2, zoom - DEFAULT_ZOOM) * viewScale).toFixed(1)}
              </span>
              <Button size="sm" variant="outline" onClick={() => applyZoom(1.3, { x: CANVAS / 2, y: CANVAS / 2 })} aria-label="Zoom in" data-testid="zoom-in">
                +
              </Button>
              <span className="ml-1 hidden sm:inline text-xs">scroll / pinch to zoom</span>
            </div>
            {(view.x !== 0 || view.y !== 0 || viewScale !== 1) && (
              <Button size="sm" variant="outline" onClick={() => { setView({ x: 0, y: 0 }); setViewScale(1); }}>
                Re-center
              </Button>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
            {mode === "draw" && (
              <>
                <label className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={angleSnap}
                    onChange={(e) => setAngleSnap(e.target.checked)}
                    data-testid="angle-snap-toggle"
                  />
                  Snap to 90°/45° (hold ⌥ to bypass)
                </label>
                <span>Click corners · click the first corner or press Enter to close · Esc cancels</span>
              </>
            )}
            {mode === "edges" && <span>Pick a type on the right, then click edges</span>}
            {mode === "pan" && <span>Drag the map to move around · Re-center returns to the property</span>}
            {mode === "calibrate" && (
              <span>Click both ends of something with a known length (driveway, fence line…)</span>
            )}
            {calibration !== 1 && (
              <span>
                Scale ×{calibration.toFixed(3)}{" "}
                <button type="button" className="underline underline-offset-2" onClick={resetCalibration}>
                  reset
                </button>
              </span>
            )}
          </div>

          <div
            className="relative overflow-hidden rounded-lg border border-border"
            style={{ width: CANVAS, height: CANVAS }}
          >
            {mapUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={mapUrl}
                alt="Aerial view"
                width={CANVAS}
                height={CANVAS}
                className="absolute inset-0 select-none"
                style={{ transform: `translate(${panPx.dx}px, ${panPx.dy}px) scale(${viewScale})`, transformOrigin: "center" }}
                draggable={false}
              />
            ) : (
              <div className="absolute inset-0 grid place-items-center bg-muted/30 p-6 text-center text-sm text-muted-foreground">
                Google Maps API key missing — drawing works, but no aerial image. Set
                NEXT_PUBLIC_GOOGLE_MAPS_API_KEY.
              </div>
            )}
            <svg
              ref={svgRef}
              width={CANVAS}
              height={CANVAS}
              className="absolute inset-0 touch-none outline-none"
              style={{ cursor }}
              tabIndex={0}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerUp}
              onPointerLeave={(e) => { pointers.current.delete(e.pointerId); setCursorPx(null); setSnap(null); }}
              onWheel={handleWheel}
              onDoubleClick={() => { if (mode === "draw") closeDraft(); }}
              onKeyDown={handleKeyDown}
              data-testid="sketch-canvas"
            >
              <g transform={`translate(${panPx.dx},${panPx.dy})`}>
                {/* Facets */}
                {facets.map((f) => {
                  const pts = f.points.map(toPx);
                  const selected = f.id === selectedFacetId;
                  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
                  const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
                  const surface = planAreaSqFt(f.points) * pitchFactor(f.pitch);
                  return (
                    <g key={f.id}>
                      <polygon
                        points={pts.map((p) => `${p.x},${p.y}`).join(" ")}
                        fill={selected ? "rgba(216,168,95,0.25)" : "rgba(255,255,255,0.12)"}
                        stroke="none"
                      />
                      {pts.map((a, i) => {
                        const b = pts[(i + 1) % pts.length]!;
                        const type = f.edges[i] ?? "unspecified";
                        const lenFt = edgeLengthFt(f.points[i]!, f.points[(i + 1) % f.points.length]!);
                        const mx = (a.x + b.x) / 2;
                        const my = (a.y + b.y) / 2;
                        return (
                          <g key={i}>
                            <line
                              x1={a.x}
                              y1={a.y}
                              x2={b.x}
                              y2={b.y}
                              stroke={SKETCH_EDGE_COLORS[type]}
                              strokeWidth={3}
                              strokeDasharray={
                                type === "wall_flashing" || type === "step_flashing" ? "6 4" : undefined
                              }
                            />
                            {lenFt >= 4 && (
                              <text
                                x={mx}
                                y={my - 4}
                                fontSize={10}
                                fill="#fff"
                                stroke="rgba(0,0,0,0.7)"
                                strokeWidth={2.5}
                                paintOrder="stroke"
                                textAnchor="middle"
                              >
                                {fmtFt(lenFt)}
                              </text>
                            )}
                          </g>
                        );
                      })}
                      {mode === "select" &&
                        pts.map((p, i) => (
                          <circle
                            key={i}
                            cx={p.x}
                            cy={p.y}
                            r={4.5}
                            fill="#fff"
                            stroke="#333"
                            strokeWidth={1.5}
                          />
                        ))}
                      <text
                        x={cx}
                        y={cy}
                        fontSize={12}
                        fontWeight={600}
                        fill="#fff"
                        stroke="rgba(0,0,0,0.75)"
                        strokeWidth={3}
                        paintOrder="stroke"
                        textAnchor="middle"
                      >
                        {f.pitch === "0/12" ? "Flat" : f.pitch}
                      </text>
                      <text
                        x={cx}
                        y={cy + 14}
                        fontSize={11}
                        fill="#fff"
                        stroke="rgba(0,0,0,0.75)"
                        strokeWidth={2.5}
                        paintOrder="stroke"
                        textAnchor="middle"
                      >
                        {Math.round(surface)} sqft
                      </text>
                    </g>
                  );
                })}

                {/* Draft polygon */}
                {draft.length > 0 && (
                  <g>
                    <polyline
                      points={[...draft.map(toPx), ...(hover && mode === "draw" ? [toPx(hover)] : [])]
                        .map((p) => `${p.x},${p.y}`)
                        .join(" ")}
                      fill="none"
                      stroke="#4fc3f7"
                      strokeWidth={2}
                      strokeDasharray="5 4"
                    />
                    {draft.map((p, i) => {
                      const px = toPx(p);
                      return (
                        <circle
                          key={i}
                          cx={px.x}
                          cy={px.y}
                          r={i === 0 ? 6 : 4}
                          fill={i === 0 ? "#4fc3f7" : "#fff"}
                          stroke="#0369a1"
                          strokeWidth={1.5}
                        />
                      );
                    })}
                    {hover && mode === "draw" && draft.length > 0 && (
                      <text
                        x={(toPx(draft[draft.length - 1]!).x + toPx(hover).x) / 2}
                        y={(toPx(draft[draft.length - 1]!).y + toPx(hover).y) / 2 - 6}
                        fontSize={11}
                        fill="#fff"
                        stroke="rgba(0,0,0,0.75)"
                        strokeWidth={2.5}
                        paintOrder="stroke"
                        textAnchor="middle"
                      >
                        {fmtFt(edgeLengthFt(draft[draft.length - 1]!, hover))}
                      </text>
                    )}
                  </g>
                )}

                {/* Calibration line */}
                {mode === "calibrate" && calPoints.length > 0 && (
                  <g>
                    {(() => {
                      const a = toPx(calPoints[0]!);
                      const b =
                        calPoints.length === 2
                          ? toPx(calPoints[1]!)
                          : hover
                            ? toPx(hover)
                            : null;
                      return (
                        <>
                          <circle cx={a.x} cy={a.y} r={5} fill="#fff" stroke="#e11d48" strokeWidth={2} />
                          {b && (
                            <>
                              <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#e11d48" strokeWidth={2.5} strokeDasharray="7 4" />
                              <circle cx={b.x} cy={b.y} r={5} fill="#fff" stroke="#e11d48" strokeWidth={2} />
                              <text
                                x={(a.x + b.x) / 2}
                                y={(a.y + b.y) / 2 - 8}
                                fontSize={12}
                                fontWeight={600}
                                fill="#fff"
                                stroke="rgba(0,0,0,0.75)"
                                strokeWidth={3}
                                paintOrder="stroke"
                                textAnchor="middle"
                              >
                                {fmtFt(
                                  edgeLengthFt(
                                    calPoints[0]!,
                                    calPoints.length === 2 ? calPoints[1]! : hover!,
                                  ),
                                )}
                              </text>
                            </>
                          )}
                        </>
                      );
                    })()}
                  </g>
                )}

                {/* Snap indicator: highlights the vertex/edge the next point will snap to. */}
                {snap && (() => {
                  const p = toPx(snap.point);
                  return (
                    <g data-testid="snap-indicator" data-snap-kind={snap.kind}>
                      <circle cx={p.x} cy={p.y} r={8} fill="none" stroke="#f5c451" strokeWidth={2} />
                      {snap.kind === "vertex" ? (
                        <circle cx={p.x} cy={p.y} r={2.5} fill="#f5c451" />
                      ) : (
                        <rect x={p.x - 2.5} y={p.y - 2.5} width={5} height={5} fill="#f5c451" transform={`rotate(45 ${p.x} ${p.y})`} />
                      )}
                    </g>
                  );
                })()}

                {/* Close-ready ring on the first draft vertex (Enter / double-click / click also close). */}
                {mode === "draw" && cursorPx && canCloseDraft(toFt(cursorPx.x, cursorPx.y), draft, hitRadiusFt()) && (() => {
                  const p = toPx(draft[0]!);
                  return <circle data-testid="close-ring" cx={p.x} cy={p.y} r={10} fill="none" stroke="#4fc3f7" strokeWidth={2.5} />;
                })()}
              </g>
            </svg>

            {/* Magnifier loupe: appears near the cursor when a vertex/edge is within snap
                distance, centered on the snap target for pixel-precise placement. */}
            {mapUrl && snap && cursorPx && (() => {
              const LOUPE = 128;
              const MAG = 2.4;
              const mapOriginX = (CANVAS / 2) * (1 - viewScale) + panPx.dx;
              const mapOriginY = (CANVAS / 2) * (1 - viewScale) + panPx.dy;
              const sp = toPx(snap.point);
              const bgX = (sp.x - mapOriginX) / viewScale;
              const bgY = (sp.y - mapOriginY) / viewScale;
              const size = CANVAS * viewScale * MAG;
              let left = cursorPx.x - LOUPE - 16;
              if (left < 4) left = Math.min(cursorPx.x + 16, CANVAS - LOUPE - 4);
              let top = cursorPx.y - LOUPE - 16;
              if (top < 4) top = Math.min(cursorPx.y + 16, CANVAS - LOUPE - 4);
              return (
                <div
                  data-testid="loupe"
                  className="pointer-events-none absolute overflow-hidden rounded-full border-2 border-white shadow-lg"
                  style={{
                    width: LOUPE,
                    height: LOUPE,
                    left,
                    top,
                    backgroundImage: `url(${mapUrl})`,
                    backgroundRepeat: "no-repeat",
                    backgroundSize: `${size}px ${size}px`,
                    backgroundPosition: `${LOUPE / 2 - bgX * viewScale * MAG}px ${LOUPE / 2 - bgY * viewScale * MAG}px`,
                  }}
                >
                  <div className="absolute left-1/2 top-0 h-full w-px -translate-x-1/2 bg-[#f5c451]/70" />
                  <div className="absolute left-0 top-1/2 h-px w-full -translate-y-1/2 bg-[#f5c451]/70" />
                  <div className="absolute left-1/2 top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-[#f5c451]" />
                </div>
              );
            })()}
          </div>
        </div>

        {/* Right rail */}
        <div className="w-72 space-y-4">
          {mode === "calibrate" && (
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Scale calibration</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                {calPoints.length < 2 ? (
                  <p className="text-muted-foreground">
                    Click both ends of a feature whose real length you know — a driveway width, fence
                    run, or an eave you&apos;ve tape-measured. ({calPoints.length}/2 points)
                  </p>
                ) : (
                  <>
                    <div className="text-muted-foreground">
                      Drawn length: <span className="font-medium text-foreground">{fmtFt(measuredCal!)}</span>
                    </div>
                    <label className="block">
                      <span className="text-muted-foreground">True length (ft)</span>
                      <input
                        type="number"
                        min={1}
                        step="0.1"
                        value={calInput}
                        onChange={(e) => setCalInput(e.target.value)}
                        className="mt-1 w-full rounded-md border border-border bg-transparent px-2 py-1.5 text-sm"
                        placeholder={measuredCal!.toFixed(1)}
                        data-testid="calibration-input"
                      />
                    </label>
                    <div className="flex gap-2">
                      <Button size="sm" onClick={applyCalibration} disabled={!parseFloat(calInput)} data-testid="calibration-apply">
                        Apply
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => { setCalPoints([]); setCalInput(""); }}>
                        Redo line
                      </Button>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      All drawn geometry is rescaled to match. Undo history clears on apply.
                    </p>
                  </>
                )}
                {calibration !== 1 && (
                  <div className="border-t border-border pt-2 text-xs text-muted-foreground">
                    Current correction: ×{calibration.toFixed(4)}{" "}
                    <button type="button" className="underline underline-offset-2" onClick={resetCalibration}>
                      Reset to imagery scale
                    </button>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {mode === "edges" && (
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Edge types</CardTitle>
              </CardHeader>
              <CardContent className="space-y-1">
                {SKETCH_EDGE_TYPES.map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setEdgeTool(t)}
                    className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors ${
                      edgeTool === t ? "bg-muted font-medium" : "hover:bg-muted/50"
                    }`}
                    data-testid={`edge-tool-${t}`}
                  >
                    <span
                      className="inline-block h-1 w-6 rounded"
                      style={{
                        background: SKETCH_EDGE_COLORS[t],
                        ...(t === "wall_flashing" || t === "step_flashing"
                          ? { backgroundImage: `repeating-linear-gradient(90deg, ${SKETCH_EDGE_COLORS[t]} 0 4px, transparent 4px 7px)` }
                          : {}),
                      }}
                    />
                    {SKETCH_EDGE_LABELS[t]}
                  </button>
                ))}
                <div className="border-t border-border pt-2">
                  <Button
                    size="sm"
                    variant="outline"
                    className="w-full"
                    onClick={applyEdgeSuggestions}
                    data-testid="suggest-edge-types"
                  >
                    Suggest types (unset edges)
                  </Button>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Shared edges → ridge, others → eave. Only fills unset edges; confirm &amp; refine.
                  </p>
                </div>
              </CardContent>
            </Card>
          )}

          {mode === "select" && selectedFacet && (
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Facet</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <label className="block text-sm">
                  <span className="text-muted-foreground">Pitch</span>
                  <select
                    value={selectedFacet.pitch}
                    onChange={(e) => setFacetPitch(selectedFacet.id, e.target.value)}
                    className="mt-1 w-full rounded-md border border-border bg-transparent px-2 py-1.5 text-sm"
                    data-testid="facet-pitch-select"
                  >
                    {PITCH_OPTIONS.map((p) => (
                      <option key={p} value={p}>
                        {p === "0/12" ? "0/12 (flat)" : p}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block text-sm">
                  <span className="text-muted-foreground">Label</span>
                  <select
                    value={selectedFacet.label}
                    onChange={(e) =>
                      setFacetLabel(selectedFacet.id, e.target.value as SketchFacet["label"])
                    }
                    className="mt-1 w-full rounded-md border border-border bg-transparent px-2 py-1.5 text-sm"
                  >
                    <option value="none">None</option>
                    <option value="dormer">Dormer</option>
                    <option value="two_story">Two story</option>
                    <option value="two_layer">Two layer</option>
                  </select>
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={selectedFacet.ventilated}
                    onChange={(e) => setFacetVentilated(selectedFacet.id, e.target.checked)}
                    data-testid="facet-ventilated-toggle"
                  />
                  <span className="text-muted-foreground">Counts toward ventilation</span>
                </label>
                <div className="text-sm text-muted-foreground">
                  Plan {Math.round(planAreaSqFt(selectedFacet.points))} sqft · Surface{" "}
                  {Math.round(planAreaSqFt(selectedFacet.points) * pitchFactor(selectedFacet.pitch))}{" "}
                  sqft
                </div>
                <Button size="sm" variant="outline" onClick={() => deleteFacet(selectedFacet.id)}>
                  Delete facet
                </Button>
              </CardContent>
            </Card>
          )}

          {/* Live totals */}
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Measurements</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="space-y-1 text-sm">
                <Row k="Total area" v={`${Math.round(summary.totalSurfaceSqft)} sqft`} strong />
                <Row k="Squares" v={summary.squares.toFixed(1)} strong />
                <Row k="Facets" v={String(summary.facetCount)} />
                {summary.sharedEdgeCount > 0 && (
                  <Row k="Shared edges (counted once)" v={String(summary.sharedEdgeCount)} />
                )}
                <Row k="Predominant pitch" v={summary.predominantPitch} />
                <Row k="Pitched / flat" v={`${Math.round(summary.pitchedSqft)} / ${Math.round(summary.flatSqft)} sqft`} />
                <Row k="Plan (footprint)" v={`${Math.round(summary.totalPlanSqft)} sqft`} />
                {summary.totalPlanSqft > 0 && (
                  <Row k="Required NFA" v={`${vent.requiredNfaSqft.toFixed(1)} sqft`} />
                )}
                {SKETCH_EDGE_TYPES.filter((t) => summary.edgeLf[t] > 0).map((t) => (
                  <Row
                    key={t}
                    k={SKETCH_EDGE_LABELS[t]}
                    v={fmtFt(summary.edgeLf[t])}
                    swatch={SKETCH_EDGE_COLORS[t]}
                  />
                ))}
              </dl>
            </CardContent>
          </Card>

          {/* Waste table */}
          {summary.totalSurfaceSqft > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Waste factors</CardTitle>
              </CardHeader>
              <CardContent>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                      <th className="py-1 font-medium">Waste</th>
                      <th className="py-1 font-medium">Area</th>
                      <th className="py-1 font-medium">Squares</th>
                    </tr>
                  </thead>
                  <tbody>
                    {waste.map((w) => (
                      <tr key={w.pct} className="border-t border-border">
                        <td className="py-1">{w.pct}%</td>
                        <td className="py-1">{w.sqft.toLocaleString()} sqft</td>
                        <td className="py-1">{w.squares}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

function Row({ k, v, strong, swatch }: { k: string; v: string; strong?: boolean; swatch?: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <dt className="flex items-center gap-1.5 text-muted-foreground">
        {swatch && <span className="inline-block h-1 w-4 rounded" style={{ background: swatch }} />}
        {k}
      </dt>
      <dd className={strong ? "font-semibold" : undefined}>{v}</dd>
    </div>
  );
}

/** Distance from point p to segment ab, in feet. */
function distToSegmentFt(p: SketchPoint, a: SketchPoint, b: SketchPoint): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const len2 = abx * abx + aby * aby;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * abx), p.y - (a.y + t * aby));
}
