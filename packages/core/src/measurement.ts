import { z } from "zod";
import type { PitchTier } from "./estimate-settings";

const num = () => z.number().min(0).default(0);

export const measurementAreasSchema = z.object({
  squares: num(),
  predominantPitch: z.string().default("0/12"),
  ridgeLf: num(),
  hipLf: num(),
  valleyLf: num(),
  eaveLf: num(),
  rakeLf: num(),
  stepFlashingLf: num(),
  penetrationCount: num(),
  facetCount: num(),
});
export type MeasurementAreas = z.infer<typeof measurementAreasSchema>;

/** Rise from an "X/12" pitch string; non-numeric (e.g. "flat") → 0. */
export function parsePitch(pitch: string): number {
  const m = /^(\d+)\s*\/\s*12$/.exec(pitch.trim());
  return m ? parseInt(m[1]!, 10) : 0;
}

/** First tier whose [minRise, maxRise] contains rise (maxRise null = catch-all). */
export function pitchTier(rise: number, tiers: PitchTier[]): PitchTier {
  const hit = tiers.find((t) => rise >= t.minRise && (t.maxRise === null || rise <= t.maxRise));
  return hit ?? { minRise: 0, maxRise: null, laborSurchargePct: 0, wasteBumpPct: 0 };
}
