import { z } from "./schemas";

const weatherSchema = z.object({
  enabled: z.boolean().default(true),
  maxWindMph: z.number().int().positive().default(25),
  maxPrecipPct: z.number().int().min(0).max(100).default(60),
  lookAheadDays: z.number().int().min(1).max(30).default(7),
  autoReschedule: z.boolean().default(true),
});
export type WeatherConfig = z.infer<typeof weatherSchema>;
export function parseWeatherConfig(raw: unknown): WeatherConfig {
  return weatherSchema.parse(raw ?? {});
}

/** Pure risk rule for one day's forecast against a tenant's thresholds. */
export function assessWeatherRisk(
  day: { maxWindMph: number; precipProbability: number },
  cfg: WeatherConfig,
): { atRisk: boolean; reason: string } {
  const reasons: string[] = [];
  if (day.precipProbability >= cfg.maxPrecipPct) reasons.push(`Rain ${day.precipProbability}%`);
  if (day.maxWindMph >= cfg.maxWindMph) reasons.push(`Wind ${day.maxWindMph}mph`);
  return { atRisk: reasons.length > 0, reason: reasons.join(", ") };
}

/** Earliest safe, crew-free forecast day strictly after the original date, or null. */
export function pickRescheduleSlot(input: {
  days: { date: string; maxWindMph: number; precipProbability: number }[];
  originalCivilDate: string;
  crewBusyDates: Set<string>;
  cfg: WeatherConfig;
}): string | null {
  const sorted = [...input.days].sort((a, b) => a.date.localeCompare(b.date));
  for (const day of sorted) {
    if (day.date <= input.originalCivilDate) continue;
    if (input.crewBusyDates.has(day.date)) continue;
    if (assessWeatherRisk(day, input.cfg).atRisk) continue;
    return day.date;
  }
  return null;
}
