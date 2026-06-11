import type { CommissionModel } from "./enums";

export type CommissionTier = { thresholdCents: number; rate: number };

export function computeCommission(input: {
  model: CommissionModel;
  basisCents: number;            // paid amount (flat/tiered) or profit (profit; caller pre-subtracts cost)
  rate: number;                  // basis points
  tiers?: CommissionTier[];
  priorPeriodTotalCents: number; // rep's basis already booked this period (tiered only)
}): { amountCents: number; appliedRate: number } {
  const basis = Math.max(0, input.basisCents);
  let appliedRate = input.rate;
  if (input.model === "tiered" && input.tiers?.length) {
    const reached = input.tiers
      .filter((t) => input.priorPeriodTotalCents >= t.thresholdCents)
      .sort((a, b) => b.thresholdCents - a.thresholdCents)[0];
    if (reached) appliedRate = reached.rate;
  }
  const amountCents = Math.round((basis * appliedRate) / 10_000);
  return { amountCents, appliedRate };
}
