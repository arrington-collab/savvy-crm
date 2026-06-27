import { describe, it, expect } from "vitest";
import { parseJobsConfig, leadToJobType } from "./jobs-config";

describe("parseJobsConfig", () => {
  it("fills defaults from empty/undefined input", () => {
    const c = parseJobsConfig(undefined);
    expect(c.stageThresholds.estimate).toBe(7);
    expect(c.stageThresholds.production).toBe(14);
    expect(c.buildSlaDays.retail).toBe(21);
    expect(c.buildSlaDays.insurance).toBe(45);
  });
  it("applies per-tenant overrides and keeps other defaults", () => {
    const c = parseJobsConfig({ stageThresholds: { estimate: 3 }, buildSlaDays: { insurance: 60 } });
    expect(c.stageThresholds.estimate).toBe(3);
    expect(c.stageThresholds.billing).toBe(10); // default preserved
    expect(c.buildSlaDays.insurance).toBe(60);
    expect(c.buildSlaDays.retail).toBe(21); // default preserved
  });
});

describe("leadToJobType", () => {
  it("maps storm lane to insurance and everything else to retail", () => {
    expect(leadToJobType("storm")).toBe("insurance");
    expect(leadToJobType("tile")).toBe("retail");
    expect(leadToJobType("standard")).toBe("retail");
    expect(leadToJobType(null)).toBe("retail");
  });
});
