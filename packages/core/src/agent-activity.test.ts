import { describe, it, expect } from "vitest";
import { summarizeAgentCoverage, summarizeAutomationStats, AGENT_LABELS, summarizeJobAutomation, type JobTaskLite } from "./agent-activity";

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

describe("summarizeJobAutomation", () => {
  const tasks: JobTaskLite[] = [
    { ownerAgent: "comms", automationLevel: "full", status: "done" },
    { ownerAgent: "comms", automationLevel: "full", status: "pending" },
    { ownerAgent: "scheduling", automationLevel: "partial", status: "pending" },
    { ownerAgent: "finance", automationLevel: "manual", status: "pending" },
    { ownerAgent: null, automationLevel: "manual", status: "done" },
  ];

  it("counts levels and computes a weighted autonomy percentage", () => {
    const s = summarizeJobAutomation(tasks);
    expect(s.total).toBe(5);
    expect(s.full).toBe(2);
    expect(s.partial).toBe(1);
    expect(s.manual).toBe(2);
    // weighted = 2*1 + 1*0.5 + 2*0 = 2.5 ; 2.5/5 = 50%
    expect(s.autonomyPct).toBe(50);
  });

  it("counts needs-you as non-done, non-full tasks", () => {
    // pending partial (scheduling) + pending manual (finance) = 2; the pending full and the done tasks are excluded
    expect(summarizeJobAutomation(tasks).needsYouCount).toBe(2);
  });

  it("breaks down by agent in AGENT order, only for agents that own a task", () => {
    const s = summarizeJobAutomation(tasks);
    expect(s.byAgent.map((a) => a.agent)).toEqual(["comms", "scheduling", "finance"]);
    const comms = s.byAgent.find((a) => a.agent === "comms")!;
    expect(comms).toEqual({ agent: "comms", label: "Comms", total: 2, full: 2, partial: 0, manual: 0 });
  });

  it("treats null/unknown automationLevel as manual", () => {
    const s = summarizeJobAutomation([{ ownerAgent: "comms", automationLevel: null, status: "pending" }]);
    expect(s.manual).toBe(1);
    expect(s.autonomyPct).toBe(0);
  });

  it("is all-zero for no tasks", () => {
    expect(summarizeJobAutomation([])).toEqual({
      total: 0, full: 0, partial: 0, manual: 0, autonomyPct: 0, needsYouCount: 0, byAgent: [],
    });
  });
});
