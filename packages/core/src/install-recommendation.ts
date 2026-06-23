import type { LeadFeatures } from "./lead-features";

export type InstallRecommendation = {
  windRating: "standard" | "high";
  impactResistance: "standard" | "class4";
  suggestedProducts: string[];
  rationale: string;
};

// Editable defaults — tune thresholds + product strings here.
export const RECOMMENDATION_CONFIG = {
  highWindMph: 110,
  highWindEventCount: 2,
  class4HailInches: 1.0,
  oldRoofYears: 18,
  products: {
    highWind: ["High-wind rated shingle", "6-nail install pattern", "Upgraded starter + ridge"],
    class4: ["Class 4 impact-resistant shingle (insurance-discount eligible)"],
  },
};

export function deriveInstallRecommendation(f: LeadFeatures): InstallRecommendation {
  const c = RECOMMENDATION_CONFIG;
  const products: string[] = [];
  const reasons: string[] = [];

  const highWind = f.storm.maxWindMph >= c.highWindMph || f.storm.eventCount >= c.highWindEventCount;
  if (highWind) {
    products.push(...c.products.highWind);
    reasons.push(`wind exposure (${f.storm.maxWindMph || "repeated events"})`);
  }
  const class4 = f.storm.maxHailInches >= c.class4HailInches;
  if (class4) {
    products.push(...c.products.class4);
    reasons.push(`hail history (${f.storm.maxHailInches}")`);
  }
  if (f.roofAgeYears != null && f.roofAgeYears >= c.oldRoofYears && (highWind || class4)) {
    reasons.push(`${f.roofAgeYears}-yr roof — frame as full replacement vs repair`);
  }

  return {
    windRating: highWind ? "high" : "standard",
    impactResistance: class4 ? "class4" : "standard",
    suggestedProducts: products,
    rationale: reasons.length ? reasons.join("; ") : "Standard install; no storm-driven upgrades indicated.",
  };
}
