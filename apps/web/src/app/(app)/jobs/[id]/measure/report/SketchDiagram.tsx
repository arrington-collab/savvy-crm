import {
  SKETCH_EDGE_COLORS,
  edgeLengthFt,
  planAreaSqFt,
  pitchFactor,
  type RoofSketch,
} from "@savvy/core";

/** Static SVG rendering of a roof sketch, scaled to fit — the report's
 *  diagram page (server component, print-friendly). */
export function SketchDiagram({ sketch }: { sketch: RoofSketch }) {
  const pts = sketch.facets.flatMap((f) => f.points);
  if (pts.length === 0) return null;

  const minX = Math.min(...pts.map((p) => p.x));
  const maxX = Math.max(...pts.map((p) => p.x));
  const minY = Math.min(...pts.map((p) => p.y));
  const maxY = Math.max(...pts.map((p) => p.y));
  const pad = 12; // feet
  const w = maxX - minX + pad * 2;
  const h = maxY - minY + pad * 2;
  const W = 680;
  const H = Math.max(240, Math.min(560, (W * h) / w));
  const s = Math.min(W / w, H / h);
  const tx = (x: number) => (x - minX + pad) * s;
  const ty = (y: number) => (y - minY + pad) * s;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="w-full rounded-md border border-border bg-white"
      role="img"
      aria-label="Roof diagram"
    >
      {sketch.facets.map((f) => {
        const poly = f.points.map((p) => `${tx(p.x)},${ty(p.y)}`).join(" ");
        const cx = f.points.reduce((sum, p) => sum + tx(p.x), 0) / f.points.length;
        const cy = f.points.reduce((sum, p) => sum + ty(p.y), 0) / f.points.length;
        const surface = Math.round(planAreaSqFt(f.points) * pitchFactor(f.pitch));
        return (
          <g key={f.id}>
            <polygon points={poly} fill="rgba(0,0,0,0.03)" stroke="none" />
            {f.points.map((a, i) => {
              const b = f.points[(i + 1) % f.points.length]!;
              const type = f.edges[i] ?? "unspecified";
              const lenFt = edgeLengthFt(a, b);
              return (
                <g key={i}>
                  <line
                    x1={tx(a.x)}
                    y1={ty(a.y)}
                    x2={tx(b.x)}
                    y2={ty(b.y)}
                    stroke={SKETCH_EDGE_COLORS[type]}
                    strokeWidth={2.5}
                    strokeDasharray={
                      type === "wall_flashing" || type === "step_flashing" ? "6 4" : undefined
                    }
                  />
                  {lenFt >= 6 && (
                    <text
                      x={(tx(a.x) + tx(b.x)) / 2}
                      y={(ty(a.y) + ty(b.y)) / 2 - 4}
                      fontSize={10}
                      fill="#333"
                      textAnchor="middle"
                    >
                      {Math.round(lenFt)}
                    </text>
                  )}
                </g>
              );
            })}
            <text x={cx} y={cy} fontSize={12} fontWeight={600} fill="#111" textAnchor="middle">
              {f.pitch === "0/12" ? "Flat" : f.pitch}
            </text>
            <text x={cx} y={cy + 13} fontSize={10} fill="#444" textAnchor="middle">
              {surface} sqft
            </text>
          </g>
        );
      })}
    </svg>
  );
}
