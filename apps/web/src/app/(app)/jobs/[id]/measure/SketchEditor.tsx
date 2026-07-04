"use client";

import { useCallback, useMemo, useRef, useState, useTransition } from "react";
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
  wasteTable,
  type RoofSketch,
  type SketchFacet,
  type SketchEdgeType,
  type SketchPoint,
} from "@savvy/core";
import { saveSketchMeasurementAction } from "@/lib/measurement-actions";

/** Canvas size in CSS px. The static map is requested as MAP_PX map-pixels
 *  (scale=2 for retina), so 1 CSS px == MAP_PX / CANVAS px of map. */
const CANVAS = 640;
const MAP_PX = 640;
const SNAP_PX = 10;
const DEFAULT_ZOOM = 20;

type Mode = "draw" | "select" | "edges";

interface SketchEditorProps {
  jobId: string;
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

let facetSeq = 0;
function newFacetId(): string {
  facetSeq += 1;
  return `facet-${Date.now()}-${facetSeq}`;
}

export function SketchEditor({
  jobId,
  measurementId,
  address,
  lat,
  lng,
  mapsApiKey,
  initialSketch,
}: SketchEditorProps) {
  const router = useRouter();
  const centerLat = initialSketch?.centerLat ?? lat ?? 33.4484;
  const centerLng = initialSketch?.centerLng ?? lng ?? -112.074;
  const [zoom, setZoom] = useState<number>(initialSketch?.zoom ?? DEFAULT_ZOOM);

  const [facets, setFacets] = useState<SketchFacet[]>(initialSketch?.facets ?? []);
  const [history, setHistory] = useState<SketchFacet[][]>([]);
  const [future, setFuture] = useState<SketchFacet[][]>([]);

  const [mode, setMode] = useState<Mode>("draw");
  const [draft, setDraft] = useState<SketchPoint[]>([]);
  const [hover, setHover] = useState<SketchPoint | null>(null);
  const [selectedFacetId, setSelectedFacetId] = useState<string | null>(null);
  const [edgeTool, setEdgeTool] = useState<SketchEdgeType>("eave");
  const [drag, setDrag] = useState<{ facetId: string; vertexIdx: number } | null>(null);
  const [savePending, startSave] = useTransition();
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedMeasurementId, setSavedMeasurementId] = useState<string | null>(measurementId);

  const svgRef = useRef<SVGSVGElement>(null);

  // ft per CSS pixel at this zoom. Map covers MAP_PX map-pixels shown in CANVAS css px.
  const ftPerPx = useMemo(
    () => (feetPerMapPixel(centerLat, zoom) * MAP_PX) / CANVAS,
    [centerLat, zoom],
  );

  const toFt = useCallback(
    (px: number, py: number): SketchPoint => ({
      x: (px - CANVAS / 2) * ftPerPx,
      y: (py - CANVAS / 2) * ftPerPx,
    }),
    [ftPerPx],
  );
  const toPx = useCallback(
    (p: SketchPoint): { x: number; y: number } => ({
      x: p.x / ftPerPx + CANVAS / 2,
      y: p.y / ftPerPx + CANVAS / 2,
    }),
    [ftPerPx],
  );

  const mapUrl = useMemo(() => {
    if (!mapsApiKey) return null;
    const loc = `${centerLat},${centerLng}`;
    return (
      `https://maps.googleapis.com/maps/api/staticmap?center=${encodeURIComponent(loc)}` +
      `&zoom=${zoom}&size=${MAP_PX}x${MAP_PX}&scale=2&maptype=satellite&key=${mapsApiKey}`
    );
  }, [mapsApiKey, centerLat, centerLng, zoom]);

  const sketch: RoofSketch = useMemo(
    () => ({ version: 1, centerLat, centerLng, zoom, facets }),
    [centerLat, centerLng, zoom, facets],
  );
  const summary = useMemo(() => summarizeSketch(sketch), [sketch]);
  const waste = useMemo(() => wasteTable(summary.totalSurfaceSqft), [summary]);
  const selectedFacet = facets.find((f) => f.id === selectedFacetId) ?? null;

  const pushHistory = useCallback((prev: SketchFacet[]) => {
    setHistory((h) => [...h.slice(-49), prev]);
    setFuture([]);
  }, []);

  function undo() {
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

  function svgPoint(e: React.PointerEvent): { x: number; y: number } {
    const rect = svgRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  /** Snap a CSS-px point to any existing vertex (draft or facets) within SNAP_PX. */
  function snap(px: { x: number; y: number }): { x: number; y: number } {
    const candidates: { x: number; y: number }[] = [
      ...draft.map(toPx),
      ...facets.flatMap((f) => f.points.map(toPx)),
    ];
    for (const c of candidates) {
      if (Math.hypot(c.x - px.x, c.y - px.y) <= SNAP_PX) return c;
    }
    return px;
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
      },
    ]);
    setDraft([]);
    setHover(null);
  }

  function handlePointerDown(e: React.PointerEvent) {
    const raw = svgPoint(e);

    if (mode === "draw") {
      // Close when clicking the first draft vertex.
      if (draft.length >= 3) {
        const first = toPx(draft[0]!);
        if (Math.hypot(first.x - raw.x, first.y - raw.y) <= SNAP_PX) {
          closeDraft();
          return;
        }
      }
      const snapped = snap(raw);
      setDraft((d) => [...d, toFt(snapped.x, snapped.y)]);
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

  function handlePointerMove(e: React.PointerEvent) {
    const raw = svgPoint(e);
    if (mode === "draw" && draft.length > 0) {
      const snapped = snap(raw);
      setHover(toFt(snapped.x, snapped.y));
    }
    if (drag) {
      const d = drag;
      const snapped = snap(raw);
      const ftp = toFt(snapped.x, snapped.y);
      setFacets((prev) =>
        prev.map((f) =>
          f.id === d.facetId
            ? { ...f, points: f.points.map((p, i) => (i === d.vertexIdx ? ftp : p)) }
            : f,
        ),
      );
    }
  }

  function handlePointerUp() {
    setDrag(null);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      setDraft([]);
      setHover(null);
      setSelectedFacetId(null);
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

  function handleSave() {
    setSaveError(null);
    startSave(async () => {
      const result = await saveSketchMeasurementAction({
        jobId,
        sketch,
        measurementId: savedMeasurementId,
      });
      if ("ok" in result) {
        setSavedMeasurementId(result.measurementId);
        setSavedAt(new Date());
        router.refresh();
      } else {
        setSaveError(result.error);
      }
    });
  }

  const modeBtn = (m: Mode, label: string) => (
    <Button
      key={m}
      size="sm"
      variant={mode === m ? "default" : "outline"}
      onClick={() => {
        setMode(m);
        setDraft([]);
        setHover(null);
      }}
      data-testid={`sketch-mode-${m}`}
    >
      {label}
    </Button>
  );

  return (
    <div className="space-y-4 p-6" data-testid="sketch-editor">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1">
          <Link href={`/jobs/${jobId}`} className="text-sm text-muted-foreground hover:underline">
            ← Back to job
          </Link>
          <h1 className="text-xl font-semibold">Roof sketch</h1>
          {address && <p className="text-sm text-muted-foreground">{address}</p>}
        </div>
        <div className="flex items-center gap-2">
          {savedMeasurementId && (
            <Link
              href={`/jobs/${jobId}/measure/report`}
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
      {savedAt && !saveError && (
        <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
          Measurement saved {savedAt.toLocaleTimeString()} — {summary.squares.toFixed(1)} squares,{" "}
          {summary.facetCount} facets. Generate an estimate from the job page.
        </div>
      )}

      <div className="flex flex-wrap gap-4">
        {/* Canvas */}
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            {modeBtn("draw", "✏️ Draw")}
            {modeBtn("select", "☝︎ Select")}
            {modeBtn("edges", "▬ Edges")}
            <span className="mx-1 h-5 w-px bg-border" />
            <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
              Zoom
              <select
                value={zoom}
                onChange={(e) => setZoom(parseInt(e.target.value, 10))}
                className="rounded-md border border-border bg-transparent px-1.5 py-1 text-sm"
              >
                {[19, 20, 21].map((z) => (
                  <option key={z} value={z}>
                    {z}
                  </option>
                ))}
              </select>
            </label>
            {mode === "draw" && (
              <span className="text-xs text-muted-foreground">
                Click to place corners · click the first corner or press Enter to close · Esc to cancel
              </span>
            )}
            {mode === "edges" && (
              <span className="text-xs text-muted-foreground">Pick a type, then click edges</span>
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
              style={{ cursor: mode === "draw" ? "crosshair" : "default" }}
              tabIndex={0}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onKeyDown={handleKeyDown}
              data-testid="sketch-canvas"
            >
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
                    points={[...draft.map(toPx), ...(hover ? [toPx(hover)] : [])]
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
                  {hover && draft.length > 0 && (
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
            </svg>
          </div>
        </div>

        {/* Right rail */}
        <div className="w-72 space-y-4">
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
                <Row k="Predominant pitch" v={summary.predominantPitch} />
                <Row k="Pitched / flat" v={`${Math.round(summary.pitchedSqft)} / ${Math.round(summary.flatSqft)} sqft`} />
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
