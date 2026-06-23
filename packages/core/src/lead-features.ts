export type StormFeature = {
  eventCount: number; maxHailInches: number; maxWindMph: number; daysSinceWorst: number | null;
};

export type LeadFeatures = {
  source: string;
  state: string | null;
  inTerritory: boolean;
  hasContact: boolean;
  roofType: string | null;
  yearBuilt: number | null;
  roofAgeYears: number | null;
  storm: StormFeature;
};

export function buildLeadFeatures(input: {
  source: string;
  state: string | null;
  phone?: string | null;
  email?: string | null;
  roofType: string | null;
  yearBuilt: number | null;
  storm: StormFeature;
}): LeadFeatures {
  const year = input.yearBuilt;
  return {
    source: input.source,
    state: input.state,
    inTerritory: Boolean(input.state),
    hasContact: Boolean(input.phone || input.email),
    roofType: input.roofType,
    yearBuilt: year,
    roofAgeYears: year ? new Date().getFullYear() - year : null,
    storm: {
      eventCount: input.storm.eventCount,
      maxHailInches: input.storm.maxHailInches,
      maxWindMph: input.storm.maxWindMph,
      daysSinceWorst: input.storm.daysSinceWorst,
    },
  };
}
