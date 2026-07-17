import { z } from "zod";

// Owner's Room slice 1 — the multiple model is LIBRARY CONFIG, not code: the
// owner can see and edit every band and threshold, and the citations field
// says where the numbers came from. A methodology version stamps every
// snapshot so a config change never silently rewrites history.

const bandSchema = z.object({
  // null = no upper bound (the top band).
  maxRevenueCents: z.number().int().nullable(),
  low: z.number(),
  high: z.number(),
});

const DEFAULT_BANDS = [
  { maxRevenueCents: 100_000_000, low: 2.0, high: 2.7 }, // < $1M TTM
  { maxRevenueCents: 300_000_000, low: 2.2, high: 3.0 }, // $1–3M
  { maxRevenueCents: null, low: 2.5, high: 3.5 }, // $3M+
];

const DEFAULT_CITATIONS =
  "Seeded from published small-trades comps (residential roofing/services, ~2.0–3.5× SDE). " +
  "Planning ranges only — replace with your broker or industry sources.";

const valuationConfigSchema = z.object({
  version: z.string().catch("2026.07-v1").default("2026.07-v1"),
  citations: z.string().catch(DEFAULT_CITATIONS).default(DEFAULT_CITATIONS),
  minTtmMonths: z.number().int().min(1).catch(6).default(6),
  // Operating-cost proxy (revenue %) for the EBITDA estimate until QBO P&L lands.
  operatingCostPctEstimate: z.number().min(0).max(100).catch(18).default(18),
  bands: z.array(bandSchema).min(1).catch(DEFAULT_BANDS).default(DEFAULT_BANDS),
  // Named-adjustment thresholds and their ±multiple deltas [low, high].
  mrrTargetCents: z.number().int().catch(400_000).default(400_000),
  mrrDelta: z.tuple([z.number(), z.number()]).catch([0.2, 0.4]).default([0.2, 0.4]),
  coverageMinPct: z.number().catch(75).default(75),
  founderMinutesMax30d: z.number().catch(175).default(175), // ≈40 min/week
  ownerIndependenceDelta: z.tuple([z.number(), z.number()]).catch([0.3, 0.5]).default([0.3, 0.5]),
  topCustomerMaxPct: z.number().catch(25).default(25),
  concentrationDelta: z.tuple([z.number(), z.number()]).catch([-0.4, -0.2]).default([-0.4, -0.2]),
  insuranceMixMaxPct: z.number().catch(80).default(80),
  insuranceDelta: z.tuple([z.number(), z.number()]).catch([-0.3, -0.1]).default([-0.3, -0.1]),
  cleanBooksDelta: z.tuple([z.number(), z.number()]).catch([0.1, 0.2]).default([0.1, 0.2]),
  arOver60MaxPct: z.number().catch(20).default(20),
  arDelta: z.tuple([z.number(), z.number()]).catch([-0.1, -0.1]).default([-0.1, -0.1]),
  // Each missing non-critical input widens the range by this much per side.
  widenPerMissing: z.number().min(0).catch(0.15).default(0.15),
});

export type ValuationConfig = z.infer<typeof valuationConfigSchema>;

export function parseValuationConfig(raw: unknown): ValuationConfig {
  const r = valuationConfigSchema.safeParse(raw ?? {});
  return r.success ? r.data : valuationConfigSchema.parse({});
}
