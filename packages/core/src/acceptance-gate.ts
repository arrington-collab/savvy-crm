// Estimate Experience slice 3: the accept gate. Acceptance (job creation, lead
// won, stage advance — the EXISTING estimate/accepted chain) fires only when
// the homeowner has signed AND the deposit is settled (when one is required).

export function depositRequirement(input: {
  totalCents: number;
  depositPercentageBps: number;
  stripeConnected: boolean;
}): { required: boolean; amountCents: number } {
  // No Stripe connection = nothing to collect through; acceptance must not
  // dead-end on a tenant that hasn't onboarded payments. 0 bps = owner waived.
  if (!input.stripeConnected || input.depositPercentageBps <= 0) {
    return { required: false, amountCents: 0 };
  }
  return {
    required: true,
    amountCents: Math.round((input.totalCents * input.depositPercentageBps) / 10_000),
  };
}

export function acceptanceReady(input: {
  signedAt: Date | null;
  depositPaidAt: Date | null;
  depositRequired: boolean;
}): boolean {
  if (!input.signedAt) return false;
  if (!input.depositRequired) return true;
  return input.depositPaidAt != null;
}
