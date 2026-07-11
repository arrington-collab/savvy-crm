import { describe, it, expect, vi } from "vitest";
import { composeShiftReport } from "./shift-report";
import { templateShiftReport, type AgentCoverage } from "@savvy/core";

const coverage: AgentCoverage[] = [
  { agent: "comms", label: "Comms", total: 3, ok: 3, error: 0, skipped: 0, lastRunAt: null },
];

describe("composeShiftReport", () => {
  it("ships the model's factual text and records the model id", async () => {
    const clean = "Overnight I ran 3 actions with the Comms agent.";
    const aiClient = { complete: vi.fn().mockResolvedValue({ text: clean, model: "gemini-flash" }) };
    const r = await composeShiftReport(coverage, aiClient);
    expect(r.narrative).toBe(clean);
    expect(r.modelUsed).toBe("gemini-flash");
    // requested a cheap capability by name, never a hard-coded model string
    expect(aiClient.complete.mock.calls[0]![0].capability).toBe("workhorse");
  });

  it("falls back to the template (modelUsed null) when the gateway throws", async () => {
    const aiClient = { complete: vi.fn().mockRejectedValue(new Error("credit balance too low")) };
    const r = await composeShiftReport(coverage, aiClient);
    expect(r.narrative).toBe(templateShiftReport(coverage));
    expect(r.modelUsed).toBeNull();
  });

  it("falls back to the template when the model returns hype", async () => {
    const aiClient = { complete: vi.fn().mockResolvedValue({ text: "An amazing, blazing night!", model: "gemini-flash" }) };
    const r = await composeShiftReport(coverage, aiClient);
    expect(r.narrative).toBe(templateShiftReport(coverage));
    expect(r.modelUsed).toBeNull();
  });
});
