import type { BillingBand } from "./billing-bands";

export interface UsageTotals {
  jobsProcessed: number;
  aiSpendCents: number;
  aiVoiceMinutes: number;
  storageBytes: number;
}

const GB = 1024 ** 3;

export function computeBill(usage: UsageTotals, band: BillingBand): {
  basePriceCents: number;
  overages: { jobs: number; voice: number; storage: number; aiSpend: number };
  overageTotalCents: number;
  totalCents: number;
} {
  const a = band.allowances;
  const r = band.overageRates;
  const overJobs = Math.max(0, usage.jobsProcessed - a.jobsProcessed);
  const overMin = Math.max(0, usage.aiVoiceMinutes - a.aiVoiceMinutes);
  const overGb = Math.ceil(Math.max(0, usage.storageBytes - a.storageBytes) / GB);
  const overAiDollars = Math.ceil(Math.max(0, usage.aiSpendCents - a.aiSpendCents) / 100);
  const overages = {
    jobs: overJobs * r.perJobCents,
    voice: overMin * r.perVoiceMinuteCents,
    storage: overGb * r.perGbStorageCents,
    aiSpend: overAiDollars * r.perAiSpendDollarCents,
  };
  const overageTotalCents = overages.jobs + overages.voice + overages.storage + overages.aiSpend;
  return { basePriceCents: band.monthlyPriceCents, overages, overageTotalCents, totalCents: band.monthlyPriceCents + overageTotalCents };
}
