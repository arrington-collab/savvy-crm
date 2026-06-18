// Presentation-only agent identity layer. Maps the REAL backend services
// (the `agent` enum + the action/taskKey on an agent_run, or a job's pipeline
// stage) to human personas for the cockpit UI. The backend is unchanged — this
// is purely how ops SEE the agents. Always show "Service (PERSONA)" so the real
// service stays recognizable. Never throws: unknown → SAGE (neutral gold).

import { AGENT_LABELS, type Agent } from "@savvy/core";

export type PersonaKey = "SAGE" | "ATLAS" | "VERA" | "MILO" | "SCOUT" | "RAINE" | "NOVA";

export interface Persona {
  key: PersonaKey;
  name: string;
  role: string;
  /** CSS variable reference, e.g. "var(--agent-milo)" — color lives in globals.css. */
  colorToken: string;
  initials: string;
  voiceDescriptor: string;
  /** In-character first-person lines for empty/placeholder states + toasts. */
  samples: string[];
}

export const PERSONAS: Record<PersonaKey, Persona> = {
  SAGE: {
    key: "SAGE", name: "SAGE", role: "Orchestrator", colorToken: "var(--agent-sage)", initials: "SA",
    voiceDescriptor: "calm advisory; refers to agents by name",
    samples: [
      "I'm watching the whole board — all crews nominal.",
      "VERA's drafting, RAINE's collecting. Nothing needs you yet.",
      "Quiet right now. I'll surface anything that matters.",
    ],
  },
  ATLAS: {
    key: "ATLAS", name: "ATLAS", role: "Lead Hunter", colorToken: "var(--agent-sage)", initials: "AT",
    voiceDescriptor: "confident, hungry",
    samples: [
      "Fresh lead in — I'm already on it.",
      "Scored and routed. This one's warm.",
      "No lead sits cold on my watch.",
    ],
  },
  VERA: {
    key: "VERA", name: "VERA", role: "Estimator", colorToken: "var(--agent-vera)", initials: "VE",
    voiceDescriptor: "precise, calm",
    samples: [
      "Drafted from the inspection — every line measured.",
      "Numbers are tight and defensible.",
      "I priced it to the book, not a guess.",
    ],
  },
  MILO: {
    key: "MILO", name: "MILO", role: "Dispatcher", colorToken: "var(--agent-milo)", initials: "MI",
    voiceDescriptor: "upbeat, unflappable",
    samples: [
      "Crew's slotted — no clashes.",
      "Booked and confirmed. Easy.",
      "I'll keep the schedule humming.",
    ],
  },
  SCOUT: {
    key: "SCOUT", name: "SCOUT", role: "Inspector / Claims", colorToken: "var(--agent-scout)", initials: "SC",
    voiceDescriptor: "sharp, evidence-first",
    samples: [
      "Photos logged, damage documented.",
      "I don't guess — I verify.",
      "Evidence first, every time.",
    ],
  },
  RAINE: {
    key: "RAINE", name: "RAINE", role: "Collections", colorToken: "var(--agent-raine)", initials: "RA",
    voiceDescriptor: "warm but firm closer",
    samples: [
      "Invoice sent — I'll watch for the sign-off.",
      "A friendly nudge out the door.",
      "I close the loop, kindly but surely.",
    ],
  },
  NOVA: {
    key: "NOVA", name: "NOVA", role: "Concierge", colorToken: "var(--agent-nova)", initials: "NO",
    voiceDescriptor: "warm, reassuring",
    samples: [
      "Homeowner's looked after.",
      "I kept them in the loop.",
      "Reassured and replied.",
    ],
  },
};

/** Home service for each persona (used when resolving from a job stage). */
const PERSONA_SERVICE: Record<PersonaKey, string> = {
  SAGE: "Orchestrator", ATLAS: "Comms", NOVA: "Comms",
  VERA: "Finance", RAINE: "Finance", MILO: "Scheduling", SCOUT: "Claims",
};

export interface ResolvedAgent {
  /** The real backend service label, e.g. "Comms", "Finance". */
  service: string;
  persona: Persona;
}

/**
 * Resolve a persona from a real agent_run row using BOTH the agent id and the
 * action (taskKey). Never throws — unknown agents resolve to SAGE.
 */
export function resolveAgent(row: { agent: string; taskKey?: string | null }): ResolvedAgent {
  const action = (row.taskKey ?? "").toLowerCase();
  const service = AGENT_LABELS[row.agent as Agent] ?? "System";
  let key: PersonaKey;
  switch (row.agent) {
    case "orchestrator": key = "SAGE"; break;
    case "comms": key = action.startsWith("lead.") ? "ATLAS" : "NOVA"; break;
    case "scheduling": key = "MILO"; break;
    case "finance": key = /invoice|payment|collect/.test(action) ? "RAINE" : "VERA"; break;
    case "claims": key = "SCOUT"; break;
    default: key = "SAGE";
  }
  return { service, persona: PERSONAS[key] };
}

/**
 * Resolve a persona from a job's pipeline stage (presentation heuristic — jobs
 * don't carry a real owning agent yet). TODO: replace with a real per-job agent.
 */
export function resolveAgentForStage(stage: string): ResolvedAgent {
  let key: PersonaKey;
  switch (stage) {
    case "lead":
    case "inspected": key = "ATLAS"; break;
    case "estimate": key = "VERA"; break;
    case "approved":
    case "production":
    case "closeout": key = "MILO"; break;
    case "billing": key = "RAINE"; break;
    case "complete": key = "NOVA"; break;
    case "lost": key = "SCOUT"; break;
    default: key = "SAGE";
  }
  return { service: PERSONA_SERVICE[key], persona: PERSONAS[key] };
}

/** "Comms (NOVA)", "Finance (VERA)", … — what to render wherever an agent appears. */
export function agentLabel(r: ResolvedAgent): string {
  return `${r.service} (${r.persona.name})`;
}

/** Deterministic in-voice sample (no Math.random — index by a stable seed). */
export function personaLine(persona: Persona, seed = 0): string {
  const n = persona.samples.length;
  return persona.samples[((seed % n) + n) % n] ?? persona.samples[0]!;
}

/**
 * Presentation persona for a lead's funnel status (NOT a real agent_run lookup —
 * agent_run has no lead linkage yet). ATLAS hunts the early funnel; SAGE closes.
 */
export function leadStatusPersona(status: string): { persona: Persona; dimmed: boolean } {
  if (status === "won") return { persona: PERSONAS.SAGE, dimmed: false };
  if (status === "lost") return { persona: PERSONAS.ATLAS, dimmed: true };
  return { persona: PERSONAS.ATLAS, dimmed: false }; // new | contacted | qualified | booked
}
