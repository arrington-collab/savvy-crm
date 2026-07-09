export const ROOF_REPLACEMENT_SOURCE_VALUES = ["owner_reported", "permit", "assessor"] as const;
export type RoofReplacementSource = (typeof ROOF_REPLACEMENT_SOURCE_VALUES)[number];

const SOURCE_RANK: Record<RoofReplacementSource, number> = { owner_reported: 3, permit: 2, assessor: 1 };

/**
 * Effective roof age in whole years: years since a known replacement when
 * present, else years since year_built, else null. `now` is injected so the
 * function stays pure and testable.
 */
export function effectiveRoofAge(
  input: { lastRoofReplacementAt: Date | string | null; yearBuilt: number | null },
  now: Date,
): number | null {
  if (input.lastRoofReplacementAt) {
    // Use UTC year extraction: a date-only string like "2015-01-01" parses as
    // UTC midnight, so a local getFullYear() can read back the prior year in
    // negative-UTC-offset timezones (e.g. MST). getUTCFullYear avoids that drift.
    return now.getFullYear() - new Date(input.lastRoofReplacementAt).getUTCFullYear();
  }
  return input.yearBuilt ? now.getFullYear() - input.yearBuilt : null;
}

/** True when enrichment may write `incoming` over `existing`. owner_reported is never overwritten. */
export function canEnrichmentWriteReplacement(
  existing: RoofReplacementSource | null,
  incoming: RoofReplacementSource,
): boolean {
  if (!existing) return true;
  return SOURCE_RANK[incoming] > SOURCE_RANK[existing];
}

/** Gap-fill: return only the roof/year fields whose stored value is null (never overwrite owner-edited values). */
export function roofYearGapFill(
  existing: { roofType: string | null; yearBuilt: number | null },
  incoming: { roofType: string | null; yearBuilt: number | null },
): { roofType?: string | null; yearBuilt?: number | null } {
  const out: { roofType?: string | null; yearBuilt?: number | null } = {};
  if (existing.roofType == null && incoming.roofType != null) out.roofType = incoming.roofType;
  if (existing.yearBuilt == null && incoming.yearBuilt != null) out.yearBuilt = incoming.yearBuilt;
  return out;
}
