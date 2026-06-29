# Roofr auto-order on inspection booking (design)

**Date:** 2026-06-29 · Parked follow-up. Opt-in, dormant-by-default automation: when an **inspection** is booked, auto-order a Roofr measurement for the job's property — reusing the existing order→persist→estimate pipeline.

## What already exists (origin/main @ 784d80a)
The whole pipeline is built and triggered by the `roofr/order.requested` event (today only from a manual button in `EstimateActions.tsx` → `orderMeasurementAction`):
`roofr/order.requested` → `roofrOrderMeasurement` (order via `nangoRoofr`, poll, persist `measurement` row, emit `measurement/ready`) → `generateEstimateOnMeasurement` → draft estimate.
- `appointment/booked` event carries `{ appointmentId, tenantId }` (load the rest). Already handled by calendar-sync + reminders.
- Tenant config = `tenant.settings.scheduling` (jsonb), parsed by `parseSchedulingConfig`; settings UI at `/settings/scheduling`.

## Design (event reuse, not new plumbing)
1. **Config flag** — add `autoOrderMeasurement: boolean` (default **false**) to `SchedulingConfig` (`packages/core/src/scheduling.ts`).
2. **New Inngest fn** `autoOrderMeasurementOnInspection` (`packages/agents/src/functions/auto-order-measurement.ts`), listens `{ event: "appointment/booked" }`, concurrency 5:
   - Load appointment (`type`, `status`, `jobId`) + job (`propertyId`) + whether the property already has a measurement, inside `withTenant`.
   - **Cheap gate:** if not a `scheduled` `inspection`, or the property already has a measurement → return (no settings read, no log).
   - Read the tenant toggle via `adminDb` (settings live on the tenant row). If off → return.
   - Else `step.sendEvent("roofr/order.requested", { tenantId, jobId, propertyId })` + `recordAgentRun(status:"ok", taskKey:"measurement.auto_order")`.
   - Pure decision extracted as `shouldAutoOrderMeasurement({ enabled, apptType, apptStatus, hasMeasurement })` for unit testing.
   - Registered in `packages/agents/src/index.ts` (import + re-export + functions array).
3. **Settings UI** — an "Automation" card checkbox on `SchedulingSettingsForm`; threaded through state + the saved config payload (`saveSchedulingConfig` already merges scheduling config).

## Why dormant-safe
The toggle defaults `false`, so zero prod behavior change until a tenant opts in. No new event type, no measurement-pipeline change, no env gating needed (the Roofr API call stays Nango-gated as today; `nangoRoofr` is used in prod, fakes via DI in tests).

## Dedup
Skips if the property already has a measurement (avoids paying for duplicate Roofr orders). Best-effort (a tiny race window exists if two inspections are booked simultaneously — acceptable for an opt-in convenience; mirrors the manual button's non-guard).

## Tests
- core `scheduling.test.ts`: `autoOrderMeasurement` defaults off + round-trips.
- agents `auto-order-measurement.test.ts`: `shouldAutoOrderMeasurement` truth table (enabled+inspection+scheduled+no-measurement → true; off / non-inspection / non-scheduled / has-measurement → false).
- Web verified via typecheck + lint (apps/web not in vitest workspace).

## Out of scope
- Auto-order on other appointment types; per-tenant Roofr API env gating; retry/notify on a pending Roofr report (the existing pipeline already polls + returns pending).
