import { z } from "./schemas";

/** Extraction schema for an uploaded carrier insurance estimate (Xactimate-style PDF). */
export const insuranceEstimateParseSchema = z.object({
  carrierName: z.string().nullable(),
  claimNumber: z.string().nullable(),
  acvCents: z.number().int().nullable(),
  rcvCents: z.number().int().nullable(),
  deductibleCents: z.number().int().nullable(),
  lines: z.array(z.object({
    description: z.string(),
    quantity: z.number(),
    unit: z.string().optional(),
    unitPriceCents: z.number().int().nullable(),
    amountCents: z.number().int(),
  })),
  confidence: z.number().min(0).max(1),
});
export type InsuranceEstimateParse = z.infer<typeof insuranceEstimateParseSchema>;
export type InsuranceEstimateLine = InsuranceEstimateParse["lines"][number];

/** Below this confidence, an insurance upload is carded ("stored, unparsed") rather than trusted. */
export const INSURANCE_PARSE_MIN_CONFIDENCE = 0.8;
