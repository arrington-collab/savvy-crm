import { startOfLocalDayInTimeZone } from "./tz";

// Quarter keys ("2026-Q3") are tenant-local civil quarters — the partner
// quarterly report cycle (Partner Ledger slice 5).

export function quarterKeyInTimeZone(now: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit" })
    .formatToParts(now);
  const year = Number(parts.find((p) => p.type === "year")!.value);
  const month = Number(parts.find((p) => p.type === "month")!.value);
  return `${year}-Q${Math.floor((month - 1) / 3) + 1}`;
}

export function priorQuarterKey(key: string): string {
  const year = Number(key.slice(0, 4));
  const q = Number(key.slice(6));
  return q === 1 ? `${year - 1}-Q4` : `${year}-Q${q - 1}`;
}

export type QuarterRange = { startCivil: string; endCivil: string; start: Date; end: Date };

/** A key's civil date range in the tenant's timezone — start inclusive, end exclusive. */
export function quarterRange(key: string, tz: string): QuarterRange {
  const year = Number(key.slice(0, 4));
  const q = Number(key.slice(6));
  const startMonth = (q - 1) * 3 + 1;
  const endYear = q === 4 ? year + 1 : year;
  const endMonth = q === 4 ? 1 : startMonth + 3;
  const startCivil = `${year}-${String(startMonth).padStart(2, "0")}-01`;
  const endCivil = `${endYear}-${String(endMonth).padStart(2, "0")}-01`;
  return {
    startCivil,
    endCivil,
    start: startOfLocalDayInTimeZone(startCivil, tz),
    end: startOfLocalDayInTimeZone(endCivil, tz),
  };
}
