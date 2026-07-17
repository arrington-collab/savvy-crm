// Strike List slice 2 (#266) — the spotter accuracy loop. Inspection ground
// truth scores each Roof Tagger spotter: how often did their pinned material
// match what a human later confirmed on the roof? Persistently low scorers get
// a coaching flag; a fresh spotter with few samples is never flagged (not
// enough evidence to judge).

import type { RoofMaterial } from "./roof-material";

export const SPOTTER_MIN_SAMPLES = 5;
export const SPOTTER_PRECISION_FLOOR = 0.7;

export interface SpotterSample {
  tagged: RoofMaterial;
  truth: RoofMaterial;
}

export interface SpotterPrecision {
  spotterName: string;
  samples: number;
  correct: number;
  precision: number; // 0..1; 0 when there are no samples
  coachingFlag: boolean;
}

export function computeSpotterPrecision(spotterName: string, samples: readonly SpotterSample[]): SpotterPrecision {
  const correct = samples.reduce((n, s) => n + (s.tagged === s.truth ? 1 : 0), 0);
  const precision = samples.length === 0 ? 0 : correct / samples.length;
  const coachingFlag = samples.length >= SPOTTER_MIN_SAMPLES && precision < SPOTTER_PRECISION_FLOOR;
  return { spotterName, samples: samples.length, correct, precision, coachingFlag };
}
