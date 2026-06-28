import { describe, it, expect, vi, afterEach } from "vitest";
import { httpForecastNws, makeFakeForecast } from "./forecast";

afterEach(() => { vi.restoreAllMocks(); delete process.env.WEATHER_PROVIDER; });

const POINTS = { properties: { forecast: "https://api.weather.gov/gridpoints/PSR/100,100/forecast" } };
const FORECAST = { properties: { periods: [
  { number: 1, startTime: "2026-07-01T06:00:00-07:00", isDaytime: true, probabilityOfPrecipitation: { value: 80 }, windSpeed: "10 to 20 mph", shortForecast: "Showers" },
  { number: 2, startTime: "2026-07-01T18:00:00-07:00", isDaytime: false, probabilityOfPrecipitation: { value: 30 }, windSpeed: "5 mph", shortForecast: "Clear" },
  { number: 3, startTime: "2026-07-02T06:00:00-07:00", isDaytime: true, probabilityOfPrecipitation: { value: null }, windSpeed: "5 to 10 mph", shortForecast: "Sunny" },
] } };

describe("httpForecastNws", () => {
  it("parses daytime periods: windSpeed max, null precip → 0", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => POINTS })
      .mockResolvedValueOnce({ ok: true, json: async () => FORECAST });
    vi.stubGlobal("fetch", fetchMock);
    const days = await httpForecastNws.getForecast({ lat: 33.4, lng: -112.0, days: 7 });
    expect(days).toEqual([
      { date: "2026-07-01", maxWindMph: 20, precipProbability: 80, shortForecast: "Showers" },
      { date: "2026-07-02", maxWindMph: 10, precipProbability: 0, shortForecast: "Sunny" },
    ]);
    // sends a User-Agent (NWS requires it)
    expect((fetchMock.mock.calls[0]![1] as { headers: Record<string,string> }).headers["User-Agent"]).toBeTruthy();
  });
  it("throws on a non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) }));
    await expect(httpForecastNws.getForecast({ lat: 1, lng: 2, days: 7 })).rejects.toThrow();
  });
});

describe("makeFakeForecast", () => {
  it("is all-clear (flags nothing)", async () => {
    const days = await makeFakeForecast().getForecast({ lat: 1, lng: 2, days: 7 });
    expect(days.length).toBeGreaterThan(0);
    for (const d of days) { expect(d.precipProbability).toBe(0); expect(d.maxWindMph).toBeLessThan(10); }
  });
});
