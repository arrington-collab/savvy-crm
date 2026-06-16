import { z } from "zod";

const pitchTierSchema = z.object({
  minRise: z.number().int().min(0),
  maxRise: z.number().int().min(0).nullable(),
  laborSurchargePct: z.number().int().min(0), // bps on labor items
  wasteBumpPct: z.number().int().min(0),      // bps added to field-shingle waste
});

const DEFAULT_TIERS = [
  { minRise: 0, maxRise: 6, laborSurchargePct: 0, wasteBumpPct: 0 },
  { minRise: 7, maxRise: 9, laborSurchargePct: 2000, wasteBumpPct: 0 },
  { minRise: 10, maxRise: 12, laborSurchargePct: 3500, wasteBumpPct: 0 },
  { minRise: 13, maxRise: null, laborSurchargePct: 5000, wasteBumpPct: 0 },
];

const estimateSchema = z.object({
  taxRateBps: z.number().int().min(0).default(0),
  defaultWastePct: z.number().int().min(0).default(1200),
  steepPitchTiers: z.array(pitchTierSchema).default(DEFAULT_TIERS),
});

export type PitchTier = z.infer<typeof pitchTierSchema>;
export type EstimateConfig = z.infer<typeof estimateSchema>;

export function parseEstimateConfig(raw: unknown): EstimateConfig {
  return estimateSchema.parse(raw ?? {});
}
