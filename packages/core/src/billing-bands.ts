export interface BillingBand {
  key: string;
  name: string;
  monthlyPriceCents: number;
  allowances: { jobsProcessed: number; aiSpendCents: number; aiVoiceMinutes: number; storageBytes: number };
  overageRates: { perJobCents: number; perVoiceMinuteCents: number; perGbStorageCents: number; perAiSpendDollarCents: number };
}

const GB = 1024 ** 3;

// Platform pricing. Placeholder figures the operator tunes; revenue-band names
// map to the roofing company's annual revenue tier.
export const BILLING_BANDS: BillingBand[] = [
  { key: "starter", name: "Starter", monthlyPriceCents: 49900,
    allowances: { jobsProcessed: 50, aiSpendCents: 5000, aiVoiceMinutes: 500, storageBytes: 10 * GB },
    overageRates: { perJobCents: 500, perVoiceMinuteCents: 15, perGbStorageCents: 25, perAiSpendDollarCents: 150 } },
  { key: "growth", name: "Growth", monthlyPriceCents: 99900,
    allowances: { jobsProcessed: 150, aiSpendCents: 20000, aiVoiceMinutes: 2000, storageBytes: 50 * GB },
    overageRates: { perJobCents: 400, perVoiceMinuteCents: 12, perGbStorageCents: 20, perAiSpendDollarCents: 140 } },
  { key: "scale", name: "Scale", monthlyPriceCents: 199900,
    allowances: { jobsProcessed: 500, aiSpendCents: 75000, aiVoiceMinutes: 8000, storageBytes: 200 * GB },
    overageRates: { perJobCents: 300, perVoiceMinuteCents: 10, perGbStorageCents: 15, perAiSpendDollarCents: 130 } },
];

export function getBand(key: string | null | undefined): BillingBand {
  return BILLING_BANDS.find((b) => b.key === key) ?? BILLING_BANDS[0]!;
}
