import { describe, it, expect } from "vitest";
import { parseWeatherConfig, assessWeatherRisk, pickRescheduleSlot } from "./weather-config";

describe("parseWeatherConfig", () => {
  it("defaults", () => {
    expect(parseWeatherConfig(undefined)).toEqual({ enabled: true, maxWindMph: 25, maxPrecipPct: 60, lookAheadDays: 7, autoReschedule: true });
  });
  it("merges overrides", () => {
    expect(parseWeatherConfig({ maxWindMph: 30, enabled: false }).maxWindMph).toBe(30);
    expect(parseWeatherConfig({ enabled: false }).enabled).toBe(false);
  });
  it("defaults autoReschedule to true", () => {
    expect(parseWeatherConfig({}).autoReschedule).toBe(true);
  });
  it("respects autoReschedule=false", () => {
    expect(parseWeatherConfig({ autoReschedule: false }).autoReschedule).toBe(false);
  });
});

describe("assessWeatherRisk", () => {
  const cfg = parseWeatherConfig(undefined);
  it("flags high precip", () => {
    const r = assessWeatherRisk({ maxWindMph: 5, precipProbability: 80 }, cfg);
    expect(r.atRisk).toBe(true);
    expect(r.reason).toBe("Rain 80%");
  });
  it("flags high wind", () => {
    const r = assessWeatherRisk({ maxWindMph: 32, precipProbability: 0 }, cfg);
    expect(r.atRisk).toBe(true);
    expect(r.reason).toBe("Wind 32mph");
  });
  it("flags both", () => {
    expect(assessWeatherRisk({ maxWindMph: 30, precipProbability: 70 }, cfg).reason).toBe("Rain 70%, Wind 30mph");
  });
  it("clear day is not at risk", () => {
    expect(assessWeatherRisk({ maxWindMph: 5, precipProbability: 10 }, cfg).atRisk).toBe(false);
  });
});

describe("pickRescheduleSlot", () => {
  const cfg = parseWeatherConfig({ maxWindMph: 25, maxPrecipPct: 60 });
  const clear = (date: string) => ({ date, maxWindMph: 5, precipProbability: 10 });
  const rainy = (date: string) => ({ date, maxWindMph: 5, precipProbability: 90 });

  it("picks the earliest safe, crew-free day after the original", () => {
    const got = pickRescheduleSlot({
      days: [rainy("2026-07-06"), rainy("2026-07-07"), clear("2026-07-08"), clear("2026-07-09")],
      originalCivilDate: "2026-07-06", crewBusyDates: new Set(), cfg,
    });
    expect(got).toBe("2026-07-08");
  });

  it("skips days the crew is already booked", () => {
    const got = pickRescheduleSlot({
      days: [clear("2026-07-07"), clear("2026-07-08")],
      originalCivilDate: "2026-07-06", crewBusyDates: new Set(["2026-07-07"]), cfg,
    });
    expect(got).toBe("2026-07-08");
  });

  it("never picks the original day or earlier", () => {
    const got = pickRescheduleSlot({
      days: [clear("2026-07-05"), clear("2026-07-06")],
      originalCivilDate: "2026-07-06", crewBusyDates: new Set(), cfg,
    });
    expect(got).toBeNull();
  });

  it("returns null when every later day is at-risk or busy", () => {
    const got = pickRescheduleSlot({
      days: [rainy("2026-07-07"), clear("2026-07-08")],
      originalCivilDate: "2026-07-06", crewBusyDates: new Set(["2026-07-08"]), cfg,
    });
    expect(got).toBeNull();
  });
});
