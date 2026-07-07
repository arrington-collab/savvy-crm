/** Measurement provenance precedence (6b): ordered Roofr > uploaded report > DIY sketch. */

export type MeasurementSource = "ordered" | "uploaded_report" | "sketch";

export const MEASUREMENT_SOURCE_RANK: Record<string, number> = {
  ordered: 3,
  uploaded_report: 2,
  sketch: 1,
};

/**
 * Pick the preferred measurement: highest source rank wins; ties break to the
 * newest createdAt. Unknown/null sources rank 0 (below sketch). Returns null for []
 */
export function selectPreferredMeasurement<T extends { source: string | null; createdAt: Date }>(
  rows: T[],
): T | null {
  if (rows.length === 0) return null;
  return rows.reduce((best, cur) => {
    const bestRank = MEASUREMENT_SOURCE_RANK[best.source ?? ""] ?? 0;
    const curRank = MEASUREMENT_SOURCE_RANK[cur.source ?? ""] ?? 0;
    if (curRank > bestRank) return cur;
    if (curRank === bestRank && cur.createdAt > best.createdAt) return cur;
    return best;
  });
}
