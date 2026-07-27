# Day 3 Slice D — §8 Acceptance Test Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove the entire Day-3 feature set (Slices A+B+C, all merged) works end-to-end via the 11 §8 acceptance checks, composed into two acceptance-test files — with zero new production code.

**Architecture:** Two acceptance files split by package/DB dependency: a **pure/injectable** file in `packages/agents` (fake `SmsSender` + `InMemoryStore`, no DB) and a **real-Postgres** file in `packages/db` (mirrors Slice B's `bridge-e2e.test.ts` seed/teardown). Each check drives an existing seam and asserts the §8 behavior. One check (durable-restart) is asserted structurally + documented as Inngest-runtime-only; the "regression pass" check is the full suite staying green.

**Tech Stack:** TypeScript, Vitest, Drizzle + Postgres (real local `savvy_db`), `@savvy/orchestrator` (`publishDomainEvent`/`InMemoryStore`/`makeEvent`), `@savvy/agents` send units, `@savvy/command-center` (`projectDay`).

## Global Constraints

- **NO new production code and NO migration.** Every seam already exists; Slice D only writes acceptance tests. If a check cannot be made to pass because of a genuine Day-3 gap (not a test bug), STOP and surface it — do NOT paper over it or weaken the assertion.
- **These are acceptance/characterization tests, not RED-first TDD.** The features already exist and pass, so each check is written to PASS (green) against current code. A check that fails is either a test bug or a real acceptance failure to investigate and report.
- **Assert real behavior, never tautologies.** Each check must exercise the real seam (drive the actual function/store) and assert a concrete outcome — a blocked reason, an ES string, a metric number, a row count. A test that only checks a mock echoing itself is a defect (the reviewer will flag it).
- **Reuse existing helpers verbatim:** the `deps()` factory (`comms-gateway.test.ts:7-14`), `makeEvent`/`publishDomainEvent` (`@savvy/orchestrator`), `InMemoryStore` / `DrizzleOrchestratorStore`, and the `beforeAll`/`afterAll` tenant seed (`bridge-e2e.test.ts:26-37`).
- **Real-DB tests** assume the live local `savvy_db` Postgres (already how `packages/db` tests run, serial via `fileParallelism:false`). Clean the known stale `task_registry` fixtures before the gate.
- Co-author trailer: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. Each task ends green before commit.

---

## File Structure

**New files (both test-only):**
- `packages/agents/src/functions/acceptance-day3.test.ts` — pure/injectable checks: 1, 3, 5, 8, 9, 10-pure, 7-structural.
- `packages/db/src/command-center/acceptance-day3.test.ts` — real-Postgres checks: 2, 4, 6, 10-real, 7-breach.

**The 11 checks → seam map (verified via recon; use these exact functions/signatures):**
| # | Check | Seam | File |
|---|---|---|---|
| 1 | Gateway can't be bypassed (suppressed ⇒ blocked) | `guardedSms`, `sendMissedCallTextback`, `sendNoShowReschedule`, `sendDripStep` with `isSuppressed:()=>true` + `vi.fn` sender → `{status:"blocked",reason:"suppressed"}` + sender never called | agents |
| 2 | Global STOP suppresses across a DIFFERENT agent | `suppress({tenantId, phoneE164, channel:"sms", reason:"stop", source})` then a different agent's real DB `isSuppressed({tenantId, phoneE164, channel:"sms"})===true`; drive a real send unit against it | db |
| 3 | Quiet-hours deferral sets `slaLatencySeconds`+`quietHoursDeferred` | `bridgeFirstTouch(new InMemoryStore(), {..., latencySeconds, result:{status:"deferred",untilIso}})` → assert published `lead.first_touch` payload has `quietHoursDeferred:true` + `slaLatencySeconds` | agents |
| 4 | A2P-unapproved fails closed + `compliance-block` in `exception_queue` | `resolveA2pApproved` returns false w/ real creds; `bridgeFirstTouch(DrizzleOrchestratorStore, {result:{status:"blocked",reason:"a2p_unapproved"}})` → `recordException(tenantId, esc)` → `listQueue(tenantId)` has an open `compliance-block` | db |
| 5 | Missed-call text-back sent | `sendMissedCallTextback(deps, args)` consented → `{status:"sent"}` + booking URL in `spy.mock.calls[0][0].body` | agents |
| 6 | First-touch e2e → Speed panel populates | `publishDomainEvent(store, makeEvent({type:"lead.first_touch", payload:{leadId,channel:"sms",latencySeconds:30}}))` → `loadEventsForDay` → `projectDay` → `medianSpeedToLeadMs===30000`, `pctLeadsUnder5Min===1` → `upsertDailyMetrics`/`getDailyMetrics` | db |
| 7 | Durable breach timer survives restart | STRUCTURAL: assert `leadSpeedToLead` config declares `cancelOn` + the source uses `step.sleep`/`step.run`; BEHAVIORAL: `bridgeBreach` publishes `lead.sla_breach` → `speed-to-lead-breach` escalation. DOCUMENT that true restart-durability is Inngest-runtime-only, not unit-provable. | agents (structural) + db (breach→queue) |
| 8 | No-show reschedule sent | `sendNoShowReschedule(deps, args)` consented no_show → `{status:"sent"}` + reschedule/booking URL in body | agents |
| 9 | ES templates + per-location resolution | `buildMissedCallSms({language:"es",...})` / `buildNoShowSms({language:"es",...})` → Spanish text; `resolveSendContext({name,settings}, locationId)` → `companyName`/`tz`/`quietHours` | agents |
| 10 | Idempotent (one first touch, one bridge row) | pure: `bridgeFirstTouch` twice same leadId → `store.audits.length` unchanged; real: `publishDomainEvent` twice same key → one `orchestratorEvent` row | agents + db |
| 11 | Regression pass | the full existing suite stays green (`pnpm test`) — no new file; verified in the gate (D3) | — |

---

## Task D1: Agents acceptance file (pure/injectable checks)

**Files:**
- Create: `packages/agents/src/functions/acceptance-day3.test.ts`

**Interfaces (drive these — verify signatures before asserting):**
- `guardedSms(deps, args)` (`comms-gateway.ts:39`), result union `{status:"sent",sid}|{status:"deferred",untilIso}|{status:"blocked",reason}`.
- `sendMissedCallTextback(deps, args)` (`missed-call-textback.ts:55`), `buildMissedCallSms({companyName,bookingUrl,language})` (`:15`).
- `sendNoShowReschedule(deps, args)` (`no-show-reschedule.ts:90`), `buildNoShowSms(...)` (`:26`), `shouldReenrollAfterNoShow` (`:151`), `quietSleepUntil` (`:47`).
- `sendDripStep(input, deps)` (`drip.ts:72`) — deps `isSuppressed` defaults DB-backed; inject `isSuppressed:()=>true`.
- `bridgeFirstTouch(store, args)` (`lead-intake.ts:181`).
- `resolveSendContext(tenant, locationId?)` (`send-context.ts:22`), `renderLocalized`/`normalizeLanguage` (`@savvy/core`).
- `leadSpeedToLead` (`lead-speed-to-lead.ts`) — read its `createFunction` config for `cancelOn`; `bridgeBreach(store, args)` (`:53`).
- `InMemoryStore` from `@savvy/orchestrator` (`.audits`, `.listEscalations`); the `deps()` factory pattern from `comms-gateway.test.ts:7-14`.

- [ ] **Step 1: Write the acceptance file** with one `describe("Day 3 §8 acceptance — units", ...)` containing an `it` per check (1, 3, 5, 8, 9, 10-pure, 7-structural). Use a local `deps(suppressed=false)` factory. Representative assertions:

```ts
import { describe, it, expect, vi } from "vitest";
import { InMemoryStore } from "@savvy/orchestrator";
import { guardedSms } from "../comms-gateway";
import { sendMissedCallTextback, buildMissedCallSms } from "./missed-call-textback";
import { sendNoShowReschedule, buildNoShowSms } from "./no-show-reschedule";
import { bridgeFirstTouch } from "./lead-intake";
import { resolveSendContext } from "../send-context";
import { leadSpeedToLead } from "./lead-speed-to-lead";

const T = "11111111-1111-1111-1111-111111111111";
const consent = { smsOptOut: false, emailOptOut: false, smsConsentAt: new Date() };
function deps(suppressed = false) {
  return { isSuppressed: vi.fn(async () => suppressed), sms: { sendSms: vi.fn(async () => ({ sid: "SM1" })) }, smsFrom: () => "+15555550100" };
}

// CHECK 1 — gateway can't be bypassed
it("§8.1 suppressed contact ⇒ every send unit returns blocked and never calls the sender", async () => {
  const d = deps(true);
  const g = await guardedSms(d, { tenantId: T, channel: "sms", to: "+15551230000", body: "x", consent, a2pApproved: true });
  expect(g).toEqual({ status: "blocked", reason: "suppressed" });
  const mc = await sendMissedCallTextback(deps(true), { /* consented args */ });
  expect(mc.result?.status ?? mc.status).toBe("blocked"); // match the real return shape
  expect(d.sms.sendSms).not.toHaveBeenCalled();
  // ...repeat for sendNoShowReschedule + sendDripStep, each asserting blocked + sender-never-called
});

// CHECK 3 — quiet-hours deferral fields
it("§8.3 a deferred first-touch publishes quietHoursDeferred + slaLatencySeconds", async () => {
  const store = new InMemoryStore();
  await bridgeFirstTouch(store, { tenantId: T, leadId: "l1", latencySeconds: 3, occurredAtLeadCreated: "2026-07-27T10:00:00.000Z", result: { status: "deferred", untilIso: "2026-07-27T15:00:00.000Z" } });
  const audit = store.audits.find((a) => a.event.idempotencyKey === "lead.first_touch:l1");
  expect(audit!.event.payload).toMatchObject({ quietHoursDeferred: true, slaLatencySeconds: 3 });
});

// CHECK 9 — ES templates
it("§8.9 renders Spanish bodies and resolves tenant send-context", () => {
  expect(buildMissedCallSms({ companyName: "Acme", bookingUrl: "u", language: "es" })).toMatch(/Reserve|Perdón/i);
  const ctx = resolveSendContext({ name: "Acme", settings: {} }, null);
  expect(ctx.companyName).toBe("Acme");
  expect(ctx.tz).toBe("America/Phoenix");
});

// CHECK 7 — structural (documented limitation)
it("§8.7 breach timer is durable-by-construction (cancelOn + durable steps); true restart is Inngest-runtime only", () => {
  // Structural: the function cancels on contact/disqualify and is registered.
  // NOTE: 'survives a process restart' is an Inngest-runtime durability property — it requires a
  // live dev server + replay to prove, so it is NOT unit-testable here. This asserts the durable
  // construction; the breach→escalation behavior is covered in the db acceptance file (bridgeBreach).
  expect(leadSpeedToLead).toBeDefined();
  // If the config object exposes cancelOn/id, assert it; otherwise assert the function id and document.
});
```

Fill in checks 5, 8, 10-pure with real assertions per the seam map (missed-call/no-show sent + booking URL in `sms.sendSms` call args; `bridgeFirstTouch` twice → `store.audits.length` unchanged). For check 1, cover all four senders. Verify the REAL return shape of each send unit (e.g. `sendMissedCallTextback` returns `{ body, result }` or `{ skipped }` — check `missed-call-textback.ts:55-91`) and assert against the real shape, not an assumed one.

- [ ] **Step 2: Run** `pnpm --filter @savvy/agents test -- acceptance-day3` → all checks PASS. If any check fails, determine whether it's a test bug (fix) or a real gap (STOP + report). Then `pnpm --filter @savvy/agents typecheck && pnpm --filter @savvy/agents lint`.

- [ ] **Step 3: Commit** `test(agents): Day 3 §8 acceptance — pure/injectable checks (gateway, quiet-hours, touchpoints, bilingual, idempotency)`.

---

## Task D2: DB acceptance file (real-Postgres checks)

**Files:**
- Create: `packages/db/src/command-center/acceptance-day3.test.ts`

**Interfaces (drive these):**
- Seed/teardown: mirror `packages/db/src/command-center/bridge-e2e.test.ts:26-37` exactly (`beforeAll` inserts a tenant with `randomUUID()` id + `publicKey`; `afterAll` deletes child rows — `exceptionQueue`, `dailyMetrics`, `orchestratorEscalation`, `orchestratorEvent`, `contactSuppression`, then the tenant — in FK-safe order).
- `suppress(args)` + `isSuppressed(args)` (`packages/db/src/lifecycle/contact-suppression.ts:48,22`).
- `publishDomainEvent` + `makeEvent` (`@savvy/orchestrator`), `DrizzleOrchestratorStore` (`@savvy/db`).
- `bridgeFirstTouch` (`@savvy/agents` — for the blocked→compliance-block path) and `bridgeBreach` (`@savvy/agents`).
- `recordException(tenantId, esc)` + `listQueue(tenantId)` (`packages/db/src/command-center/store.ts:46,51`).
- `loadEventsForDay` + `projectDay` (`@savvy/command-center` / `db command-center/read`), `upsertDailyMetrics`/`getDailyMetrics`, `businessDateOf`.
- `orchestratorEvent` table + `adminDb` for row-count assertions.

- [ ] **Step 1: Write the acceptance file** — `describe("Day 3 §8 acceptance — real DB", ...)` with the seed/teardown and one `it` per check (2, 4, 6, 10-real, 7-breach). Representative assertions:

```ts
// CHECK 2 — global STOP across a different agent
it("§8.2 a STOP recorded by one path suppresses a send attempted by another agent (same tenant)", async () => {
  const phone = "+1556" + String(Math.floor(Math.random() * 1e7)).padStart(7, "0");
  await suppress({ tenantId, phoneE164: phone, channel: "sms", reason: "stop", source: "twilio-inbound" });
  // A DIFFERENT agent's guard sees it:
  expect(await isSuppressed({ tenantId, phoneE164: phone, channel: "sms" })).toBe(true);
  // And a real send unit driven with the DB-backed isSuppressed blocks:
  const g = await guardedSms({ isSuppressed, sms: { sendSms: vi.fn() }, smsFrom: () => "+1..." },
    { tenantId, channel: "sms", to: phone, body: "x", consent, a2pApproved: true });
  expect(g).toEqual({ status: "blocked", reason: "suppressed" });
});

// CHECK 4 — A2P fails closed + compliance-block in exception_queue
it("§8.4 an a2p-blocked first-touch records a compliance-block in the exception queue", async () => {
  const store = new DrizzleOrchestratorStore();
  const { complianceBlock } = await bridgeFirstTouch(store, { tenantId, leadId: "l-a2p", latencySeconds: 5, occurredAtLeadCreated: new Date().toISOString(), result: { status: "blocked", reason: "a2p_unapproved" } });
  expect(complianceBlock).toBeTruthy();
  await recordException(tenantId, complianceBlock!);
  const q = await listQueue(tenantId);
  expect(q.some((r) => r.ruleId === "compliance-block" && r.state === "open")).toBe(true);
});

// CHECK 6 — first-touch e2e → Speed panel
it("§8.6 lead.first_touch → orchestrator_event → projectDay populates the Speed panel", async () => {
  const store = new DrizzleOrchestratorStore();
  const r = await publishDomainEvent(store, makeEvent({ type: "lead.first_touch", source: "savvy", tenantId, correlationId: "l6", idempotencyKey: "lead.first_touch:l6", payload: { leadId: "l6", channel: "sms", latencySeconds: 30 } }));
  expect(r.published).toBe(true);
  const businessDate = businessDateOf(new Date());
  const events = await loadEventsForDay(tenantId, businessDate);
  const m = projectDay(events, businessDate);
  expect(m.speed.medianSpeedToLeadMs).toBe(30_000);
  expect(m.speed.pctLeadsUnder5Min).toBe(1);
});

// CHECK 10-real — idempotency
it("§8.10 publishing the same first_touch twice yields exactly one orchestrator_event row", async () => {
  const store = new DrizzleOrchestratorStore();
  const mk = () => makeEvent({ type: "lead.first_touch", source: "savvy", tenantId, correlationId: "l10", idempotencyKey: "lead.first_touch:l10", payload: { leadId: "l10", channel: "sms", latencySeconds: 12 } });
  expect((await publishDomainEvent(store, mk())).published).toBe(true);
  expect((await publishDomainEvent(store, mk())).published).toBe(false);
  const rows = await adminDb.select().from(orchestratorEvent).where(and(eq(orchestratorEvent.tenantId, tenantId), eq(orchestratorEvent.idempotencyKey, "lead.first_touch:l10"), eq(orchestratorEvent.outcome, "received")));
  expect(rows).toHaveLength(1);
});

// CHECK 7-breach — the durable breach escalation lands in the queue
it("§8.7 bridgeBreach publishes lead.sla_breach → speed-to-lead-breach escalation → exception_queue", async () => {
  const store = new DrizzleOrchestratorStore();
  const { breach } = await bridgeBreach(store, { tenantId, leadId: "l7", minutes: 12 });
  expect(breach?.ruleId).toBe("speed-to-lead-breach");
  await recordException(tenantId, breach!);
  expect((await listQueue(tenantId)).some((r) => r.ruleId === "speed-to-lead-breach")).toBe(true);
});
```

Use UNIQUE per-test entity ids (leadId/phone) so checks don't collide within the shared tenant. Verify the real `businessDateOf`/`loadEventsForDay`/`projectDay` imports and the `DailyMetrics.speed` field names (`medianSpeedToLeadMs`/`pctLeadsUnder5Min`) against the code before finalizing.

- [ ] **Step 2: Run** `npx vitest run src/command-center/acceptance-day3.test.ts --root packages/db` (or `pnpm --filter @savvy/db test -- acceptance-day3`) against local Postgres → all PASS. If a check fails, determine test-bug vs real-gap (STOP + report the latter). `pnpm --filter @savvy/db typecheck`.

- [ ] **Step 3: Commit** `test(db): Day 3 §8 acceptance — real-DB checks (cross-agent STOP, a2p compliance-block, first-touch e2e, idempotency, breach)`.

---

## Task D3: Slice D gate + PR (regression pass = check 11)

**Files:** none (verification + PR).

- [ ] **Step 1:** Clean the known local shared-DB fixture corruption first (dependency-order DELETE of `task_registry` id≥9000 + dependents `lead_task`/`task_health`/`job_task`/`task_exception` in `savvy_db` docker).
- [ ] **Step 2: Full gate mirroring CI (this IS check 11 — the regression pass):** `pnpm typecheck` (9 pkgs) + `pnpm lint` fully green; then `pnpm test` (the CI command = `vitest run` over `packages/*`) — ALL existing behaviors + the two new acceptance files must pass; then `pnpm --filter @savvy/web test`. Do NOT run Playwright e2e. If a non-Slice-D suite fails, prove it's the pre-existing cross-worktree shared-DB flake (passes in isolation; Slice D adds only test files) before proceeding.
- [ ] **Step 3: Push + PR:**

```bash
git push -u origin day3-sliceD
gh pr create --base main --head day3-sliceD --title "Day 3 Slice D — §8 acceptance test (proves A+B+C end-to-end)" --body "<summary: 2 acceptance files (agents pure/injectable + db real-Postgres) covering the 11 §8 checks; NO production code, NO migration; note check 7 'survives restart' is asserted structurally + documented as Inngest-runtime-only; check 11 regression = full suite green>"
```

- [ ] **Step 4:** Report PR URL + CI status; STOP for Brett's per-PR merge word.

---

## Self-Review (completed during authoring)

- **Coverage:** all 11 §8 checks mapped to a concrete seam + file (table above); no check silently dropped. Check 7's un-unit-testable portion is explicitly documented, not faked. Check 11 = the gate.
- **No production code / no migration** — confirmed: every seam exists; Slice D is test-only.
- **No tautologies mandated** — each representative assertion drives a real function and asserts a concrete value (blocked reason, ES string, 30_000ms, row count === 1). The Global Constraints forbid mock-echoes-mock and forbid weakening an assertion to force green.
- **Honesty requirement** baked in: a failing check that reflects a real gap must be surfaced, not papered over.
- **Type/name consistency:** metric fields (`medianSpeedToLeadMs`/`pctLeadsUnder5Min`), send-unit return shapes, and event payload keys are pinned to recon `path:line`; each task says to verify the real shape before finalizing.
