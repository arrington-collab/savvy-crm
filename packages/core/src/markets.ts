// Market clocks (tenant.settings.markets): the top bar shows local time for
// every market the tenant operates in — e.g. Bloom in AZ, Northwind in CO. Config
// only; growing into a new market is a settings edit, not a code change.
// Settings are hostile input (client-editable JSON), so entries are validated
// hard: a bad timezone must die here, never reach Intl at render time.

export interface Market {
  label: string;
  timezone: string; // IANA, e.g. "America/Phoenix"
}

const MAX_MARKETS = 6;
const MAX_LABEL = 13;

function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function parseMarkets(raw: unknown): Market[] {
  if (!Array.isArray(raw)) return [];
  const out: Market[] = [];
  for (const entry of raw) {
    if (out.length >= MAX_MARKETS) break;
    const e = (entry ?? {}) as Record<string, unknown>;
    const label = typeof e.label === "string" ? e.label.trim().slice(0, MAX_LABEL).trim() : "";
    const timezone = typeof e.timezone === "string" ? e.timezone.trim() : "";
    if (!label || !timezone || !isValidTimezone(timezone)) continue;
    out.push({ label, timezone });
  }
  return out;
}
