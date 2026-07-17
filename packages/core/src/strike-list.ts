// Phase 20 S4 (#309): Members = the top Strike List tier. Post-storm, members
// get FIRST contact — they hold a pre-authorized inspection agreement, so a
// verified swath over their roof is a booking waiting to happen, not a cold
// knock. This is the ONLY tier built in Wave-1.
//
// WAVE-2 SEAM (unbuilt — "Strike List" proper): the full list ranks EVERY
// storm-affected contact across tiers — members → prior customers → warm
// canvass → cold — with per-tier scoring (recency, roof age, proximity to the
// swath centroid). When that lands, replace the boolean member/non-member
// partition below with a tier-rank comparator; members stay rank 0.

export interface StrikeTarget {
  customerId: string | null;
}

/**
 * Stable members-first ordering for post-storm outreach. Active members sort
 * ahead of everyone else; original relative order is preserved within each
 * tier, so a non-member-only batch is returned unchanged and a member-only
 * batch keeps its order too. A null customerId is treated as a non-member.
 */
export function strikeListOrder<T extends StrikeTarget>(
  targets: readonly T[],
  memberCustomerIds: ReadonlySet<string>,
): T[] {
  const members: T[] = [];
  const rest: T[] = [];
  for (const t of targets) {
    if (t.customerId && memberCustomerIds.has(t.customerId)) members.push(t);
    else rest.push(t);
  }
  return [...members, ...rest];
}
