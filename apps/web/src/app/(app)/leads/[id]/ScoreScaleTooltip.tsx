import type { ScoreBandLegendRow } from "@savvy/core";

/**
 * Slice 5: documents the 0–100 score scale in-app, on the score chip. CSS-only
 * hover/focus popover (server component) so it needs no client JS. The top
 * contributing factors are already listed as bullets under the score.
 */
export function ScoreScaleTooltip({ legend }: { legend: ScoreBandLegendRow[] }) {
  return (
    <span className="group relative inline-flex" data-testid="score-scale-info">
      <button
        type="button"
        aria-label="How the lead score works"
        className="inline-flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-semibold"
        style={{ background: "var(--surface-muted)", color: "var(--text-muted)" }}
      >
        ?
      </button>
      <span
        role="tooltip"
        className="pointer-events-none absolute left-0 top-6 z-10 hidden w-56 rounded-md border p-2 text-xs shadow-lg group-hover:block group-focus-within:block"
        style={{ background: "var(--surface)", borderColor: "var(--border)", color: "var(--text-body)" }}
      >
        <div className="mb-1 font-medium">Lead score · 0–100</div>
        <ul className="space-y-0.5">
          {legend.map((b) => (
            <li key={b.band} className="flex items-center justify-between">
              <span>{b.label}</span>
              <span className="mono" style={{ color: "var(--text-muted)" }}>
                {b.min}–{b.max}
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-1" style={{ color: "var(--text-faint)" }}>
          Top contributing factors are listed below.
        </p>
      </span>
    </span>
  );
}
