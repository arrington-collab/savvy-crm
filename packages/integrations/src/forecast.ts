export type DailyForecast = { date: string; maxWindMph: number; precipProbability: number; shortForecast: string };
export interface ForecastGateway { getForecast(o: { lat: number; lng: number; days: number }): Promise<DailyForecast[]>; }

const UA = "Savvy CRM (weather-reschedule; ops@savvy.example)";

/** "5 to 20 mph" / "15 mph" → 20 / 15 (max integer found, else 0). */
function maxWindMph(windSpeed: string | null | undefined): number {
  const nums = (windSpeed ?? "").match(/\d+/g)?.map(Number) ?? [];
  return nums.length ? Math.max(...nums) : 0;
}

export const httpForecastNws: ForecastGateway = {
  async getForecast({ lat, lng, days }) {
    const pRes = await fetch(`https://api.weather.gov/points/${lat},${lng}`, { headers: { "User-Agent": UA, Accept: "application/geo+json" } });
    if (!pRes.ok) throw new Error(`nws points ${pRes.status}`);
    const points = (await pRes.json()) as { properties?: { forecast?: string } };
    const url = points.properties?.forecast;
    if (!url) throw new Error("nws no forecast url");
    const fRes = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/geo+json" } });
    if (!fRes.ok) throw new Error(`nws forecast ${fRes.status}`);
    const data = (await fRes.json()) as { properties?: { periods?: Array<{ startTime: string; isDaytime: boolean; probabilityOfPrecipitation?: { value: number | null }; windSpeed?: string; shortForecast?: string }> } };
    const periods = data.properties?.periods ?? [];
    return periods
      .filter((p) => p.isDaytime)
      .slice(0, days)
      .map((p) => ({
        date: p.startTime.slice(0, 10),
        maxWindMph: maxWindMph(p.windSpeed),
        precipProbability: p.probabilityOfPrecipitation?.value ?? 0,
        shortForecast: p.shortForecast ?? "",
      }));
  },
};

/** Deterministic ALL-CLEAR forecast (precip 0, wind 5) — the default when WEATHER_PROVIDER!=nws, so nothing is flagged. */
export function makeFakeForecast(): ForecastGateway {
  return {
    async getForecast({ days }) {
      return Array.from({ length: days }, (_, i) => ({
        date: `2026-07-${String(i + 1).padStart(2, "0")}`,
        maxWindMph: 5, precipProbability: 0, shortForecast: "Clear",
      }));
    },
  };
}

export const forecast: ForecastGateway = process.env.WEATHER_PROVIDER === "nws" ? httpForecastNws : makeFakeForecast();
