import { AGENT, type Agent } from "./enums";

export const AGENT_LABELS: Record<Agent, string> = {
  orchestrator: "Orchestrator",
  comms: "Comms",
  scheduling: "Scheduling",
  finance: "Finance",
  claims: "Claims",
};

/** The minimal shape both rollups need from an agent_run row. */
export type AgentRunLite = {
  agent: Agent;
  status: string;
  modelUsed: string | null;
  costCents: number | null;
  startedAt: Date;
};

export type AgentCoverage = {
  agent: Agent;
  label: string;
  total: number;
  ok: number;
  error: number;
  skipped: number;
  lastRunAt: Date | null;
};

/** One entry per agent (all five, in AGENT order) so the UI always shows the full roster. */
export function summarizeAgentCoverage(rows: AgentRunLite[], _now: Date): AgentCoverage[] {
  return AGENT.map((agent) => {
    const mine = rows.filter((r) => r.agent === agent);
    let last: Date | null = null;
    for (const r of mine) if (!last || r.startedAt > last) last = r.startedAt;
    return {
      agent,
      label: AGENT_LABELS[agent],
      total: mine.length,
      ok: mine.filter((r) => r.status === "ok").length,
      error: mine.filter((r) => r.status === "error").length,
      skipped: mine.filter((r) => r.status === "skipped").length,
      lastRunAt: last,
    };
  });
}

export type AutomationStats = {
  last24h: number;
  aiRuns: number;
  deterministicRuns: number;
  spendCents: number;
  errorRate: number;
  activeAgents: number;
};

export function summarizeAutomationStats(rows: AgentRunLite[], now: Date): AutomationStats {
  const dayAgo = now.getTime() - 86_400_000;
  const aiRuns = rows.filter((r) => r.modelUsed != null).length;
  const errors = rows.filter((r) => r.status === "error").length;
  return {
    last24h: rows.filter((r) => r.startedAt.getTime() >= dayAgo).length,
    aiRuns,
    deterministicRuns: rows.length - aiRuns,
    spendCents: rows.reduce((sum, r) => sum + (r.costCents ?? 0), 0),
    errorRate: rows.length ? errors / rows.length : 0,
    activeAgents: new Set(rows.map((r) => r.agent)).size,
  };
}
