import { effectiveRoofAge } from "./roof";

export type StormFeature = {
  eventCount: number; maxHailInches: number; maxWindMph: number; daysSinceWorst: number | null;
};

export type LeadFeatures = {
  source: string;
  state: string | null;
  inTerritory: boolean;
  hasContact: boolean;
  roofType: string | null;
  roofTypeSecondary: string | null;
  yearBuilt: number | null;
  roofAgeYears: number | null;
  // The calendar year of a KNOWN roof replacement, when the effective age was
  // derived from one (else null). Lets the rationale cite "replaced 2017" instead
  // of implying a build-year age. (slice 5)
  roofReplacementYear: number | null;
  storm: StormFeature;
};

export function buildLeadFeatures(input: {
  source: string;
  state: string | null;
  phone?: string | null;
  email?: string | null;
  roofType: string | null;
  roofTypeSecondary?: string | null;
  yearBuilt: number | null;
  lastRoofReplacementAt?: Date | string | null;
  storm: StormFeature;
}): LeadFeatures {
  const year = input.yearBuilt;
  const replacementYear = input.lastRoofReplacementAt
    ? new Date(input.lastRoofReplacementAt).getFullYear()
    : null;
  return {
    source: input.source,
    state: input.state,
    inTerritory: Boolean(input.state),
    hasContact: Boolean(input.phone || input.email),
    roofType: input.roofType,
    roofTypeSecondary: input.roofTypeSecondary ?? null,
    yearBuilt: year,
    roofAgeYears: effectiveRoofAge({ lastRoofReplacementAt: input.lastRoofReplacementAt ?? null, yearBuilt: year }, new Date()),
    roofReplacementYear: replacementYear,
    storm: {
      eventCount: input.storm.eventCount,
      maxHailInches: input.storm.maxHailInches,
      maxWindMph: input.storm.maxWindMph,
      daysSinceWorst: input.storm.daysSinceWorst,
    },
  };
}
