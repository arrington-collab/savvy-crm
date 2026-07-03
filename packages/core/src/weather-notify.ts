/** "2026-07-08" -> "Wed 7/8". Civil date is already tz-resolved, so format in UTC. */
export function formatShortDate(civilDate: string): string {
  const [y, m, d] = civilDate.split("-").map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  const wd = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "UTC" }).format(dt);
  return `${wd} ${m}/${d}`;
}

export function buildWeatherMoveHomeownerBody(i: { originalLabel: string; targetLabel: string; reason: string }): string {
  return `Heads up — weather (${i.reason}) is expected ${i.originalLabel}, so we've moved your roof install to ${i.targetLabel}. We'll be in touch as the day approaches.`;
}

export function buildWeatherMoveCrewBody(i: { address: string; originalLabel: string; targetLabel: string; reason: string }): string {
  return `Weather move: ${i.address} install → ${i.targetLabel} (was ${i.originalLabel} — ${i.reason}).`;
}
