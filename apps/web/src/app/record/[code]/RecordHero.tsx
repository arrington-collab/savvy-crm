import type { RecordPageZone } from "@savvy/db";
import type { RoofSketch } from "@savvy/core";

// Grade palette — homeowner LIGHT family (deliberately not the console theme).
export const GRADE_FILL: Record<string, string> = {
  good: "#34d399",    // emerald-400
  monitor: "#fbbf24", // amber-400
  action: "#fb7185",  // rose-400
};
const UNGRADED_FILL = "#e7e5e4"; // stone-200

/**
 * The hero: their roof, facet polygons from the measurement geometry, colored
 * by the inspector's zone grades. Named (non-facet) zones render as chips
 * below. No sketch → the chips carry the whole story (aerial fallback later).
 */
export function RecordHero({ sketch, zones }: { sketch: RoofSketch | null; zones: RecordPageZone[] }) {
  const gradeByKey = new Map(zones.map((z) => [z.zoneKey, z.grade]));
  const facets = sketch?.facets ?? [];

  const pts = facets.flatMap((f) => f.points);
  const minX = Math.min(...pts.map((p) => p.x), 0);
  const minY = Math.min(...pts.map((p) => p.y), 0);
  const maxX = Math.max(...pts.map((p) => p.x), 100);
  const maxY = Math.max(...pts.map((p) => p.y), 100);
  const pad = Math.max((maxX - minX), (maxY - minY)) * 0.06;

  const namedZones = zones.filter((z) => !facets.some((f) => f.id === z.zoneKey));

  return (
    <div data-testid="record-hero">
      {facets.length > 0 ? (
        <svg
          viewBox={`${minX - pad} ${minY - pad} ${maxX - minX + pad * 2} ${maxY - minY + pad * 2}`}
          className="mx-auto w-full max-w-md drop-shadow-sm"
          role="img"
          aria-label="Your roof, zone by zone"
        >
          {facets.map((f) => {
            const grade = gradeByKey.get(f.id) ?? null;
            return (
              <polygon
                key={f.id}
                points={f.points.map((p) => `${p.x},${p.y}`).join(" ")}
                fill={grade ? GRADE_FILL[grade] ?? UNGRADED_FILL : UNGRADED_FILL}
                fillOpacity={0.85}
                stroke="#78716c"
                strokeWidth={Math.max((maxX - minX) / 220, 0.5)}
                strokeLinejoin="round"
                data-testid={`hero-facet-${f.id}`}
              />
            );
          })}
        </svg>
      ) : null}

      {namedZones.length > 0 ? (
        <div className="mt-4 flex flex-wrap justify-center gap-2" data-testid="hero-zone-chips">
          {namedZones.map((z) => (
            <span
              key={z.zoneKey}
              className="inline-flex items-center gap-1.5 rounded-full bg-white px-3 py-1 text-xs font-medium text-stone-600 ring-1 ring-stone-200"
            >
              <span
                aria-hidden
                className="h-2 w-2 rounded-full"
                style={{ backgroundColor: z.grade ? GRADE_FILL[z.grade] ?? UNGRADED_FILL : UNGRADED_FILL }}
              />
              {z.zoneLabel}
            </span>
          ))}
        </div>
      ) : null}

      <div className="mt-4 flex justify-center gap-4 text-[11px] text-stone-500">
        <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full" style={{ backgroundColor: GRADE_FILL.good }} /> Good</span>
        <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full" style={{ backgroundColor: GRADE_FILL.monitor }} /> Monitor</span>
        <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full" style={{ backgroundColor: GRADE_FILL.action }} /> Needs attention</span>
      </div>
    </div>
  );
}
