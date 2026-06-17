import { describe, it, expect } from "vitest";
import { summarizeAgentCoverage, summarizeAutomationStats, AGENT_LABELS } from "./agent-activity";

const now = new Date("2026-06-16T12:00:00Z");
const h = (n: number) => new Date(now.getTime() - n * 3_600_000); // n hours ago

const rows = [
  { agent: "finance" as const, status: "ok", modelUsed: null, costCents: 0, startedAt: h(1) },
  { agent: "finance" as const, status: "skipped", modelUsed: null, costCents: null, startedAt: h(2) },
  { agent: "comms" as const, status: "ok", modelUsed: "claude-haiku-4-5", costCents: 12, startedAt: h(3) },
  { agent: "comms" as const, status: "error", modelUsed: "claude-haiku-4-5", costCents: 5, startedAt: h(30) },
];

describe("summarizeAgentCoverage", () => {
  it("returns one entry per agent (all five), with counts and last-run", () => {
    const cov = summarizeAgentCoverage(rows, now);
    expect(cov.map((c) => c.agent)).toEqual(["orchestrator", "comms", "scheduling", "finance", "claims"]);
    const finance = cov.find((c) => c.agent === "finance")!;
    expect(finance).toMatchObject({ total: 2, ok: 1, skipped: 1, error: 0, label: "Finance" });
    expect(finance.lastRunAt).toEqual(h(1));
    const comms = cov.find((c) => c.agent === "comms")!;
    expect(comms).toMatchObject({ total: 2, ok: 1, error: 1 });
    const sched = cov.find((c) => c.agent === "scheduling")!;
    expect(sched).toMatchObject({ total: 0, lastRunAt: null });
  });
});

describe("summarizeAutomationStats", () => {
  it("counts 24h actions, AI vs deterministic, spend, error rate", () => {
    const s = summarizeAutomationStats(rows, now);
    expect(s.last24h).toBe(3);
    expect(s.aiRuns).toBe(2);
    expect(s.deterministicRuns).toBe(2);
    expect(s.spendCents).toBe(17);
    expect(s.errorRate).toBeCloseTo(0.25);
    expect(s.activeAgents).toBe(2);
  });
});

it("AGENT_LABELS covers all five agents", () => {
  expect(Object.keys(AGENT_LABELS).sort()).toEqual(["claims", "comms", "finance", "orchestrator", "scheduling"]);
});
