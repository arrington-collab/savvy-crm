/**
 * Recoverable depreciation on an insurance claim, in cents. This is the holdback the
 * carrier withholds up front (pays ACV) and releases once the work is complete and
 * documented — i.e. `RCV − ACV`. Never negative; missing values count as zero. This is
 * the amount the depreciation-recovery invoice claims back from the carrier.
 */
export function recoverableDepreciationCents(claim: { rcvCents: number | null; acvCents: number | null }): number {
  return Math.max(0, (claim.rcvCents ?? 0) - (claim.acvCents ?? 0));
}
