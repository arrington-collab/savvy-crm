import type { JobStage, Agent } from "./enums";

/**
 * The Operator Console Pipeline board — one continuum from lead to paid. Pure so
 * the stage→column mapping, waiting-on derivation and filter predicates are
 * unit-tested; the /pipeline page fetches rows (jobs + leads) and renders these.
 * A lead and a job are stages of the same thing, not separate modules.
 */
export const PIPELINE_COLUMNS = ["lead", "inspected", "estimate", "approved", "production", "invoiced", "paid"] as const;
export type PipelineColumn = (typeof PIPELINE_COLUMNS)[number];

/** Fold the 9 job stages onto the 7 board columns; `lost` is hidden. */
export function jobStageToColumn(stage: JobStage): PipelineColumn | null {
  switch (stage) {
    case "lead": return "lead";
    case "inspected": return "inspected";
    case "estimate": return "estimate";
    case "approved": return "approved";
    case "production":
    case "closeout": return "production";
    case "billing": return "invoiced";
    case "complete": return "paid";
    case "lost": return null;
  }
}

export type WaitingOnTask = { title: string; automationLevel: "full" | "partial" | "manual"; ownerAgent: Agent };
export type WaitingOnInput = { nextTask: WaitingOnTask | null; column: PipelineColumn; missingEvidence?: string | null };
export type WaitingOn = { label: string; ownerAgent: Agent | null; isHuman: boolean };

// When no job_task is instantiated, derive the waiting-on from the stage. No
// owner is named (null) — the agents own it by default; we don't fabricate a
// specific persona. A full-auto task is agent-owned; anything else needs a human.
const COLUMN_FALLBACK: Record<PipelineColumn, string> = {
  lead: "enrich & qualify",
  inspected: "schedule inspection",
  estimate: "customer decision",
  approved: "order materials",
  production: "crew photos & install",
  invoiced: "collect payment",
  paid: "closed",
};

export function deriveWaitingOn(input: WaitingOnInput): WaitingOn {
  if (input.nextTask) {
    return {
      label: input.nextTask.title,
      ownerAgent: input.nextTask.ownerAgent,
      isHuman: input.nextTask.automationLevel !== "full",
    };
  }
  if (input.missingEvidence) {
    return { label: `needs ${input.missingEvidence}`, ownerAgent: null, isHuman: true };
  }
  return { label: COLUMN_FALLBACK[input.column], ownerAgent: null, isHuman: false };
}

export type PipelineFilter = "all" | "stuck" | "waiting_human" | "claims" | "over_25k";
export const OVER_25K_CENTS = 25_000_00;

export type FilterableCard = { isStuck: boolean; isClaim: boolean; valueCents: number | null; waitingOnHuman: boolean };

export function cardMatchesFilter(card: FilterableCard, filter: PipelineFilter): boolean {
  switch (filter) {
    case "all": return true;
    case "stuck": return card.isStuck;
    case "waiting_human": return card.waitingOnHuman;
    case "claims": return card.isClaim;
    case "over_25k": return card.valueCents != null && card.valueCents >= OVER_25K_CENTS;
  }
}
