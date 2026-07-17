// Phase 20 S3 (#307/#308) — pure visit math. The condition score is a LABEL
// earned from zone grades (the same good/monitor/action calls the inspector
// made on-site), never an invented number; route batching is nearest-neighbor
// so neighbors share a visit day (Turf synergy without a routing engine).

export type ZoneGradeLite = { grade: string | null };

export interface RoofConditionScore {
  label: "good" | "watch" | "needs_attention" | "ungraded";
  counts: { good: number; monitor: number; action: number; ungraded: number };
}

export function computeRoofConditionScore(zones: ZoneGradeLite[]): RoofConditionScore {
  const counts = { good: 0, monitor: 0, action: 0, ungraded: 0 };
  for (const z of zones) {
    if (z.grade === "good") counts.good += 1;
    else if (z.grade === "monitor") counts.monitor += 1;
    else if (z.grade === "action") counts.action += 1;
    else counts.ungraded += 1;
  }
  const label = counts.action > 0 ? "needs_attention"
    : counts.monitor > 0 ? "watch"
    : counts.good > 0 ? "good"
    : "ungraded";
  return { label, counts };
}

export interface VisitCandidate {
  id: string;
  lat: number | null;
  lng: number | null;
}

/**
 * Nearest-neighbor route over geocoded members, chunked into per-day batches.
 * Ungeocoded members append at the end — scheduled, never dropped.
 */
export function orderVisitBatch<T extends VisitCandidate>(members: T[], visitsPerDay: number): T[][] {
  const geocoded = members.filter((m) => m.lat != null && m.lng != null);
  const ungeocoded = members.filter((m) => m.lat == null || m.lng == null);

  const route: T[] = [];
  const remaining = [...geocoded];
  let current = remaining.shift();
  while (current) {
    route.push(current);
    if (remaining.length === 0) break;
    let bestIdx = 0;
    let bestD = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const d = (remaining[i]!.lat! - current.lat!) ** 2 + (remaining[i]!.lng! - current.lng!) ** 2;
      if (d < bestD) { bestD = d; bestIdx = i; }
    }
    current = remaining.splice(bestIdx, 1)[0];
  }
  route.push(...ungeocoded);

  const days: T[][] = [];
  for (let i = 0; i < route.length; i += Math.max(1, visitsPerDay)) {
    days.push(route.slice(i, i + Math.max(1, visitsPerDay)));
  }
  return days;
}
