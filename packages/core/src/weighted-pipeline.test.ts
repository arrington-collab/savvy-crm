import { describe, it, expect } from "vitest";
import { weightedPipeline, wowPct } from "./weighted-pipeline";
import { parsePipelineConfig } from "./pipeline-config";

const cfg = parsePipelineConfig(undefined); // approved 70%, estimate 30%

describe("weightedPipeline", () => {
  it("computes expected = gross * probability/100 per stage and totals", () => {
    const r = weightedPipeline(
      [{ stage: "approved", grossCents: 1_000_000 }, { stage: "estimate", grossCents: 500_000 }],
      cfg,
    );
    const approved = r.stages.find((s) => s.stage === "approved")!;
    expect(approved.expectedCents).toBe(700_000);
    expect(approved.probability).toBe(70);
    expect(r.grossCents).toBe(1_500_000);
    expect(r.expectedCents).toBe(700_000 + 150_000);
  });
  it("treats a stage with no configured probability as 0", () => {
    const r = weightedPipeline([{ stage: "lost" as never, grossCents: 999 }], cfg);
    expect(r.stages[0]!.probability).toBe(0);
    expect(r.stages[0]!.expectedCents).toBe(0);
  });
});

describe("wowPct", () => {
  it("computes rounded percent change", () => {
    expect(wowPct(120, 100)).toBe(20);
    expect(wowPct(80, 100)).toBe(-20);
  });
  it("returns null when there is no prior basis", () => {
    expect(wowPct(100, 0)).toBeNull();
    expect(wowPct(100, -5)).toBeNull();
  });
});
