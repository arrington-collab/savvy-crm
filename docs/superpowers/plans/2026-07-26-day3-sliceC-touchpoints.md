# Day 3 Slice C — New Touchpoints (Missed-Call · No-Show · Bilingual) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three customer touchpoints — (1) missed-call text-back, (2) no-show reschedule outreach, (3) bilingual EN/ES templates + per-location branding plumbing — on top of the Slice A/B compliance gateway + bridge.

**Architecture:** Two new durable Inngest handlers (`missedCallTextback` on a new `call/missed` event; `noShowReschedule` on `appointment/changed` reason `no_show`), fronted where needed by a thin Twilio no-answer webhook. All outbound SMS goes through the existing `guardedSms` chokepoint. A small language-aware template helper + a `resolveSendContext(tenant, locationId?)` resolver key messages off `customer.preferredLanguage` and thread `locationId` end-to-end (tenant-resolved until locations are modeled). Both handlers bridge-publish their DomainEvents via the Slice-B `publishDomainEvent` pattern.

**Tech Stack:** TypeScript, pnpm + Turborepo, Drizzle + Postgres (RLS via `withTenant`), Inngest (durable), Vitest.

## Global Constraints

- **NO migration.** Bilingual rides on the existing `customer.preferredLanguage` column (`packages/db/src/schema/crm.ts:12`). `locationId` is an existing nullable pass-through field. `missed_call` is added to the core `LEAD_SOURCE_VALUES` array (the `lead.source` DB column is free `text`, validated in core — not a PG enum), so no DB change.
- **All outbound SMS routes through `guardedSms`** (`packages/agents/src/comms-gateway.ts:39`) — never `sms.sendSms` directly. Fail-closed on suppression/consent/a2p.
- **Durable-async = Inngest** (CLAUDE.md #3). The text-back and reschedule sends happen in Inngest handlers with idempotency keys, never in a webhook/synchronously.
- **Bridge pattern (Slice B):** a pure `bridgeX(store, args)` helper calling `publishDomainEvent(store, makeEvent({...}))`, invoked from a fail-soft sibling `step.run("bridge-...")` in the Inngest handler (try/catch, log, never rethrow), constructing `new DrizzleOrchestratorStore()`. Escalation-records (if any) gated on `published.published === true`.
- **Idempotency keys** `${eventType}:${entityId...}`; retries never double-text.
- **Tenant isolation** via `withTenant` on every DB read/write.
- **Quiet-hours policy:** the missed-call text-back is a DIRECT RESPONSE to a customer-initiated call → send immediately (do NOT pass `quiet` to guardedSms; the caller is awake, they just called). The no-show reschedule is outreach → pass `quiet` so it defers to the tenant's window. Both still enforce suppression + consent + a2p.
- Co-author trailer: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. Each task ends green (`pnpm typecheck` + task tests) before commit.

---

## File Structure

**New files:**
- `packages/core/src/localized-templates.ts` — `pickLocalizedBody`, the EN/ES literal bodies for missed-call + no-show, `renderLocalized`.
- `packages/core/src/localized-templates.test.ts`
- `packages/agents/src/send-context.ts` — `resolveSendContext(tenant, locationId?)` (companyName, tz, quietHours; locationId threaded, tenant-resolved).
- `packages/agents/src/send-context.test.ts`
- `packages/agents/src/functions/missed-call-textback.ts` — `missedCallTextback` Inngest fn + pure `buildMissedCallSms` + `bridgeCallMissed` helper.
- `packages/agents/src/functions/missed-call-textback.test.ts`
- `packages/agents/src/functions/no-show-reschedule.ts` — `noShowReschedule` Inngest fn + pure `buildNoShowSms`.
- `packages/agents/src/functions/no-show-reschedule.test.ts`
- `apps/web/src/app/api/twilio/voice-status/route.ts` — the no-answer webhook (missed-call producer).
- `apps/web/src/app/api/twilio/voice-status/route.test.ts`

**Modified files:**
- `packages/core/src/lead-sources.ts` — add `"missed_call"` to `LEAD_SOURCE_VALUES` + `MACHINE_LEAD_SOURCES`.
- `packages/agents/src/client.ts` — add the `call/missed` Inngest event to the `Events` map.
- `packages/agents/src/index.ts` — import + re-export + append `missedCallTextback` and `noShowReschedule` to the `functions` array.

---

## Task C1: Bilingual template helper + per-location send-context resolver

**Files:**
- Create: `packages/core/src/localized-templates.ts` + `.test.ts`
- Create: `packages/agents/src/send-context.ts` + `.test.ts`
- Modify: `packages/core/src/index.ts` (export localized-templates)

**Interfaces:**
- Consumes: `renderTemplate(body, vars)` (`packages/core/src/render-template.ts:6`); `parseFinanceConfig(...).timezone` (`packages/core/src/finance.ts:55`, default `"America/Phoenix"`); `parseLeadCadenceConfig(...).quietHours` (`packages/core/src/lead-followup.ts:33`, default `{startHour:21,endHour:8}`); `QuietHours` (`packages/core/src/quiet-hours.ts:1`).
- Produces:
  - `type Language = "en" | "es"`
  - `function normalizeLanguage(v: string | null | undefined): Language` — `"es"` iff `v?.toLowerCase().startsWith("es")`, else `"en"`.
  - `function pickLocalizedBody(variants: { en: string; es: string }, language: string | null | undefined): string` — returns the variant for `normalizeLanguage(language)`.
  - `function renderLocalized(variants: { en: string; es: string }, language: string | null | undefined, vars: Record<string,string>): string` — `renderTemplate(pickLocalizedBody(variants, language), vars)`.
  - `interface SendContext { companyName: string; tz: string; quietHours: QuietHours }`
  - `function resolveSendContext(tenant: { name: string; settings: unknown }, locationId?: string | null): SendContext` — TODAY resolves entirely from tenant (`companyName = tenant.name`, `tz` from finance config, `quietHours` from lead-cadence config); `locationId` is accepted and reserved for when a location entity exists (document this; do not branch on it yet). (In `packages/agents/src/send-context.ts` so it can import the core parsers.)

- [ ] **Step 1: RED** — `localized-templates.test.ts`:

```ts
import { it, expect } from "vitest";
import { normalizeLanguage, pickLocalizedBody, renderLocalized } from "./localized-templates";

it("normalizes language to en/es", () => {
  expect(normalizeLanguage("es")).toBe("es");
  expect(normalizeLanguage("es-MX")).toBe("es");
  expect(normalizeLanguage("en")).toBe("en");
  expect(normalizeLanguage(null)).toBe("en");
  expect(normalizeLanguage("fr")).toBe("en");
});

it("picks and renders the localized variant", () => {
  const v = { en: "Hi {{name}}", es: "Hola {{name}}" };
  expect(pickLocalizedBody(v, "es")).toBe("Hola {{name}}");
  expect(renderLocalized(v, "es", { name: "Ana" })).toBe("Hola Ana");
  expect(renderLocalized(v, null, { name: "Sam" })).toBe("Hi Sam");
});
```

- [ ] **Step 2:** `pnpm --filter @savvy/core test -- localized-templates` → FAIL.
- [ ] **Step 3:** Implement `localized-templates.ts` (pure; reuse `renderTemplate`). Export from `packages/core/src/index.ts`.
- [ ] **Step 4: RED** — `send-context.test.ts`: assert `resolveSendContext({name:"Acme", settings:{}})` returns `companyName:"Acme"`, `tz:"America/Phoenix"` (the finance default), and the default quietHours `{startHour:21,endHour:8}`; and that a `settings.finance.timezone` override is respected. Include a case passing a `locationId` and assert it does not change the result today (documents the pass-through).
- [ ] **Step 5:** Run → FAIL.
- [ ] **Step 6:** Implement `send-context.ts` using `parseFinanceConfig`/`parseLeadCadenceConfig`. Run both suites + `pnpm --filter @savvy/core typecheck && pnpm --filter @savvy/agents typecheck` → PASS.
- [ ] **Step 7: Commit** `feat(core+agents): bilingual template helper + per-location send-context resolver`.

---

## Task C2: Twilio missed-call webhook (call.missed producer)

**Files:**
- Create: `apps/web/src/app/api/twilio/voice-status/route.ts` + `.test.ts`
- Modify: `packages/core/src/lead-sources.ts` (add `"missed_call"`)
- Modify: `packages/agents/src/client.ts` (add `call/missed` Inngest event)

**Interfaces:**
- Consumes: `tenantByPhone(phone)` (`apps/web/src/lib/intake.ts:10`); the **DB-level** `createLeadForTenant(tenantId, input)` from **`@savvy/db`** (`packages/db/src/lifecycle/lead-intake.ts:19`) — dedupes the customer by phone and returns `leadId`; `publishDomainEvent` + `makeEvent` (`@savvy/orchestrator`); `DrizzleOrchestratorStore` (`@savvy/db`); the inbound SMS route (`apps/web/src/app/api/twilio/inbound/route.ts`) as the webhook + fail-soft-bridge pattern; the `xml()` TwiML helper.
  - **CRITICAL — avoid the double-text.** Do NOT use the web wrapper `createLeadForTenant` from `apps/web/src/lib/intake.ts` here: that wrapper emits `lead/created`, which fires the full lead-intake flow INCLUDING its own ack SMS — so the caller would receive both the intake ack AND the missed-call text-back. Use the **`@savvy/db`** `createLeadForTenant` directly (it does NOT emit `lead/created`). The single response to a missed call is the C3 text-back. (Assignment/nurture for missed-call leads is a deliberate follow-up, not this slice.)
- Produces:
  - A `POST` route at `/api/twilio/voice-status` that handles Twilio call-status callbacks. It acts ONLY when the call was missed — `CallStatus` / `DialCallStatus` is one of `no-answer | busy | failed` (read both fields; Twilio sends `DialCallStatus` for `<Dial>` and `CallStatus` for the call resource). Otherwise return empty TwiML.
  - On a missed call: resolve tenant via `tenantByPhone(To)`; create the lead via the `@savvy/db` `createLeadForTenant(tenantId, { name: \`Missed call ${From}\`, phone: From, address: "unknown", source: "missed_call" })` (customer deduped by phone — the voicemail stub at `apps/web/src/app/api/twilio/voice/route.ts` uses this same `name`/`address` convention); then (a) `inngest.send({ name: "call/missed", data: { tenantId, leadId, fromNumber: From, toNumber: To } })` and (b) fail-soft bridge-publish `call.missed` (idempotencyKey `call.missed:${From}:${To}:${CallSid}` — CallSid makes it unique per call). Return `xml("<Response/>")`.
- The new Inngest event (`client.ts`): `"call/missed": { data: { tenantId: string; leadId: string; fromNumber: string; toNumber: string } }`.

- [ ] **Step 1:** Add `"missed_call"` to `LEAD_SOURCE_VALUES` and `MACHINE_LEAD_SOURCES` in `packages/core/src/lead-sources.ts`. Add a test in the nearest lead-sources test (or a new one) asserting `"missed_call"` is a valid source and is machine-sourced. Run `pnpm --filter @savvy/core test` → PASS.
- [ ] **Step 2:** Add the `call/missed` event to `client.ts`'s `Events` map.
- [ ] **Step 3: RED** — `voice-status/route.test.ts` (mirror `inbound/route.test.ts`'s mocking of `@savvy/orchestrator`/`DrizzleOrchestratorStore` + a mock for `intake.ts`/`inngest`): assert that a POST with `DialCallStatus=no-answer`, a known `To`, and a `From` (1) creates/reuses a lead with `source:"missed_call"`, (2) sends the `call/missed` Inngest event with the right data, (3) bridge-publishes `call.missed` with key `call.missed:${From}:${To}:${CallSid}`; and that a POST with `DialCallStatus=completed` does NONE of these (returns empty TwiML). Also assert unknown tenant (`tenantByPhone` null) → empty TwiML, no side effects.
- [ ] **Step 4:** Run the web test → FAIL.
- [ ] **Step 5:** Implement the route (fail-soft on both the inngest send and the bridge publish, per the inbound route pattern). `runtime = "nodejs"`. Run `pnpm --filter @savvy/web test -- voice-status && pnpm --filter @savvy/web typecheck && pnpm --filter @savvy/agents typecheck` → PASS.
- [ ] **Step 6: Commit** `feat(web): missed-call webhook emits call/missed + bridges call.missed`.

---

## Task C3: `missedCallTextback` Inngest handler

**Files:**
- Create: `packages/agents/src/functions/missed-call-textback.ts` + `.test.ts`
- Modify: `packages/agents/src/index.ts` (import + re-export + `functions` array)

**Interfaces:**
- Consumes: the `call/missed` event (C2); `getTenantSms` (`telephony.ts:38`), `resolveA2pApproved` (`telephony.ts:139`), `guardedSms` (`comms-gateway.ts:39`), `isSuppressed` (`@savvy/db`); `createBookingLink` + `signPayloadToken`/`requireSecret` + `buildShortLink` (see `lead-cadence.ts:26-31` / `lead-intake.ts:416`); the lead→customer resolution (customer `phone`, `preferredLanguage`, `smsOptOut`, `smsConsentAt`); `renderLocalized`/`normalizeLanguage` + `resolveSendContext` (C1); the `bridgeBreach` pattern (`lead-speed-to-lead.ts:53`) for structure.
- Produces:
  - `buildMissedCallSms({ companyName, bookingUrl, language }): string` — pure, EN/ES via `renderLocalized` (e.g. EN "Sorry we missed your call at {{companyName}}! Book a time here: {{bookingUrl}}"; ES "¡Perdón por no contestar en {{companyName}}! Reserve aquí: {{bookingUrl}}").
  - `missedCallTextback = inngest.createFunction({ id: "missed-call-textback", concurrency }, { event: "call/missed" }, handler)` — resolves the lead's customer, builds a booking link, sends via `guardedSms` with **quiet-hours NOT enforced** (immediate response; still suppression/consent/a2p-guarded), logs a `communication` row on send, and is idempotent (one text-back per `call/missed` — dedupe via a `step.run` step id keyed on leadId, and/or a guard that skips if a recent missed-call comm exists; simplest: the Inngest event id + step memoization handles retries).
- The handler resolves language from `customer.preferredLanguage`.

- [ ] **Step 1: RED** — `missed-call-textback.test.ts`: unit-test `buildMissedCallSms` (EN and ES variants render with companyName + bookingUrl). Then a handler-logic test using injected deps + a fake `SmsSender` + `InMemoryStore` proving: a missed call with a consented customer → `guardedSms` called with the localized body (ES when `preferredLanguage:"es"`), returns sent; a suppressed/opted-out customer → blocked (no send). Follow the injected-deps pattern from `lead-speed-to-lead.test.ts` / `appointment-reminders.test.ts` (extract the send logic into a pure/injectable function if the Inngest handler can't be unit-run — mirror how those files test).
- [ ] **Step 2:** Run `pnpm --filter @savvy/agents test -- missed-call-textback` → FAIL.
- [ ] **Step 3:** Implement the handler + helpers. Register in `index.ts` (import, re-export, add to `functions` array). Send via `guardedSms` (quiet omitted). Fail-soft on the comm-log. Run `pnpm --filter @savvy/agents test -- missed-call-textback && pnpm --filter @savvy/agents typecheck && pnpm --filter @savvy/agents lint` → PASS.
- [ ] **Step 4: Commit** `feat(agents): missed-call text-back handler (bilingual, guarded)`.

---

## Task C4: `noShowReschedule` Inngest handler

**Files:**
- Create: `packages/agents/src/functions/no-show-reschedule.ts` + `.test.ts`
- Modify: `packages/agents/src/index.ts` (import + re-export + `functions` array)

**Interfaces:**
- Consumes: the existing `appointment/changed` event (`client.ts:15`, `reason:"no_show"`); appointment→customer phone resolution (copy `appointment-reminders.ts:53-74`); `guardedSms` + booking-link build + `renderLocalized`/`resolveSendContext` (C1); the `drip/enroll` event (`client.ts:9`, `{ tenantId, dripKey, customerId, leadId }`) to hand back to cadence.
- Produces:
  - `buildNoShowSms({ companyName, bookingUrl, language }): string` — pure EN/ES (e.g. EN "We missed you for your appointment with {{companyName}}. Reschedule here: {{bookingUrl}}"; ES equivalent).
  - `noShowReschedule = inngest.createFunction({ id: "no-show-reschedule", concurrency }, { event: "appointment/changed" }, handler)` — the handler **guards `event.data.reason === "no_show"`** and returns early otherwise (so it coexists with the other `appointment/changed` consumers). Resolves the appointment's customer, builds a booking link, sends the localized reschedule SMS via `guardedSms` (quiet-hours ENFORCED — pass `quiet` from `resolveSendContext`), logs the comm, then `inngest.send({ name: "drip/enroll", data: { tenantId, dripKey: <the reschedule/nurture drip key>, customerId, leadId } })` to hand back to cadence. Idempotent per appointmentId.
- **Cadence drip key:** use the existing nurture drip key if one is provisioned (check `provision-runbook.ts`/`seed.ts` for a default `dripKey` like `"nurture"`); if none is guaranteed, gate the re-enroll on the drip existing (fail-soft) so the SMS still sends. Document the chosen key.

- [ ] **Step 1: RED** — `no-show-reschedule.test.ts`: unit-test `buildNoShowSms` (EN/ES). Handler-logic test (injected deps): `reason:"no_show"` + consented customer → localized reschedule SMS sent + a `drip/enroll` emitted; `reason:"done"` (or any non-no_show) → NOTHING happens (early return); opted-out customer → blocked, no send, and (decide + test) no re-enroll.
- [ ] **Step 2:** Run `pnpm --filter @savvy/agents test -- no-show-reschedule` → FAIL.
- [ ] **Step 3:** Implement + register in `index.ts`. Run `pnpm --filter @savvy/agents test -- no-show-reschedule && pnpm --filter @savvy/agents typecheck && pnpm --filter @savvy/agents lint` → PASS.
- [ ] **Step 4: Commit** `feat(agents): no-show reschedule outreach + hand back to cadence`.

---

## Task C5: Slice C gate + PR

**Files:** none (verification + PR).

- [ ] **Step 1: Clean the local shared-DB fixture corruption FIRST** (known env issue): dependency-order DELETE of orphaned `task_registry` rows `id >= 9000` and dependents in the local `savvy_db` docker (see Slice B's recipe: `lead_task`, `task_health`, `job_task`, then `task_registry`). This prevents false-red on `get-job-ledger`/`ops-rollup`.
- [ ] **Step 2: Full gate mirroring CI:** `pnpm typecheck` (9 pkgs) + `pnpm lint` must be fully green; then `pnpm test` (the CI command = `vitest run` over `packages/*`) must pass; then `pnpm --filter @savvy/web test` (the web unit tests incl. the new `voice-status` route) must pass. Do NOT run Playwright e2e. If any non-Slice-C suite fails, prove it's pre-existing (fails on base `59eb968` with changes stashed) before proceeding.
- [ ] **Step 3: Push + PR:**

```bash
git push -u origin day3-sliceC
gh pr create --base main --head day3-sliceC --title "Day 3 Slice C — missed-call text-back, no-show reschedule, bilingual" --body "<summary of the 2 handlers + webhook + bilingual/send-context; note NO migration; note guarded sends + quiet-hours policy (missed-call immediate, no-show deferred); note call.missed/appointment.no_show already bridge to the Command Center from Slice B>"
```

- [ ] **Step 4:** Report the PR URL + CI status; STOP for Brett's per-PR merge word. Do not merge.

---

## Self-Review (completed during authoring)

- **Spec coverage:** missed-call text-back (webhook C2 + handler C3) ✓; no-show reschedule + hand-back-to-cadence (C4) ✓; bilingual EN/ES (C1 + used in C3/C4) ✓; per-`locationId` branding plumbing (C1 `resolveSendContext` threads locationId, tenant-resolved) ✓.
- **No migration** — confirmed: language uses existing `customer.preferredLanguage`; `missed_call` is a core-array value (free-text column); `locationId` already exists as a nullable field.
- **Placeholder scan:** every code step carries real signatures/paths from the recon.
- **Type consistency:** `guardedSms` args (`consent`, `a2pApproved`, `quiet`), `resolveSendContext` shape, `Language` type, and the `call/missed`/`drip/enroll` event data shapes are pinned to recon `path:line`.
- **Quiet-hours policy** is explicit per touchpoint (missed-call immediate, no-show deferred) — a reviewer decision point flagged, not left implicit.
- **Deferred to Slice D:** the 11-check §8 acceptance test (incl. the missed-call and bilingual acceptance checks) is Slice D, not here.
- **Idempotency:** call.missed key includes CallSid; text-back/reschedule dedupe per lead/appointment via Inngest step memoization + event id.
