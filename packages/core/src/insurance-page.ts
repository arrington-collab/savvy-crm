// Estimate Experience slice 7: the insurance variant — scope aligned to the
// carrier claim, deductible framed compliantly (SB38: never a whisper about
// waiving it), upgrades rendered as out-of-pocket add-ons. No tiers, no
// monthly toggle: the carrier already priced the roof.

export const RETAIL_TEMPLATE_VERSION = "retail-v1";
export const INSURANCE_TEMPLATE_VERSION = "insurance-v1";

export function estimateTemplateVersion(input: {
  source: string | null;
  leadSource: string | null;
}): string {
  const insurance =
    input.source === "carrier" || (input.leadSource ?? "").toLowerCase().includes("insurance");
  return insurance ? INSURANCE_TEMPLATE_VERSION : RETAIL_TEMPLATE_VERSION;
}

const usd = (cents: number) =>
  (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

/** The deductible line. Colorado calls SB22-38 out by name; everywhere the
 *  framing is the same honest fact — it's the homeowner's responsibility,
 *  full stop. The word "waive" never appears in any variant. */
export function deductibleFraming(deductibleCents: number | null, state: string | null): string | null {
  if (deductibleCents == null || deductibleCents <= 0) return null;
  const amount = usd(deductibleCents);
  if (state === "CO") {
    return `Your deductible (${amount}) is your out-of-pocket responsibility — Colorado law (SB22-38) requires it to be paid by the homeowner, and we're required to tell you exactly that.`;
  }
  return `Your deductible (${amount}) is your responsibility under your policy — we'll never hide it in the numbers.`;
}

export interface InsuranceAddOn {
  name: string;
  reason: string;
  totalCents: number;
}

export interface InsurancePanel {
  carrierLine: string;
  claimLine: string | null;
  approvedLine: string | null;
  deductibleLine: string | null;
  addOns: InsuranceAddOn[];
}

export function buildInsurancePanel(input: {
  claim: { carrierName: string | null; claimNumber: string | null; rcvCents: number | null; deductibleCents: number | null } | null;
  state: string | null;
  upsells: { name: string; reason: string; unitPriceCents: number; quantity: number }[];
}): InsurancePanel | null {
  if (!input.claim) return null;
  const c = input.claim;
  return {
    carrierLine: c.carrierName ? `Your claim with ${c.carrierName} is approved.` : "Your insurance claim is approved.",
    claimLine: c.claimNumber ? `Claim #${c.claimNumber}` : null,
    approvedLine: c.rcvCents != null ? `Approved scope: ${usd(c.rcvCents)} (replacement cost)` : null,
    deductibleLine: deductibleFraming(c.deductibleCents, input.state),
    addOns: input.upsells.map((u) => ({
      name: u.name,
      reason: u.reason,
      totalCents: Math.round(u.quantity * u.unitPriceCents),
    })),
  };
}
