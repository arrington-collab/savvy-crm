import { z } from "./schemas";

const weatherSchema = z.object({
  enabled: z.boolean().default(true),
  maxWindMph: z.number().int().positive().default(25),
  maxPrecipPct: z.number().int().min(0).max(100).default(60),
  lookAheadDays: z.number().int().min(1).max(30).default(7),
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
