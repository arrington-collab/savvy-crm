# Weather Auto-Reschedule + Notify — Design

**Date:** 2026-07-03
**Status:** Approved (pending spec review)
**Spec section:** Jobs master prompt — net-new enhancement (weather auto-reschedule, the action half of the dormant `weather-reschedule` flagging flow)

## Problem

Today `weather-reschedule` (hourly Inngest cron, `packages/agents/src/functions/weather-reschedule.ts`) is **detection-only**. For each scheduled `crew` install in the look-ahead window it evaluates the forecast and writes `appointment.weatherNote` / `weatherFlaggedAt`. Those flags surface as `weather_at_risk` rows in the exception queue for a human to act on manually.

The spec's next step is the **action** half: when an install is at weather risk, automatically move it to the next safe, crew-free slot and notify the crew and homeowner — no human bottleneck.

## Decisions (locked with Brett)

| Decision | Choice |
|---|---|
| Autonomy | **Full auto + notify** — move the appointment and immediately notify crew + homeowner. No propose/confirm step. |
| `autoReschedule` config default | **ON**, gated behind the existing `weather.enabled`. Tenants already monitoring weather start auto-moving on deploy. |
| Slot selection | **Next safe + crew-free day** — earliest non-risk day after the original, within the forecast window, where the crew is not already booked, keeping the same time-of-day and same crew. |
| No safe slot in window | **Fall back to flag-only** (today's behavior) — a human handles it via the exception queue. |
| Thrash protection | **None in v1** — a slot chosen because it is safe will not re-flag next run. Forecast-driven re-moves are rare and arguably correct. |
| Crew notify channel | **SMS → email fallback**, sent to the crew's member users (`role='crew'` via `crew_member`). |

## Architecture

No new cron, no new trigger, no DB migration for the appointment table. The change extends the existing per-tenant evaluation and adds pure helpers + a config field.

### 1. Config (`packages/core/src/weather-config.ts`)

Add `autoReschedule: z.boolean().default(true)` to `weatherSchema`. Parsed via the existing `parseWeatherConfig`. Lives under `tenant.settings.weather`.

### 2. Pure slot picker (`@savvy/core`, unit-tested)

```ts
export function pickRescheduleSlot(input: {
  days: ForecastDay[];          // forecast days already fetched for this appt
  originalCivilDate: string;    // YYYY-MM-DD in tenant tz
  crewBusyDates: Set<string>;   // civil dates the crew already has a crew appt (excl. this one)
  cfg: WeatherConfig;
}): string | null                // target civil date (YYYY-MM-DD) or null
```

Iterates `days` ascending; returns the first day that is (a) strictly after `originalCivilDate`, (b) **not** at-risk per `assessWeatherRisk`, and (c) not in `crewBusyDates`. Returns `null` if none qualify.

### 3. New tz helper (`packages/core/src/tz.ts`)

`instantAtLocalHourOnDayOf` places a whole hour on an anchor's day; we need the **original wall-clock time** (hour + minute) placed on a **different** target date. Add:

```ts
export function instantAtLocalTimeOnDate(
  targetCivilDate: string,  // YYYY-MM-DD
  sourceLocalTime: Date,    // original startsAt (its wall-clock h:m in tz is preserved)
  tz: string,
): Date
```

Used to build the new `startsAt`; `endsAt` preserves the original duration (`endsAt - startsAt`).

### 4. Crew-busy dates reader (`@savvy/db`)

A reader that returns the set of civil dates (in tz) on which a given crew has a **scheduled `crew` appointment**, excluding the appointment being moved, within the forecast window. Reuses the one-install-per-crew-per-day capacity model from PR #118 (`assessCrewDemand`): a crew is "busy" on a day if it already has any crew appointment that day.

### 5. Crew-member contacts reader (`@savvy/db`)

Given a `crewId`, return the crew's member users' `{ phone, email }` (via `crew_member` → `user`). Used to notify the crew.

### 6. Extended evaluation (`weather-reschedule.ts` → `evaluateTenantWeather`)

Per at-risk appointment, when `cfg.enabled && cfg.autoReschedule` and the appointment has a `crewId`:

1. Load the crew's busy dates + the forecast days already fetched.
2. `pickRescheduleSlot(...)` → target civil date. If `null` → **flag-only fallback** (`setAppointmentWeatherFlag`), continue.
3. Build new `startsAt`/`endsAt` via `instantAtLocalTimeOnDate` (same time-of-day, same duration).
4. `rescheduleAppointment(...)`. On `SlotTakenError` (a non-crew conflict slipped past the crew-busy check), add that date to a local exclusion set and retry `pickRescheduleSlot` for the next candidate; give up to flag-only after the window is exhausted.
5. Clear the weather flag (`setAppointmentWeatherFlag({ note: null })`) — the new slot is safe.
6. **Notify homeowner** — immediate move message (see copy) via SMS (quiet-hours-safe, opt-out-aware) + email, fail-soft, logged to `communication`.
7. **Notify crew** — move message to each crew member (SMS → email fallback), fail-soft.
8. `step.sendEvent` a single `appointment/changed` (same `appointmentId`, `reason: "weather_rescheduled"`) — mirroring the proven manual-reschedule path in `scheduling-actions.ts`. `homeowner-crew-notify` both `cancelOn`s this event (killing the old sleeping journey) **and** triggers on it (arming a fresh journey for the new date), so one event does the whole swap. Do **not** also emit `appointment/booked` — that would double-fire the journey.

Because event emission (`step.sendEvent`) cannot run inside a `step.run`, `evaluateTenantWeather` performs the DB move + notifications inside its step and **returns** the moved appointment ids; the Inngest wrapper emits `appointment/changed` for each afterward.

If `autoReschedule` is off, behavior is exactly today's: `setAppointmentWeatherFlag`.

Counters returned by `evaluateTenantWeather` extend from `{ flagged, cleared }` to `{ flagged, cleared, rescheduled, rescheduledAppointmentIds }`.

### 7. Notification copy (pure builders in `@savvy/core`, unit-tested)

- `buildWeatherMoveHomeownerBody({ originalCivilDate, targetCivilDate, reason, tz })` → e.g. *"Heads up — rain is expected 7/6, so we've moved your roof install to Mon 7/8. We'll be in touch as the day approaches."*
- `buildWeatherMoveCrewBody({ address, originalCivilDate, targetCivilDate, reason })` → e.g. *"Weather move: 123 Main St install → Mon 7/8, 9:00 AM (was 7/6 — Rain 70%)."*

Both take pre-formatted dates; formatting is a pure tz concern.

## Data flow

```
cron (hourly, 05:00 tenant-local)
  └─ evaluateTenantWeather(tenantId)
       └─ per scheduled crew appt in window:
            forecast → assessWeatherRisk
              at-risk + autoReschedule + crewId?
                ├─ pickRescheduleSlot(days, origDate, crewBusyDates, cfg)
                │     ├─ date → rescheduleAppointment → clear flag
                │     │            → notify homeowner (SMS+email)
                │     │            → notify crew members (SMS→email)
                │     │            → return appt id (wrapper emits appointment/changed)
                │     └─ null → setAppointmentWeatherFlag (human fallback)
                └─ else → setAppointmentWeatherFlag (today's behavior)
```

## Error handling

- **Forecast fetch failure** — unchanged: skip the appt (best-effort).
- **`SlotTakenError`** — retry next safe candidate; exhaust → flag-only.
- **Missing `crewId`** — cannot pick a crew-free slot or notify a crew → flag-only fallback.
- **Missing homeowner/crew contact or SMS creds** — fail-soft (try/catch), still complete the move; log what we can to `communication`.
- **Quiet hours** — homeowner SMS deferred/suppressed per `isWithinQuietHours`; email still sends. (Crew notifications are operational, not TCPA-governed, but reuse the same safe-send path for consistency.)

## Testing

- **`pickRescheduleSlot`** — unit: picks earliest safe+free day; skips at-risk days; skips crew-busy days; respects "strictly after original"; returns null when window exhausted.
- **`instantAtLocalTimeOnDate`** — unit: preserves wall-clock h:m across DST-free and known tz; correct instant.
- **Copy builders** — unit: correct dates/reason interpolated.
- **`evaluateTenantWeather`** — integration (mock `ForecastGateway`, real DB): at-risk + autoReschedule ON → appt moved to expected slot, flag cleared, `rescheduled` counter, `communication` rows written, events sent; autoReschedule OFF → flag set, no move (regression guard for today's behavior); no safe slot → flag-only.
- **Crew-busy reader / crew-contacts reader** — integration against seeded data.

## Out of scope (v1)

- Thrash/rate-limit column on `appointment`.
- Assisted/propose mode (Brett chose full-auto).
- Multi-crew load-balancing when picking the day (we only skip fully-booked crew days; we do not reassign to a different crew).
- Weather for non-`crew` appointment types.
