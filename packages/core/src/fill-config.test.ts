import { describe, expect, it } from "vitest";
import { parseSlowWeekFillConfig } from "./fill-config";

describe("parseSlowWeekFillConfig", () => {
  it("returns spec defaults for missing config", () => {
    const c = parseSlowWeekFillConfig(undefined);
    expect(c.enabled).toBe(true);
    expect(c.gapLookaheadDays).toBe(10); // spec: hole opens inside N days, default 10
    expect(c.minUtilizationPct).toBe(60);
    expect(c.agingEstimateDays).toBe(7);
    expect(c.discountBps).toBe(500);
    expect(c.maxAutoDiscountBps).toBe(1000);
  });

  it("honors tenant overrides", () => {
    const c = parseSlowWeekFillConfig({ gapLookaheadDays: 14, discountBps: 750, enabled: false });
    expect(c.gapLookaheadDays).toBe(14);
    expect(c.discountBps).toBe(750);
    expect(c.enabled).toBe(false);
  });

  it("falls back per-field on garbage values", () => {
    const c = parseSlowWeekFillConfig({ gapLookaheadDays: "soon", discountBps: -5 });
    expect(c.gapLookaheadDays).toBe(10);
    expect(c.discountBps).toBe(500);
  });
});
