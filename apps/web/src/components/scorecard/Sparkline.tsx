// D4-7: tiny inline 13-week trend line for the EOS scorecard. No chart
// library — one polyline (or several, split at gaps) in a hand-rolled SVG.
// `values` is oldest→newest, always meant to be exactly 13 entries (the
// shape `ScorecardRow.priorWeeks` produces), but this component doesn't
// assume a fixed length — it just plots whatever it's given.

const WIDTH = 100;
const HEIGHT = 28;
const PAD_Y = 3;

/**
 * Pure geometry: converts a `(number|null)[]` into one SVG `<polyline
 * points="...">` string per contiguous run of non-null values, so a `null`
 * (a pending/missing week — §7) renders as a visual gap in the line rather
 * than an interpolated lie connecting two unrelated weeks. Returns `[]` when
 * every entry is null (or the array is empty) — the caller renders the
 * muted "—" fallback instead of an empty, misleading `<svg>`.
 *
 * Exported (not just used internally) so it can be unit-tested without
 * needing a DOM/jsdom renderer — this repo's vitest runs in "node".
 */
export function buildSparklineSegments(values: (number | null)[]): string[] {
  const nonNull = values.filter((v): v is number => v !== null);
  if (nonNull.length === 0) return [];

  const min = Math.min(...nonNull);
  const max = Math.max(...nonNull);
  const range = max - min;

  const n = values.length;
  const xStep = n > 1 ? WIDTH / (n - 1) : 0;

  const yFor = (v: number): number => {
    // Flat line centered in the frame when every value is identical (range
    // 0 would otherwise divide by zero) — a real, meaningful shape, not an error.
    if (range === 0) return HEIGHT / 2;
    const t = (v - min) / range;
    return HEIGHT - PAD_Y - t * (HEIGHT - PAD_Y * 2);
  };

  const segments: string[] = [];
  let current: string[] = [];
  values.forEach((v, i) => {
    if (v === null) {
      if (current.length > 0) {
        segments.push(current.join(" "));
        current = [];
      }
      return;
    }
    current.push(`${(i * xStep).toFixed(2)},${yFor(v).toFixed(2)}`);
  });
  if (current.length > 0) segments.push(current.join(" "));
  return segments;
}

/**
 * 13-week trend sparkline. Renders a muted "—" (never an empty/broken chart)
 * when there's nothing to plot yet.
 */
export function Sparkline({ values }: { values: (number | null)[] }) {
  const segments = buildSparklineSegments(values);

  if (segments.length === 0) {
    return (
      <span style={{ color: "var(--text-faint)" }} data-testid="sparkline-empty">
        —
      </span>
    );
  }

  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      width={WIDTH}
      height={HEIGHT}
      role="img"
      aria-label="13-week trend"
      data-testid="sparkline"
    >
      {segments.map((points, i) => (
        <polyline
          key={i}
          points={points}
          fill="none"
          stroke="var(--accent-gold)"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </svg>
  );
}
