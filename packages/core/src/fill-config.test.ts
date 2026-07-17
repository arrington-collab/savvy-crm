import { describe, expect, it } from "vitest";
import { buildFillLine, parseSlowWeekFillConfig } from "./fill-config";

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

describe("buildFillLine", () => {
  it("is silent when the week had no gaps and no plays", () => {
    expect(buildFillLine({ gaps: 0, playsSent: 0, conversions: 0, idleCrewDaysRecovered: 0, pendingCards: 0 })).toBeNull();
  });

  it("summarizes gaps, plays, conversions, recovered days and pending cards", () => {
    const line = buildFillLine({ gaps: 3, playsSent: 5, conversions: 2, idleCrewDaysRecovered: 4, pendingCards: 1 });
    expect(line).toContain("3 gap");
    expect(line).toContain("5 play");
    expect(line).toContain("2 converted");
    expect(line).toContain("4 crew-day");
    expect(line).toContain("1 discount card");
  });
});
