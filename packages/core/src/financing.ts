// Cell 11 financing seam — pure decision + status model. NO credit data ever
// crosses this boundary: only a neutral application status enum. The actual
// vendor adapter (GreenSky-class) is dormant until the owner picks a provider.

export const FINANCING_STATUS = ["none", "offered", "applied", "approved", "declined", "funded"] as const;
export type FinancingStatus = (typeof FINANCING_STATUS)[number];

/**
 * Whether a retail estimate should carry a financing apply link. Financing is
 * a retail-only lever; insurance/repair/commercial never carry it. A zero/unset
 * floor means financing is disabled (no offer). `floorCents` is per-tenant config.
 */
export function shouldOfferFinancing(
  input: { jobType: string; amountCents: number | null | undefined },
  floorCents: number,
): boolean {
  if (input.jobType !== "retail") return false;
  if (floorCents <= 0) return false;
  return (input.amountCents ?? 0) >= floorCents;
}

/**
 * Maps an arbitrary vendor status string to the neutral FinancingStatus enum.
 * Deliberately status-only — approval amounts, APRs, and any credit data are
 * never ingested. Unknown/blank → 'none'.
 */
export function mapFinancingStatus(raw: string | null | undefined): FinancingStatus {
  const s = (raw ?? "").trim().toLowerCase();
  if (["approved", "accept", "accepted"].includes(s)) return "approved";
  if (["declined", "denied", "reject", "rejected"].includes(s)) return "declined";
  if (["funded", "disbursed"].includes(s)) return "funded";
  if (["applied", "submitted", "pending"].includes(s)) return "applied";
  if (["offered", "offer"].includes(s)) return "offered";
  return "none";
}
