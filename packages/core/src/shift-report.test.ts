import { describe, test, expect } from "vitest";
import {
  HYPE_WORDS,
  findHypeWords,
  isFactual,
  templateShiftReport,
  shiftReportPrompt,
  chooseShiftReport,
} from "./shift-report";
import type { AgentCoverage } from "./agent-activity";

const cov = (o: Partial<AgentCoverage> & Pick<AgentCoverage, "agent" | "label" | "total">): AgentCoverage => ({
  ok: o.total,
  error: 0,
  skipped: 0,
  lastRunAt: null,
  ...o,
});

const sample: AgentCoverage[] = [
  cov({ agent: "comms", label: "Comms", total: 20, ok: 18, error: 1, skipped: 1 }),
  cov({ agent: "scheduling", label: "Scheduling", total: 12, ok: 12 }),
  cov({ agent: "finance", label: "Finance", total: 0 }),
];

describe("findHypeWords / isFactual", () => {
  test("clean factual text has no hype words", () => {
    expect(findHypeWords("Ran 20 actions across 2 agents. 1 needs a look.")).toEqual([]);
    expect(isFactual("Ran 20 actions across 2 agents.")).toBe(true);
  });

  test("flags the spec's marketing adjectives (case-insensitive)", () => {
    expect(findHypeWords("This was an AMAZING and blazing, incredible night")).toEqual(
      expect.arrayContaining(["amazing", "blazing", "incredible"]),
    );
    expect(isFactual("Agents worked tirelessly and seamlessly")).toBe(false);
  });

  test("matches whole words only (no substring false positives)", () => {
    // "Scheduling" must not trip on any hype stem; plain nouns stay factual.
    expect(findHypeWords("Scheduling booked 12 appointments")).toEqual([]);
  });

  test("HYPE_WORDS is non-empty and lowercased", () => {
    expect(HYPE_WORDS.length).toBeGreaterThan(5);
    expect(HYPE_WORDS.every((w) => w === w.toLowerCase())).toBe(true);
  });
});

describe("templateShiftReport", () => {
  test("states the real totals and per-agent counts", () => {
    const s = templateShiftReport(sample);
    expect(s).toContain("32"); // 20 + 12
    expect(s).toContain("Comms 20");
    expect(s).toContain("Scheduling 12");
    expect(s).not.toContain("Finance"); // zero-total agents omitted
    expect(isFactual(s)).toBe(true);
  });

  test("surfaces errors and no-ops honestly", () => {
    const s = templateShiftReport(sample);
    expect(s).toMatch(/1 need/); // one error
    expect(s).toMatch(/1 (was|were).*no-op/); // one skipped
  });

  test("zero activity reads as a quiet, honest line", () => {
    const s = templateShiftReport([cov({ agent: "finance", label: "Finance", total: 0 })]);
    expect(s).toMatch(/no agent activity/i);
    expect(isFactual(s)).toBe(true);
  });
});

describe("shiftReportPrompt", () => {
  test("system forbids hype; prompt carries the real numbers", () => {
    const { system, prompt } = shiftReportPrompt(sample);
    expect(system.toLowerCase()).toMatch(/factual|hype|marketing/);
    expect(prompt).toContain("Comms");
    expect(prompt).toContain("20");
  });
});

describe("chooseShiftReport (honesty gate)", () => {
  test("null model text -> template", () => {
    expect(chooseShiftReport(null, sample)).toBe(templateShiftReport(sample));
  });

  test("empty / whitespace model text -> template", () => {
    expect(chooseShiftReport("   ", sample)).toBe(templateShiftReport(sample));
  });

  test("hype model text -> template (never ships hype)", () => {
    const out = chooseShiftReport("An absolutely amazing, blazing-fast night!", sample);
    expect(out).toBe(templateShiftReport(sample));
    expect(isFactual(out)).toBe(true);
  });

  test("over-long model text -> template", () => {
    expect(chooseShiftReport("word ".repeat(400), sample)).toBe(templateShiftReport(sample));
  });

  test("clean model text is shipped, trimmed", () => {
    const clean = "Overnight I ran 32 actions across two agents.";
    expect(chooseShiftReport(`  ${clean}  `, sample)).toBe(clean);
  });
});
