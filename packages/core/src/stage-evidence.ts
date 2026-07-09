import type { JobStage } from "./enums";

export interface StageEvidence {
  inspection: boolean;
  estimate: boolean;
  approval: boolean;
  production: boolean;
  closeoutPhotos: boolean;
  invoice: boolean;
  invoicePaid: boolean;
}

// Gated stages in ladder order, each with the evidence key it requires + a human label.
const GATED: { stage: JobStage; key: keyof StageEvidence; label: string }[] = [
  { stage: "inspected", key: "inspection", label: "inspection" },
  { stage: "estimate", key: "estimate", label: "estimate" },
  { stage: "approved", key: "approval", label: "approval" },
  { stage: "production", key: "production", label: "crew or materials" },
  { stage: "closeout", key: "closeoutPhotos", label: "completion photos" },
  { stage: "billing", key: "invoice", label: "invoice" },
  { stage: "complete", key: "invoicePaid", label: "paid invoice" },
];

export const STAGE_EVIDENCE_LABEL: Record<string, string> = Object.fromEntries(GATED.map((g) => [g.stage, g.label]));

/** Highest stage whose evidence chain from 'inspected' up is unbroken; 'lead' if the first gate fails. */
export function deriveContiguousStage(ev: StageEvidence): JobStage {
  let derived: JobStage = "lead";
  for (const g of GATED) {
    if (!ev[g.key]) break;
    derived = g.stage;
  }
  return derived;
}

/** Label of the first missing gate at/below `stage` — what the job still needs to reach it. */
export function missingEvidenceFor(stage: JobStage, ev: StageEvidence): string | null {
  const target = GATED.findIndex((g) => g.stage === stage);
  if (target < 0) return null; // lead / lost — ungated
  for (let i = 0; i <= target; i++) {
    if (!ev[GATED[i]!.key]) return GATED[i]!.label;
  }
  return null;
}

/** Own-stage predicate: does the job hold the evidence its CURRENT stage requires? */
export function stageEvidenceSatisfied(stage: JobStage, ev: StageEvidence): boolean {
  const g = GATED.find((x) => x.stage === stage);
  return g ? ev[g.key] : true; // lead/lost ungated
}
