# Weather Reschedule (D1b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A daily cron flags upcoming crew (install) appointments that fall on bad-weather days (NWS forecast) with a durable marker; the Exception Queue surfaces them as a new `weather_at_risk` row for a human to reschedule. Dormant by default (fake forecast = all-clear unless `WEATHER_PROVIDER=nws`).

**Architecture:** New NWS forecast gateway (env-selected real/fake) + a pure weather config/risk helper + a durable flag on `appointment` (`weather_note`, `weather_flagged_at`, mirroring C Part 2's `deferred_at`) + a cron that evaluates per tenant and sets/clears the flag + a `weather_at_risk` exception vector. Flag-only — no auto-reschedule.

**Tech Stack:** TypeScript, Drizzle ORM (Postgres + RLS), Inngest (cron), NWS API (mocked in tests), Vitest, Playwright.

## Global Constraints

- **`.js` import rule:** db/agents `.test.ts` files USE `.js` extensions; core/integrations/db/agents/web **source** files use NO `.js`. Inside `packages/core`, import `z` from `"./schemas"`.
- **apps/web is NOT in the vitest workspace** — verify the web layer via `pnpm typecheck` + Playwright e2e only.
- **Dormant by default:** `makeFakeForecast()` returns ALL-CLEAR (precip 0, wind 5) and is the export unless `WEATHER_PROVIDER=nws`. So nothing is flagged in CI / by default; existing suite stays green.
- **Migration discipline (CI gotcha):** after `pnpm db:generate`, commit the `.sql` AND its drizzle meta (`_journal.json` entry + the new `NNNN_snapshot.json`) — CI runs migrations on a FRESH DB and silently skips a migration whose journal entry is missing. The migration must be only `ALTER TABLE "appointment" ADD COLUMN ...` (two columns), NO drops.
- **Three required ExceptionQueueInput fields already exist** (`materialDeliveries`, `taskNeedsApprovals`); this slice adds `weatherAtRisks` (also required) → every `buildExceptionQueue` caller (core test + `exception-queries.ts`) must pass it; typecheck enforces it.
- **e2e:** assertions scope to per-run stamped customer names — never `queue.total`.
- **Tenant isolation:** all queries via `withTenant`; the new columns live on the already-RLS'd `appointment`; the cron uses `adminDb` only to list tenant ids (like `cold-archive.ts`) then `withTenant` per tenant.
- **Inngest free-plan cap:** keep `concurrency.limit` ≤ 5 (the cron uses 1).
- **New Inngest function MUST be registered** in the agents function list (where `coldArchiveDocuments` is registered) or it won't sync.
- Focused test commands:
  - core → `pnpm --filter @savvy/core exec vitest run src/weather-config.test.ts src/exception-queue.test.ts`
  - integrations → `pnpm --filter @savvy/integrations exec vitest run src/forecast.test.ts`
  - db → `pnpm --filter @savvy/db exec vitest run tests/weather-flag.test.ts` (needs docker `savvy_db`; `pnpm db:up && pnpm --filter @savvy/db db:migrate` if `ECONNREFUSED`)
  - agents → `pnpm --filter @savvy/agents exec vitest run src/functions/weather-reschedule.test.ts`
  - e2e → from `apps/web`: `npx tsx tests/e2e/create-tenant.ts && export TEST_TENANT_ID=$(node -e "console.log(require('/tmp/savvy-e2e-tenant.json').id)") && ./node_modules/.bin/playwright test tests/e2e/weather-exceptions.spec.ts`
- Final gate: `pnpm test && pnpm typecheck && pnpm lint` all green.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `packages/core/src/weather-config.ts` | `parseWeatherConfig` + `assessWeatherRisk` | Create |
| `packages/core/src/weather-config.test.ts` | unit tests | Create |
| `packages/core/src/index.ts` | export weather-config | Modify (append) |
| `packages/integrations/src/forecast.ts` | NWS gateway + fake + env-select | Create |
| `packages/integrations/src/forecast.test.ts` | mocked-fetch tests | Create |
| `packages/integrations/src/index.ts` | export forecast | Modify |
| `packages/db/src/schema/comms.ts` | `weather_note` + `weather_flagged_at` on `appointment` | Modify |
| `packages/db/drizzle/*` | generated migration + meta | Create |
| `packages/db/src/lifecycle/appointments.ts` | `setAppointmentWeatherFlag` | Modify |
| `packages/db/src/index.ts` | export it | Modify |
| `packages/db/tests/weather-flag.test.ts` | set/clear tests | Create |
| `packages/agents/src/functions/weather-reschedule.ts` | cron + `evaluateTenantWeather` | Create |
| `packages/agents/src/<function registry>` | register the cron | Modify |
| `packages/agents/src/functions/weather-reschedule.test.ts` | cron helper tests (stub forecast) | Create |
| `packages/core/src/exception-queue.ts` | `weather_at_risk` vector | Modify |
| `packages/core/src/exception-queue.test.ts` | vector test + field on inputs | Modify |
| `apps/web/src/lib/exception-queries.ts` | gather weather-flagged appts | Modify |
| `apps/web/src/app/(app)/exceptions/page.tsx` | `KIND_LABEL` entry | Modify |
| `apps/web/tests/e2e/weather-exceptions.spec.ts` | e2e | Create |
| `docs/jobs-pipeline.md`, `.env.example` | docs + env | Modify |

---

## Task 1: Core — weather config + risk rule (haiku)

**Files:** Create `packages/core/src/weather-config.ts` + `.test.ts`; Modify `packages/core/src/index.ts`.

**Produces:** `parseWeatherConfig(raw) → WeatherConfig`; `assessWeatherRisk(day, cfg) → { atRisk: boolean; reason: string }`.

- [ ] **Step 1: Write the failing tests** — `packages/core/src/weather-config.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { parseWeatherConfig, assessWeatherRisk } from "./weather-config";

describe("parseWeatherConfig", () => {
  it("defaults", () => {
    expect(parseWeatherConfig(undefined)).toEqual({ enabled: true, maxWindMph: 25, maxPrecipPct: 60, lookAheadDays: 7 });
  });
  it("merges overrides", () => {
    expect(parseWeatherConfig({ maxWindMph: 30, enabled: false }).maxWindMph).toBe(30);
    expect(parseWeatherConfig({ enabled: false }).enabled).toBe(false);
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
```

- [ ] **Step 2: Run → fail.** `pnpm --filter @savvy/core exec vitest run src/weather-config.test.ts`

- [ ] **Step 3: Implement** — `packages/core/src/weather-config.ts`:
```ts
import { z } from "./schemas";

const weatherSchema = z.object({
  enabled: z.boolean().default(true),
  maxWindMph: z.number().int().positive().default(25),
  maxPrecipPct: z.number().int().min(0).max(100).default(60),
  lookAheadDays: z.number().int().min(1).max(30).default(7),
});
export type WeatherConfig = z.infer<typeof weatherSchema>;
export function parseWeatherConfig(raw: unknown): WeatherConfig {
  return weatherSchema.parse(raw ?? {});
}

/** Pure risk rule for one day's forecast against a tenant's thresholds. */
export function assessWeatherRisk(
  day: { maxWindMph: number; precipProbability: number },
  cfg: WeatherConfig,
): { atRisk: boolean; reason: string } {
  const reasons: string[] = [];
  if (day.precipProbability >= cfg.maxPrecipPct) reasons.push(`Rain ${day.precipProbability}%`);
  if (day.maxWindMph >= cfg.maxWindMph) reasons.push(`Wind ${day.maxWindMph}mph`);
  return { atRisk: reasons.length > 0, reason: reasons.join(", ") };
}
```
Append to `packages/core/src/index.ts` (END): `export * from "./weather-config";`

- [ ] **Step 4: Run → pass.** Same command.
- [ ] **Step 5: Commit** — `git add packages/core/src/weather-config.ts packages/core/src/weather-config.test.ts packages/core/src/index.ts && git commit -m "feat(core): weather config + assessWeatherRisk"`

---

## Task 2: Integration — NWS forecast gateway (sonnet)

**Files:** Create `packages/integrations/src/forecast.ts` + `.test.ts`; Modify `packages/integrations/src/index.ts`.

**Produces:** `DailyForecast`, `ForecastGateway`, `httpForecastNws`, `makeFakeForecast`, `forecast` (env-selected).

- [ ] **Step 1: Write the failing tests** — `packages/integrations/src/forecast.test.ts` (mirror `stormproof.test.ts` mocked-fetch style):
```ts
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
```

- [ ] **Step 2: Run → fail.** `pnpm --filter @savvy/integrations exec vitest run src/forecast.test.ts`

- [ ] **Step 3: Implement** — `packages/integrations/src/forecast.ts`:
```ts
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
```
Add to `packages/integrations/src/index.ts` (match how `stormproof` is re-exported there): `export * from "./forecast";`

- [ ] **Step 4: Run → pass.** Same command.
- [ ] **Step 5: Commit** — `git add packages/integrations/src/forecast.ts packages/integrations/src/forecast.test.ts packages/integrations/src/index.ts && git commit -m "feat(integrations): NWS weather forecast gateway (env-selected, fake all-clear)"`

---

## Task 3: DB — weather flag columns + lifecycle (sonnet)

**Files:** Modify `packages/db/src/schema/comms.ts`, `packages/db/src/lifecycle/appointments.ts`, `packages/db/src/index.ts`; Create migration + `packages/db/tests/weather-flag.test.ts`.

- [ ] **Step 1: Add columns** — in `packages/db/src/schema/comms.ts`, add to the `appointment` table (near `gcalEventId`):
```ts
  weatherNote: text("weather_note"),
  weatherFlaggedAt: timestamp("weather_flagged_at", { withTimezone: true }),
```
(Confirm `text` + `timestamp` are already imported in that file — they are.)

- [ ] **Step 2: Generate + inspect + apply** — `pnpm db:generate`; inspect the new `packages/db/drizzle/0028_*.sql` (must be only `ALTER TABLE "appointment" ADD COLUMN "weather_note" text;` + `ADD COLUMN "weather_flagged_at" timestamp with time zone;`, NO drops); confirm `_journal.json` + `0028_snapshot.json`; then `pnpm db:up && pnpm --filter @savvy/db db:migrate`.

- [ ] **Step 3: Write the failing test** — `packages/db/tests/weather-flag.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { withTenant } from "../src/tenant.js";
import { setAppointmentWeatherFlag } from "../src/lifecycle/appointments.js";
import { appointment } from "../src/schema/index.js";
import { adminDb } from "../src/admin-client.js";
import { eq } from "drizzle-orm";
import { makeTenant, makeJobWithCustomer } from "./helpers.js";

async function seedCrewAppt(): Promise<{ tenantId: string; appointmentId: string }> {
  const { tenantId } = await makeTenant();
  const { jobId, customerId } = await makeJobWithCustomer(tenantId);
  const now = new Date();
  const [a] = await adminDb.insert(appointment).values({
    tenantId, jobId, customerId, type: "crew", status: "scheduled",
    startsAt: new Date(now.getTime() + 2 * 86_400_000), endsAt: new Date(now.getTime() + 2 * 86_400_000 + 3_600_000),
  }).returning();
  return { tenantId, appointmentId: a!.id };
}

describe("setAppointmentWeatherFlag", () => {
  it("sets note + flagged_at, then clears on null", async () => {
    const { tenantId, appointmentId } = await seedCrewAppt();
    await setAppointmentWeatherFlag({ tenantId, appointmentId, note: "Rain 80%" });
    let [r] = await withTenant(tenantId, (tx) => tx.select({ n: appointment.weatherNote, f: appointment.weatherFlaggedAt }).from(appointment).where(eq(appointment.id, appointmentId)));
    expect(r!.n).toBe("Rain 80%");
    expect(r!.f).not.toBeNull();
    await setAppointmentWeatherFlag({ tenantId, appointmentId, note: null });
    [r] = await withTenant(tenantId, (tx) => tx.select({ n: appointment.weatherNote, f: appointment.weatherFlaggedAt }).from(appointment).where(eq(appointment.id, appointmentId)));
    expect(r!.n).toBeNull();
    expect(r!.f).toBeNull();
  });
});
```

- [ ] **Step 4: Run → fail.** `pnpm --filter @savvy/db exec vitest run tests/weather-flag.test.ts`

- [ ] **Step 5: Implement** — in `packages/db/src/lifecycle/appointments.ts` add (and ensure `appointment`, `and`, `eq`, `withTenant` are imported there — they are):
```ts
/** Set (note) or clear (note=null) the weather flag on a scheduled appointment. */
export async function setAppointmentWeatherFlag(input: {
  tenantId: string; appointmentId: string; note: string | null;
}): Promise<void> {
  await withTenant(input.tenantId, (tx) =>
    tx.update(appointment)
      .set({ weatherNote: input.note, weatherFlaggedAt: input.note ? new Date() : null })
      .where(and(eq(appointment.id, input.appointmentId), eq(appointment.status, "scheduled"))));
}
```
Export from `packages/db/src/index.ts` (add to the appointments lifecycle re-export line, or add a new `export { setAppointmentWeatherFlag } from "./lifecycle/appointments"` consistent with how `rescheduleAppointment` is exported).

- [ ] **Step 6: Run → pass.** Same command.
- [ ] **Step 7: Commit** — `git add packages/db/src/schema/comms.ts packages/db/drizzle packages/db/src/lifecycle/appointments.ts packages/db/src/index.ts packages/db/tests/weather-flag.test.ts && git commit -m "feat(db): appointment weather flag columns + setAppointmentWeatherFlag"`

---

## Task 4: Agents — weather-reschedule cron (sonnet)

**Files:** Create `packages/agents/src/functions/weather-reschedule.ts` + `.test.ts`; register the cron in the agents function list.

**Produces:** `evaluateTenantWeather(tenantId, client, now) → { flagged; cleared }` + `weatherReschedule` Inngest cron.

- [ ] **Step 1: Write the failing test** — `packages/agents/src/functions/weather-reschedule.test.ts`. It injects a stub `ForecastGateway` returning a risky day matching the seeded appt's date.
```ts
import { describe, it, expect } from "vitest";
import { adminDb, withTenant, tenant, appointment, customer, property, job, eq } from "@savvy/db";
import { toCivilDate } from "@savvy/core";
import type { ForecastGateway } from "@savvy/integrations";
import { evaluateTenantWeather } from "./weather-reschedule";

async function seed(): Promise<{ tenantId: string; apptId: string; apptDate: string; tz: string }> {
  const tz = "America/Phoenix";
  const [t] = await adminDb.insert(tenant).values({ name: "WX", publicKey: `pk-${crypto.randomUUID()}`, clerkOrgId: `org-${crypto.randomUUID()}`, settings: { weather: { enabled: true }, finance: { timezone: tz } } }).returning();
  const tenantId = t!.id;
  const [c] = await adminDb.insert(customer).values({ tenantId, name: "WX Cust" }).returning();
  const [p] = await adminDb.insert(property).values({ tenantId, customerId: c!.id, address: "1 Storm St", lat: 33.4, lng: -112.0 }).returning();
  const [j] = await adminDb.insert(job).values({ tenantId, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "production" }).returning();
  const startsAt = new Date(Date.now() + 2 * 86_400_000);
  const [a] = await adminDb.insert(appointment).values({ tenantId, jobId: j!.id, customerId: c!.id, type: "crew", status: "scheduled", startsAt, endsAt: new Date(startsAt.getTime() + 3_600_000) }).returning();
  return { tenantId, apptId: a!.id, apptDate: toCivilDate(startsAt.toISOString(), tz), tz };
}

function stub(days: Array<{ date: string; maxWindMph: number; precipProbability: number }>): ForecastGateway {
  return { async getForecast() { return days.map((d) => ({ ...d, shortForecast: "x" })); } };
}

describe("evaluateTenantWeather", () => {
  it("flags an at-risk crew appt, then clears when the forecast is clear", async () => {
    const { tenantId, apptId, apptDate } = await seed();
    const now = new Date();

    const r1 = await evaluateTenantWeather(tenantId, stub([{ date: apptDate, maxWindMph: 5, precipProbability: 90 }]), now);
    expect(r1.flagged).toBe(1);
    let [a] = await withTenant(tenantId, (tx) => tx.select({ n: appointment.weatherNote }).from(appointment).where(eq(appointment.id, apptId)));
    expect(a!.n).toBe("Rain 90%");

    const r2 = await evaluateTenantWeather(tenantId, stub([{ date: apptDate, maxWindMph: 5, precipProbability: 0 }]), now);
    expect(r2.cleared).toBe(1);
    [a] = await withTenant(tenantId, (tx) => tx.select({ f: appointment.weatherFlaggedAt }).from(appointment).where(eq(appointment.id, apptId)));
    expect(a!.f).toBeNull();
  });

  it("no-ops when weather disabled", async () => {
    const { tenantId } = await seed();
    await withTenant(tenantId, (tx) => tx.update(tenant).set({ settings: { weather: { enabled: false } } }).where(eq(tenant.id, tenantId)));
    const r = await evaluateTenantWeather(tenantId, stub([]), new Date());
    expect(r).toEqual({ flagged: 0, cleared: 0 });
  });
});
```
(Note: the disabled test updates `tenant.settings` via the tenant tx; `tenant` is exported from `@savvy/db`. Use `adminDb` if RLS blocks the tenant update — mirror how other agent tests mutate tenant settings.)

- [ ] **Step 2: Run → fail.** `pnpm --filter @savvy/agents exec vitest run src/functions/weather-reschedule.test.ts`

- [ ] **Step 3: Implement** — `packages/agents/src/functions/weather-reschedule.ts`:
```ts
import { adminDb, withTenant, tenant, appointment, job, property, setAppointmentWeatherFlag, and, eq, sql } from "@savvy/db";
import { parseWeatherConfig, parseFinanceConfig, assessWeatherRisk, toCivilDate } from "@savvy/core";
import { forecast, type ForecastGateway } from "@savvy/integrations";
import { inngest } from "../client";

/** Evaluate one tenant's upcoming scheduled crew appts against the forecast; set/clear weather flags. */
export async function evaluateTenantWeather(
  tenantId: string,
  client: ForecastGateway,
  now: Date,
): Promise<{ flagged: number; cleared: number }> {
  const [t] = await withTenant(tenantId, (tx) => tx.select({ settings: tenant.settings }).from(tenant).where(eq(tenant.id, tenantId)));
  const settings = (t?.settings ?? {}) as { weather?: unknown; finance?: unknown };
  const cfg = parseWeatherConfig(settings.weather);
  if (!cfg.enabled) return { flagged: 0, cleared: 0 };
  const tz = parseFinanceConfig(settings.finance).timezone;
  const windowEnd = new Date(now.getTime() + cfg.lookAheadDays * 86_400_000);

  const rows = await withTenant(tenantId, (tx) =>
    tx.select({ id: appointment.id, startsAt: appointment.startsAt, lat: property.lat, lng: property.lng })
      .from(appointment)
      .leftJoin(job, eq(job.id, appointment.jobId))
      .leftJoin(property, eq(property.id, job.propertyId))
      .where(and(eq(appointment.type, "crew"), eq(appointment.status, "scheduled"),
        sql`${appointment.startsAt} >= ${now} and ${appointment.startsAt} <= ${windowEnd}`)));

  let flagged = 0, cleared = 0;
  for (const r of rows) {
    if (r.lat == null || r.lng == null) continue;
    let days;
    try { days = await client.getForecast({ lat: r.lat, lng: r.lng, days: cfg.lookAheadDays }); }
    catch { continue; } // best-effort: a forecast failure skips this appt
    const apptDate = toCivilDate(r.startsAt.toISOString(), tz);
    const day = days.find((d) => d.date === apptDate);
    if (!day) continue; // beyond horizon / no matching day → leave unchanged
    const risk = assessWeatherRisk(day, cfg);
    await setAppointmentWeatherFlag({ tenantId, appointmentId: r.id, note: risk.atRisk ? risk.reason : null });
    if (risk.atRisk) flagged++; else cleared++;
  }
  return { flagged, cleared };
}

export const weatherReschedule = inngest.createFunction(
  { id: "weather-reschedule", concurrency: { limit: 1 } },
  { cron: "TZ=America/Phoenix 0 5 * * *" }, // daily 05:00
  async ({ step }) => {
    const tenants = await step.run("list-tenants", async () => adminDb.select({ id: tenant.id }).from(tenant));
    let flagged = 0, cleared = 0;
    for (const t of tenants) {
      const res = await step.run(`weather-${t.id}`, () => evaluateTenantWeather(t.id, forecast, new Date()));
      flagged += res.flagged; cleared += res.cleared;
    }
    return { flagged, cleared };
  },
);
```
**Register the cron:** find where `coldArchiveDocuments` is added to the Inngest functions array (grep `coldArchiveDocuments` across `packages/agents/src`) and add `weatherReschedule` alongside it (import + include in the exported functions list). Without this the cron won't sync.

- [ ] **Step 4: Run → pass.** Same command. Then `pnpm typecheck`.
- [ ] **Step 5: Commit** — `git add packages/agents/src && git commit -m "feat(agents): weather-reschedule cron flags at-risk crew appointments"`

---

## Task 5: Core — `weather_at_risk` exception vector (haiku)

**Files:** Modify `packages/core/src/exception-queue.ts` + `.test.ts`.

- [ ] **Step 1: Failing tests** — in `exception-queue.test.ts`, add `weatherAtRisks: []` to EVERY existing `buildExceptionQueue` input (the `base` const, any `baseInput`, and inline calls), then append:
```ts
describe("buildExceptionQueue weather_at_risk vector", () => {
  const base = { atRiskJobs: [], overdueInvoices: [], missedAppointments: [], overdueTasks: [], materialDeliveries: [], taskNeedsApprovals: [] };
  it("emits a medium weather item", () => {
    const startsAt = new Date("2026-07-02T16:00:00Z");
    const q = buildExceptionQueue({ ...base, weatherAtRisks: [{ appointmentId: "a1", jobId: "j1", apptType: "crew", startsAt, customerName: "Rainy Rita", note: "Rain 90%" }] });
    const row = q.items.find((i) => i.kind === "weather_at_risk");
    expect(row!.severity).toBe("medium");
    expect(row!.title).toBe("Rainy Rita");
    expect(row!.detail).toBe("Rain 90% — reschedule");
    expect(row!.href).toBe("/schedule");
    expect(row!.occurredAt).toEqual(startsAt);
    expect(q.counts.weather_at_risk).toBe(1);
  });
});
```

- [ ] **Step 2: Run → fail.** `pnpm --filter @savvy/core exec vitest run src/exception-queue.test.ts`

- [ ] **Step 3: Implement** — in `packages/core/src/exception-queue.ts`:
  - `ExceptionKind` += `"weather_at_risk"`; `KINDS` += it.
  - `export type WeatherAtRiskInput = { appointmentId: string; jobId: string; apptType: string; startsAt: Date; customerName: string | null; note: string };`
  - `ExceptionQueueInput` += `weatherAtRisks: WeatherAtRiskInput[];`
  - loop after `taskNeedsApprovals`, before the sort:
```ts
  for (const w of input.weatherAtRisks) {
    items.push({
      kind: "weather_at_risk",
      severity: "medium",
      title: w.customerName ?? "—",
      detail: `${w.note} — reschedule`,
      href: "/schedule",
      occurredAt: w.startsAt,
    });
  }
```

- [ ] **Step 4: Run → pass.** Same command.
- [ ] **Step 5: Commit** — `git add packages/core/src/exception-queue.ts packages/core/src/exception-queue.test.ts && git commit -m "feat(core): weather_at_risk exception vector"`

---

## Task 6: Web — gather weather-flagged appts + page label (sonnet)

**Files:** Modify `apps/web/src/lib/exception-queries.ts`, `apps/web/src/app/(app)/exceptions/page.tsx`.

- [ ] **Step 1: Add the query** — in `exception-queries.ts`, add `WeatherAtRiskInput` to the `@savvy/core` type import; add a block AFTER the `taskNeedsApprovals` block, BEFORE the final return (use `tx`; `appointment` + `customer` are already imported):
```ts
    // --- crew appointments flagged for bad weather (proactive, future) ---
    const wxRows = await tx
      .select({ id: appointment.id, jobId: appointment.jobId, apptType: appointment.type, startsAt: appointment.startsAt, note: appointment.weatherNote, customerName: customer.name })
      .from(appointment)
      .leftJoin(customer, eq(customer.id, appointment.customerId))
      .where(sql`${appointment.weatherFlaggedAt} is not null and ${appointment.status} = 'scheduled' and ${appointment.startsAt} > now()`);
    const weatherAtRisks: WeatherAtRiskInput[] = wxRows.map((r) => ({
      appointmentId: r.id, jobId: r.jobId, apptType: r.apptType, startsAt: r.startsAt, customerName: r.customerName, note: r.note ?? "Weather risk",
    }));
```
Add `weatherAtRisks` to the final `buildExceptionQueue({ ... })` call.

- [ ] **Step 2: Page label** — in `exceptions/page.tsx` `KIND_LABEL`, add `weather_at_risk: "Weather risk",`.

- [ ] **Step 3: Typecheck.** `pnpm typecheck` (clean — proves `weatherAtRisks` supplied + row maps to `WeatherAtRiskInput`).
- [ ] **Step 4: Commit** — `git add apps/web/src/lib/exception-queries.ts "apps/web/src/app/(app)/exceptions/page.tsx" && git commit -m "feat(web): surface weather-at-risk crew appointments in the exception queue"`

---

## Task 7: e2e + docs + full verification (sonnet)

**Files:** Create `apps/web/tests/e2e/weather-exceptions.spec.ts`; Modify `docs/jobs-pipeline.md`, `.env.example`.

- [ ] **Step 1: e2e spec** — `apps/web/tests/e2e/weather-exceptions.spec.ts` (mirror `material-exceptions.spec.ts`; seed a flagged crew appt directly):
```ts
/**
 * e2e: weather-at-risk crew appointments surface in /exceptions (D1b).
 * Seeds a future crew appt with weather_flagged_at + weather_note set (as the
 * cron would), asserts the /exceptions "Weather risk" row. Scoped to a stamped
 * customer name (the page aggregates ALL tenant rows).
 */
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { adminDb, customer, property, job, appointment } from "@savvy/db";

const { id: tenantId } = JSON.parse(readFileSync("/tmp/savvy-e2e-tenant.json", "utf8")) as { id: string };

test("a weather-flagged crew appt appears as a Weather risk exception", async ({ page }) => {
  const stamp = randomUUID().slice(0, 8);
  const name = `Rain Ray ${stamp}`;
  const [c] = await adminDb.insert(customer).values({ tenantId, name, email: `rain-${stamp}@e2e.test` }).returning();
  const [p] = await adminDb.insert(property).values({ tenantId, customerId: c!.id, address: `${stamp} Rain Rd`, lat: 33.4, lng: -112.0 }).returning();
  const [j] = await adminDb.insert(job).values({ tenantId, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "production" }).returning();
  const startsAt = new Date(Date.now() + 2 * 86_400_000);
  await adminDb.insert(appointment).values({
    tenantId, jobId: j!.id, customerId: c!.id, type: "crew", status: "scheduled",
    startsAt, endsAt: new Date(startsAt.getTime() + 3_600_000),
    weatherNote: "Rain 90%", weatherFlaggedAt: new Date(),
  });

  await page.goto("/exceptions");
  await expect(page.getByTestId("exceptions-page")).toBeVisible();
  const row = page.locator('[data-testid="exception-row"]', { hasText: name });
  await expect(row).toContainText("Weather risk");
  await expect(row).toContainText("Rain 90% — reschedule");
  await expect(row).toHaveAttribute("data-severity", "medium");
});
```

- [ ] **Step 2: Run the e2e** — from `apps/web`: `npx tsx tests/e2e/create-tenant.ts && export TEST_TENANT_ID=$(node -e "console.log(require('/tmp/savvy-e2e-tenant.json').id)") && ./node_modules/.bin/playwright test tests/e2e/weather-exceptions.spec.ts` → PASS. (If Postgres down: `pnpm db:up && pnpm --filter @savvy/db db:migrate` first.)

- [ ] **Step 3: Docs + env** — add a "Weather reschedule (D1b)" section to `docs/jobs-pipeline.md`:
```markdown
### Weather reschedule (D1b)

A daily Inngest cron (`weather-reschedule`) checks each tenant's upcoming scheduled **crew** (install)
appointments against the NWS forecast for the property's lat/lng. If a day exceeds the tenant's
`tenant.settings.weather` thresholds (`maxPrecipPct` 60, `maxWindMph` 25, `lookAheadDays` 7), it stamps
the appointment's `weather_note` + `weather_flagged_at`; otherwise it clears them. Flagged appointments
surface in `/exceptions` as a medium `weather_at_risk` row ("Rain 90% — reschedule"); a human reschedules
via `/schedule` (no auto-reschedule). The forecast gateway is **dormant by default** — it returns an
all-clear fake unless `WEATHER_PROVIDER=nws` is set, so nothing is flagged until a deploy opts in.
```
Add to `.env.example`: `WEATHER_PROVIDER=` (set to `nws` to enable real NWS forecasts; unset = no weather flags).

- [ ] **Step 4: Commit** — `git add "apps/web/tests/e2e/weather-exceptions.spec.ts" docs/jobs-pipeline.md .env.example && git commit -m "test(e2e): weather-at-risk exceptions + docs + env"`

- [ ] **Step 5: Full verification** — from the worktree root: `pnpm test && pnpm typecheck && pnpm lint` → all green (≥665 tests: 657 prior + new core/integration/db/agents tests). (If db `ECONNREFUSED`: `pnpm db:up && pnpm --filter @savvy/db db:migrate`, re-run.)

---

## Self-Review notes
- **Coverage:** config (T1) · forecast gateway (T2) · db flag (T3) · cron (T4) · vector (T5) · web (T6) · e2e+docs (T7).
- **Type consistency:** `DailyForecast` / `ForecastGateway` / `assessWeatherRisk` / `weatherNote`+`weatherFlaggedAt` / `setAppointmentWeatherFlag` / `weather_at_risk` / `WeatherAtRiskInput` / `weatherAtRisks` used identically.
- **Dormant by default:** fake forecast all-clear; cron no-ops on disabled config / missing lat-lng / forecast error — suite stays green.
- **Durable flag** (set by cron, cleared by cron, read by exception query) — write+read both filter `status='scheduled'`.
- **Migration** is a pure 2-column add on the already-RLS'd `appointment`; meta committed.
- **Cron registered** in the Inngest function list; `concurrency.limit` 1 (≤ plan cap 5).
