# D1b — Weather reschedule (flag at-risk crew appointments) — Design

**Date:** 2026-06-28
**Slice:** Jobs build, slice D1b.

## Problem

Roofing crews can't install in rain/high wind, but Savvy has no forward weather signal — there's no
forecast integration (StormProof is storm *history* for certs/enrichment, not a forecast). A crew
install booked into bad weather is discovered the morning of, causing wasted trips and no-shows.

## Goal

Detect adverse weather for upcoming **crew (install) appointments** and **flag** them so a human
reschedules. Decided with Brett: **forecast source = NWS/weather.gov** (free, no key, US); **action =
flag in `/exceptions`** (a human reschedules via the existing `/schedule` — no auto-reschedule,
consistent with C Part 2's defer-to-human philosophy and roofing reality).

## Approach

A daily Inngest cron evaluates each tenant's upcoming scheduled crew appointments against the NWS
forecast for the property's lat/lng, and writes a durable **weather flag** on at-risk appointments
(clearing it when they're no longer at risk). The Exception Queue surfaces flagged appointments as a
new `weather_at_risk` vector — mirroring the durable-marker pattern from C Part 2 (`deferred_at`).

**Dormant by default:** the env-selected forecast gateway returns the **fake all-clear** forecast
unless `WEATHER_PROVIDER=nws` is set, so nothing is flagged until a tenant/deploy opts in — zero
false flags, suite stays green.

### 1. Forecast integration (`packages/integrations/src/forecast.ts`)

```ts
export type DailyForecast = { date: string /* YYYY-MM-DD */; maxWindMph: number; precipProbability: number; shortForecast: string };
export interface ForecastGateway { getForecast(o: { lat: number; lng: number; days: number }): Promise<DailyForecast[]>; }
export const httpForecastNws: ForecastGateway;   // NWS: GET /points/{lat},{lng} → .properties.forecast → GET it → map daytime periods
export function makeFakeForecast(): ForecastGateway; // deterministic ALL-CLEAR (precip 0, wind 5) → flags nothing
export const forecast: ForecastGateway = process.env.WEATHER_PROVIDER === "nws" ? httpForecastNws : makeFakeForecast();
```

- NWS is a 2-call flow with a required `User-Agent` header. Parse `windSpeed` ("5 to 10 mph" → max 10),
  `probabilityOfPrecipitation.value` (null → 0), `shortForecast`; one `DailyForecast` per **daytime**
  period (`isDaytime`), `date` = the period's local date. `getForecast` throws on a non-ok response
  (callers treat a forecast failure as best-effort: skip that appointment).
- Tested via **mocked `fetch`** against captured NWS sample JSON (like `stormproof.test.ts`) — CI never
  calls out.

### 2. Weather config + risk rule (`packages/core/src/weather-config.ts`)

```ts
parseWeatherConfig(raw) → { enabled: boolean(true); maxWindMph: number(25); maxPrecipPct: number(60); lookAheadDays: number(7) }  // tenant.settings.weather
assessWeatherRisk(day: { maxWindMph; precipProbability }, cfg) → { atRisk: boolean; reason: string }
  // atRisk if precipProbability >= maxPrecipPct OR maxWindMph >= maxWindMph; reason e.g. "Rain 80%", "Wind 32mph", or both
```

Pure, unit-tested. Exported from the core index.

### 3. DB — durable flag (`appointment` columns + lifecycle)

- **Migration:** add nullable `appointment.weather_note text` + `appointment.weather_flagged_at timestamptz`
  (appointment already has `tenantIsolation()` RLS — a column add needs no new policy).
- `setAppointmentWeatherFlag({ tenantId, appointmentId, note: string | null })`: `note` set → write
  `weather_note=note, weather_flagged_at=now`; `note=null` → clear both. Only touches `status='scheduled'`
  appts. Exported from `@savvy/db`.

### 4. Cron (`packages/agents/src/functions/weather-reschedule.ts`)

```ts
evaluateTenantWeather(tenantId, client: ForecastGateway, now: Date) → { flagged: number; cleared: number }
```
- parse `weather`/`finance` config; if `!enabled` → no-op. Window = `[now, now + lookAheadDays]` (tenant tz).
- select `status='scheduled'`, `type='crew'` appts with `startsAt` in window, joined to `job→property`
  for lat/lng. Skip appts without lat/lng.
- per appt: `getForecast` (best-effort, try/catch → skip on error); match the appt's civil date
  (`toCivilDate(startsAt, tz)`) to a `DailyForecast.date`; `assessWeatherRisk` → `setAppointmentWeatherFlag`
  with the reason (at risk) or `null` (clear). Count flagged/cleared.
- Inngest wrapper: daily cron (`TZ=America/Phoenix 0 5 * * *`, `concurrency: { limit: 1 }`); list tenants;
  loop `evaluateTenantWeather(t.id, forecast, new Date())`. **Register it** in the agents Inngest function
  list. `client` is injectable so tests pass a stub forecast.

### 5. Exception vector (`weather_at_risk`)

- Core `buildExceptionQueue`: `ExceptionKind` += `"weather_at_risk"`; `KINDS` += it;
  `WeatherAtRiskInput = { appointmentId; jobId; apptType: string; startsAt: Date; customerName: string | null; note: string }`;
  required `weatherAtRisks` on `ExceptionQueueInput`; loop → severity **medium**, title `customerName ?? "—"`,
  detail `${note} — reschedule`, href `/schedule`, occurredAt `startsAt`.
- Web `exception-queries.ts`: a query for appts where `weather_flagged_at is not null AND status='scheduled'
  AND starts_at > now`, joined to customer → `weatherAtRisks`. `/exceptions` page label `weather_at_risk: "Weather risk"`.

## Testing

- **Core unit:** `parseWeatherConfig` defaults/overrides; `assessWeatherRisk` (rain-only, wind-only, both, clear);
  `weather_at_risk` exception vector.
- **Integration:** `forecast.test.ts` — mocked `fetch` parses NWS sample (windSpeed range → max, null precip → 0,
  daytime-only), throws on non-ok; `makeFakeForecast` is all-clear.
- **DB:** `setAppointmentWeatherFlag` set + clear.
- **Agents:** `evaluateTenantWeather` with an injected stub forecast — flags an at-risk crew appt (writes note +
  flagged_at), clears when the stub returns clear, no-ops when config disabled / no lat-lng.
- **e2e** (`weather-exceptions.spec.ts`): seed a crew appt with `weather_flagged_at` + `weather_note` → `/exceptions`
  shows a "Weather risk" row (scoped to stamped name, never `queue.total`).
- **Docs:** `docs/jobs-pipeline.md` + `.env.example` gains `WEATHER_PROVIDER`.

## Assumptions / decisions

- **[Brett]** Source = NWS; action = flag-only (no auto-reschedule).
- **[DECISION] Dormant by default** — fake forecast = all-clear; real NWS only when `WEATHER_PROVIDER=nws`.
- **[DECISION] Durable flag on `appointment`** (mirrors C Part 2's `deferred_at`) — the cron can't run a forecast
  inside a page render; the exception query reads the flag.
- **[ASSUMED]** Match forecast day to the appt's civil date in the tenant tz (US single-tz tenants); appts beyond
  the forecast horizon or with no matching day are left unchanged.
- **[ASSUMED]** New vector `weather_at_risk` (future, proactive) rather than reusing `appointment_missed` (past/no-show).

## Out of scope

- **No auto-reschedule / no slot suggestions in this slice** (Brett chose flag-only). `computeOpenSlots` is available
  for a future "suggest slots" follow-up.
- **No settings UI** for the weather thresholds (config-driven via `tenant.settings.weather`, like `requiredPhotos`).
- **No per-lat/lng forecast caching** (one call per appt; fine at current scale).
- US-only (NWS). Non-US tenants would need a different provider.
