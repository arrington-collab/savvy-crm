import type { JobStage } from "./enums";
import type { PipelineConfig } from "./pipeline-config";

export type StageGross = { stage: JobStage; grossCents: number };
export type WeightedStage = { stage: JobStage; grossCents: number; expectedCents: number; probability: number };
export type WeightedPipeline = { stages: WeightedStage[]; grossCents: number; expectedCents: number };

export function weightedPipeline(perStage: StageGross[], config: PipelineConfig): WeightedPipeline {
  const probs = config.stageWinProbability as Record<string, number>;
  const stages: WeightedStage[] = perStage.map((s) => {
    const probability = probs[s.stage] ?? 0;
    return { stage: s.stage, grossCents: s.grossCents, probability, expectedCents: Math.round((s.grossCents * probability) / 100) };
  });
  return {
    stages,
    grossCents: stages.reduce((a, s) => a + s.grossCents, 0),
    expectedCents: stages.reduce((a, s) => a + s.expectedCents, 0),
  };
}

/** Week-over-week percent change; null when there is no prior basis. */
export function wowPct(currentCents: number, priorCents: number): number | null {
  if (priorCents <= 0) return null;
  return Math.round(((currentCents - priorCents) / priorCents) * 100);
}
