import { describe, it, expect } from "vitest";
import { parsePipelineConfig } from "./pipeline-config";

describe("parsePipelineConfig", () => {
  it("fills win-probability defaults for every open stage", () => {
    const c = parsePipelineConfig(undefined);
    expect(c.stageWinProbability).toEqual({ lead: 5, inspected: 15, estimate: 30, approved: 70, production: 90, closeout: 95, billing: 98 });
  });
  it("applies overrides and keeps other defaults", () => {
    const c = parsePipelineConfig({ stageWinProbability: { approved: 60 } });
    expect(c.stageWinProbability.approved).toBe(60);
    expect(c.stageWinProbability.estimate).toBe(30);
  });
});
