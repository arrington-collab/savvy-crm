import type { StormSwath } from "@savvy/integrations";

// New-storm alerts: a daily cron checks each tenant's canvassing areas for
// verified storms that landed in the last ALERT_WINDOW_HOURS and emails the
// owners/admins — nobody should have to remember to open the map to learn a
// microburst hit their turf yesterday.

export const ALERT_WINDOW_HOURS = 48;
export const MAX_CENTERS = 3;

/** Cluster knock points to up to MAX_CENTERS operating centers (~50 km grid). */
export function clusterKnockCenters(points: { lat: number; lng: number }[]): { lat: number; lng: number }[] {
  const cells = new Map<string, { lat: number; lng: number; n: number }>();
  for (const p of points) {
    const key = `${Math.round(p.lat * 2) / 2},${Math.round(p.lng * 2) / 2}`;
    const c = cells.get(key) ?? { lat: 0, lng: 0, n: 0 };
    cells.set(key, { lat: c.lat + p.lat, lng: c.lng + p.lng, n: c.n + 1 });
  }
  return [...cells.values()]
    .sort((a, b) => b.n - a.n)
    .slice(0, MAX_CENTERS)
    .map((c) => ({ lat: c.lat / c.n, lng: c.lng / c.n }));
}

/** Stable signature so the same event never alerts twice. */
export function swathSignature(s: StormSwath): string {
  return `${s.kind}:${s.date.slice(0, 10)}:${s.kind === "hail" ? (s.size ?? 0) : (s.windMph ?? 0)}`;
}

/** Swaths dated within the alert window whose signature hasn't been seen. */
export function newAlertSwaths(swaths: StormSwath[], seen: string[], now = new Date()): StormSwath[] {
  const cutoff = now.getTime() - ALERT_WINDOW_HOURS * 3_600_000;
  const seenSet = new Set(seen);
  const out: StormSwath[] = [];
  const dedup = new Set<string>();
  for (const s of swaths) {
    const ts = Date.parse(s.date);
    if (!Number.isFinite(ts) || ts < cutoff) continue;
    const sig = swathSignature(s);
    if (seenSet.has(sig) || dedup.has(sig)) continue;
    dedup.add(sig);
    out.push(s);
  }
  return out;
}

export function alertEmailHtml(companyName: string, events: { kind: string; mag: string; date: string }[]): string {
  const rows = events.map((e) => `<li><b>${e.kind === "hail" ? "⛈ Hail" : "💨 Wind"} — ${e.mag}</b> · ${e.date}</li>`).join("");
  return `<p>New verified storm activity near ${companyName}'s canvassing area in the last ${ALERT_WINDOW_HOURS} hours:</p><ul>${rows}</ul><p>Open the Canvass app and tap ⛈ on the map to see the swaths and target zones.</p>`;
}
