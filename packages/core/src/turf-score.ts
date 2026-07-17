// Strike List slice 4 (#269/#270) — Turf Score. A neighborhood's momentum is
// our completed jobs there as a share of its parcels, recency-weighted: a job
// finished last month proves current dominance, one from four years ago barely
// counts. Crossing the threshold (default 5%) means "the neighbors are choosing
// us" — worth a saturation mailer + canvass priority.

export const TURF_THRESHOLD = 0.05;

const DAY_MS = 86_400_000;
const FULL_WEIGHT_DAYS = 730; // ~24 months: full credit
const ZERO_WEIGHT_DAYS = 1461; // ~48 months: no credit; linear decay between

/** Recency weight for one completion: 1.0 within 24mo, linearly decaying to 0
 *  at 48mo, 0 beyond. */
function recencyWeight(ageDays: number): number {
  if (ageDays <= FULL_WEIGHT_DAYS) return 1;
  if (ageDays >= ZERO_WEIGHT_DAYS) return 0;
  return (ZERO_WEIGHT_DAYS - ageDays) / (ZERO_WEIGHT_DAYS - FULL_WEIGHT_DAYS);
}

export function computeTurfScore(input: { completions: readonly Date[]; parcelCount: number; now: Date }): number {
  if (input.parcelCount <= 0) return 0;
  const weighted = input.completions.reduce((sum, c) => {
    const ageDays = (input.now.getTime() - c.getTime()) / DAY_MS;
    return sum + recencyWeight(ageDays);
  }, 0);
  return weighted / input.parcelCount;
}

export function crossesTurfThreshold(score: number, threshold: number = TURF_THRESHOLD): boolean {
  return score >= threshold;
}
