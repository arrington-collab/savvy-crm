import type { LeadFeatures } from "./lead-features";

export type ScoreFactor = { label: string; points: number };
export type BaselineScore = { score: number; factors: ScoreFactor[] };

// Tunable weights (edit freely). Source keys align with DEFAULT_LEAD_SOURCES values.
export const SCORE_WEIGHTS = {
  source: { referral: 18, repeat: 16, carrier: 14, storm_canvass: 14, google: 9,
            website: 8, web: 8, facebook: 7, door_knock: 8, yard_sign: 6,
            manual: 5, other: 5 } as Record<string, number>,
  sourceDefault: 5,
  hailMaxPoints: 30,
  windMaxPoints: 20,
  roofAgeMaxPoints: 20,
  inTerritory: 5,
  hasContact: 5,
  recencyHalfLifeDays: 60,
};

function recencyFactor(days: number | null): number {
  if (days == null) return 0.5;
  return Math.max(0, Math.min(1, Math.pow(0.5, days / SCORE_WEIGHTS.recencyHalfLifeDays)));
}

export function scoreLeadBaseline(f: LeadFeatures): BaselineScore {
  const factors: ScoreFactor[] = [];
  const add = (label: string, points: number) => { if (points !== 0) factors.push({ label, points: Math.round(points) }); };

  add(`source: ${f.source}`, SCORE_WEIGHTS.source[(f.source ?? "").toLowerCase()] ?? SCORE_WEIGHTS.sourceDefault);

  if (f.storm.maxHailInches > 0) {
    const sizeFrac = Math.min(1, f.storm.maxHailInches / 2);
    add(`hail ${f.storm.maxHailInches}" (${f.storm.daysSinceWorst ?? "?"}d ago)`,
        SCORE_WEIGHTS.hailMaxPoints * sizeFrac * recencyFactor(f.storm.daysSinceWorst));
  }
  if (f.storm.maxWindMph > 0) {
    const windFrac = Math.min(1, f.storm.maxWindMph / 100);
    add(`wind ${f.storm.maxWindMph}mph`,
        SCORE_WEIGHTS.windMaxPoints * windFrac * recencyFactor(f.storm.daysSinceWorst));
  }
  if (f.roofAgeYears != null && f.roofAgeYears >= 15) {
    const ageFrac = Math.min(1, (f.roofAgeYears - 15) / 15);
    add(`roof ~${f.roofAgeYears} yrs old`, SCORE_WEIGHTS.roofAgeMaxPoints * ageFrac);
  }
  if (f.inTerritory) add("in territory", SCORE_WEIGHTS.inTerritory);
  if (f.hasContact) add("has contact info", SCORE_WEIGHTS.hasContact);

  const raw = factors.reduce((s, x) => s + x.points, 0);
  return { score: Math.max(0, Math.min(100, raw)), factors };
}
