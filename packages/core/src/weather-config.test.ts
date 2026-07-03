import { describe, it, expect } from "vitest";
import { parseWeatherConfig, assessWeatherRisk } from "./weather-config";

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
