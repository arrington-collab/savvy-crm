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
  // Slice 1: estimates whose total exceeds this are parked for human approval
  // instead of auto-sent. null (default) = no gating — auto-send everything.
  approvalThresholdCents: z.number().int().min(0).nullable().default(null),
  // Estimate Experience slice 1: default margin floor (bps) for tier pricing;
  // per-item overrides live on the price-book item. Violations card, never silent.
  marginFloorBps: z.number().int().min(0).default(2000),
});

export type PitchTier = z.infer<typeof pitchTierSchema>;
export type EstimateConfig = z.infer<typeof estimateSchema>;

export function parseEstimateConfig(raw: unknown): EstimateConfig {
  return estimateSchema.parse(raw ?? {});
}

/**
 * Whether a drafted estimate must be parked for human approval before sending.
 * True only when the tenant set a threshold AND the estimate total exceeds it.
 */
export function estimateRequiresApproval(totalCents: number, cfg: EstimateConfig): boolean {
  return cfg.approvalThresholdCents !== null && totalCents > cfg.approvalThresholdCents;
}
