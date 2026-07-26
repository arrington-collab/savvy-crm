# Day 3 Slice B — The Bridge + Durable Escalations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish canonical DomainEvents from the live Inngest functions into the standalone orchestrator event log (the "bridge"), complete the durable `speed-to-lead-breach` timer, and land three escalation types (`speed-to-lead-breach`, `assignment-failure`, `compliance-block`) in the Command Center `exception_queue` — so the Day-2 read model finally populates from real agent activity.

**Architecture:** A thin `publishDomainEvent()` in `@savvy/orchestrator` (validate → idempotent insert → record escalation, NO subscriber dispatch) is called inside `step.run(...)` at each emission point, so publication is durable + retried + idempotent via the Day-1 `(tenant_id, idempotency_key) WHERE outcome='received'` partial unique index. Escalations are projected into `exception_queue` by a new `recordException()` in `@savvy/db`. The event vocabulary is extended additively (never rename) to carry the frozen Appendix-A.1 fields.

**Tech Stack:** TypeScript, pnpm + Turborepo monorepo, Drizzle ORM + Postgres (RLS via `withTenant`), Inngest (durable steps), Vitest.

## Global Constraints

- **Frozen contracts are additive-only** — never rename/reshape/relocate an existing event payload field or table column. Extend by adding optional fields.
- **Bridge publishes inside `step.run(...)`** — never at the top level of an Inngest function; durability + idempotency come from the step boundary + the Day-1 unique index.
- **Idempotency key format** matches the existing publishers: `` `${eventType}:${entityId}` `` (see `publishers.ts:8-40`). One first touch per lead, one reminder per (appt,offset), one drip step per (enrollment,step) — retries never double-write.
- **Tenant isolation** — every orchestrator/queue write goes through `withTenant()` (already true in `DrizzleOrchestratorStore` and `upsertQueueItem`). No raw query bypasses RLS.
- **`source` must be one of the `Tool` enum** (`events.ts:5-7`): the bridge uses `source: "savvy"`. There is no `"agents"` source — do not add one.
- **Fail-soft on the bridge** — a publish failure must never crash the primary agent action (the SMS was already sent). Wrap bridge calls so a publish error is logged, not thrown, EXCEPT where the publish IS the durable step's only work (then let Inngest retry it).
- **No new migration** unless a task explicitly says so. Slice B reuses the Day-1 `orchestrator_event`/`orchestrator_escalation` and Day-2 `daily_metrics`/`exception_queue` tables as-is.
- **Every task ends green:** `pnpm typecheck` + the task's tests pass before commit. Co-author trailer on commits: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

## File Structure

**New files:**
- `packages/orchestrator/src/bridge.ts` — `publishDomainEvent(store, event)` thin durable publish + `PublishResult`.
- `packages/orchestrator/src/bridge.test.ts` — unit tests (InMemoryStore).
- `packages/command-center/src/exception-map.ts` — pure `escalationToQueueItem(esc, at)`.
- `packages/command-center/src/exception-map.test.ts`.

**Modified files:**
- `packages/orchestrator/src/events.ts` — extend `lead.first_touch` + `lead.assigned` payloads; add `call.missed`, `contact.opted_out`, `message.inbound`, `reminder.sent`, `drip.step.sent`.
- `packages/orchestrator/src/publishers.ts` — add typed publisher helpers for the new/extended events.
- `packages/orchestrator/src/escalations.ts` — add `speed-to-lead-breach`, `assignment-failure`, `compliance-block` rules (event-driven where possible) + a `makeComplianceBlock()` constructor for the non-event (guardedSms) case.
- `packages/orchestrator/src/index.ts` — export `bridge` (auto via `export *` if added to a barrel; add explicit line).
- `packages/command-center/src/projection.ts` — fold `lead.first_touch.latencySeconds` directly into the speed metric.
- `packages/command-center/src/index.ts` — export `exception-map`.
- `packages/db/src/command-center/store.ts` — add `recordException(tenantId, esc)` (maps + upserts a QueueItem).
- `packages/db/src/index.ts` — export `recordException`.
- `packages/agents/package.json` — add `@savvy/orchestrator` dependency.
- `packages/agents/src/functions/lead-intake.ts` — publish `lead.first_touch` (+ deferred fields), `lead.assigned`, `assignment-failure`, `compliance-block`.
- `packages/agents/src/functions/lead-speed-to-lead.ts` — record `speed-to-lead-breach` escalation.
- `packages/agents/src/functions/appointment-reminders.ts` — publish `reminder.sent`.
- `packages/agents/src/functions/drip.ts` — publish `drip.step.sent` + `compliance-block`.
- `apps/web/src/lib/inbound-sms.ts` + `apps/web/src/app/api/twilio/inbound/route.ts` — publish `message.inbound` + `contact.opted_out`.
- `apps/web/src/lib/scheduling-actions.ts` + `apps/web/src/lib/booking-action.ts` — publish `appointment.set` / `appointment.no_show`.

---

## Task B1: Extend event vocabulary + typed publishers

**Files:**
- Modify: `packages/orchestrator/src/events.ts` (the `payloadSchemas` object, ~`:16-41`)
- Modify: `packages/orchestrator/src/publishers.ts`
- Test: `packages/orchestrator/src/publishers.test.ts` (extend existing) + `packages/orchestrator/src/events.test.ts`

**Interfaces:**
- Consumes: `makeEvent`, `validateEvent`, `EventType`, `PayloadFor` (`events.ts`); `Orchestrator.publish` (`engine.ts:26`).
- Produces (later tasks rely on these exact names/signatures):
  - Extended `lead.first_touch` payload: `{ leadId: string; channel: string; locationId?: string | null; latencySeconds?: number; occurredAtLeadCreated?: string; slaLatencySeconds?: number; quietHoursDeferred?: boolean }`
  - Extended `lead.assigned` payload: `{ leadId: string; userId: string; repId?: string; locationId?: string | null; territory?: string }`
  - New: `reminder.sent { leadId: string; locationId?: string | null; appointmentId: string; offset: "24h" | "1h"; channel: string }`
  - New: `drip.step.sent { leadId?: string | null; customerId: string; locationId?: string | null; step: number; channel: string }`
  - New: `message.inbound { contactId?: string | null; customerId?: string | null; leadId?: string | null; locationId?: string | null; channel: string; isOptOut: boolean }`
  - New: `contact.opted_out { contactId?: string | null; customerId?: string | null; locationId?: string | null; channel: string; reason: string }`
  - New: `call.missed { leadId?: string | null; locationId?: string | null; fromNumber: string; toNumber: string }`
  - Publisher helpers: `publishFirstTouch(o, a)`, `publishLeadAssigned(o, a)`, `publishReminderSent(o, a)`, `publishDripStepSent(o, a)`, `publishMessageInbound(o, a)`, `publishContactOptedOut(o, a)`, `publishCallMissed(o, a)` — each `(o: Orchestrator, args): Promise<void>`, building `idempotencyKey` per the format below and calling `o.publish(makeEvent(...))`. NOTE: later wiring tasks call `publishDomainEvent` (Task B2) directly with `makeEvent`, not necessarily these helpers — the helpers exist for tests + the apps/web callers. Both paths are fine.

**Idempotency keys (exact):**
- `lead.first_touch` → `` `lead.first_touch:${leadId}` ``
- `lead.assigned` → `` `lead.assigned:${leadId}` ``
- `reminder.sent` → `` `reminder.sent:${appointmentId}:${offset}` ``
- `drip.step.sent` → `` `drip.step.sent:${customerId}:${step}` ``
- `message.inbound` → `` `message.inbound:${messageSid}` `` (caller passes the Twilio MessageSid as the entity id)
- `contact.opted_out` → `` `contact.opted_out:${channel}:${phoneOrContactId}` ``
- `call.missed` → `` `call.missed:${fromNumber}:${toNumber}:${occurredAt}` ``

- [ ] **Step 1: Write the failing test** — extend `events.test.ts`:

```ts
import { it, expect } from "vitest";
import { makeEvent, validateEvent } from "./events";

it("accepts an extended lead.first_touch with latency + deferred fields", () => {
  const e = makeEvent({
    type: "lead.first_touch",
    source: "savvy",
    tenantId: "11111111-1111-1111-1111-111111111111",
    correlationId: "c1",
    idempotencyKey: "lead.first_touch:lead-1",
    payload: { leadId: "lead-1", channel: "sms", locationId: null, latencySeconds: 42, occurredAtLeadCreated: "2026-07-26T10:00:00.000Z", slaLatencySeconds: 42, quietHoursDeferred: false },
  });
  const r = validateEvent(e);
  expect(r.ok).toBe(true);
});

it("accepts the new reminder.sent, drip.step.sent, message.inbound, contact.opted_out, call.missed", () => {
  const base = { source: "savvy" as const, tenantId: "11111111-1111-1111-1111-111111111111", correlationId: "c1" };
  const events = [
    makeEvent({ ...base, type: "reminder.sent", idempotencyKey: "reminder.sent:a1:24h", payload: { leadId: "l1", appointmentId: "a1", offset: "24h", channel: "sms" } }),
    makeEvent({ ...base, type: "drip.step.sent", idempotencyKey: "drip.step.sent:c1:2", payload: { customerId: "c1", step: 2, channel: "sms" } }),
    makeEvent({ ...base, type: "message.inbound", idempotencyKey: "message.inbound:SM1", payload: { customerId: "c1", channel: "sms", isOptOut: true } }),
    makeEvent({ ...base, type: "contact.opted_out", idempotencyKey: "contact.opted_out:sms:+15551234567", payload: { channel: "sms", reason: "stop" } }),
    makeEvent({ ...base, type: "call.missed", idempotencyKey: "call.missed:+1a:+1b:t", payload: { fromNumber: "+1a", toNumber: "+1b" } }),
  ];
  for (const e of events) expect(validateEvent(e).ok).toBe(true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @savvy/orchestrator test -- events.test.ts`
Expected: FAIL — `message.inbound` etc. not assignable to `EventType`; extended fields rejected by the payload schema.

- [ ] **Step 3: Implement** — in `events.ts`, extend the two existing entries and add the five new ones inside `payloadSchemas`. Each schema is the existing lightweight validator style already used in that file (match the surrounding pattern for optional vs required fields — read `events.ts:16-41` first and mirror it exactly; do NOT introduce a new validation library). Ensure `EventType`, `PayloadFor`, and `validateEvent` derive from `payloadSchemas` (they already do at `events.ts:14-15,43-44`), so only the object literal changes.

- [ ] **Step 4: Add publisher helpers** — in `publishers.ts`, mirror the existing `publishLeadCreated` shape (`:8-17`). Example:

```ts
export async function publishFirstTouch(
  o: Orchestrator,
  a: { tenantId: string; leadId: string; channel: string; locationId?: string | null; latencySeconds?: number; occurredAtLeadCreated?: string; slaLatencySeconds?: number; quietHoursDeferred?: boolean; correlationId?: string },
): Promise<void> {
  await o.publish(makeEvent({
    type: "lead.first_touch",
    source: "savvy",
    tenantId: a.tenantId,
    correlationId: a.correlationId ?? a.leadId,
    idempotencyKey: `lead.first_touch:${a.leadId}`,
    payload: { leadId: a.leadId, channel: a.channel, locationId: a.locationId ?? null, latencySeconds: a.latencySeconds, occurredAtLeadCreated: a.occurredAtLeadCreated, slaLatencySeconds: a.slaLatencySeconds, quietHoursDeferred: a.quietHoursDeferred },
  }));
}
```

Add the analogous `publishLeadAssigned`, `publishReminderSent`, `publishDripStepSent`, `publishMessageInbound`, `publishContactOptedOut`, `publishCallMissed` with the idempotency keys listed above. Add a test in `publishers.test.ts` that each helper, given an `Orchestrator` with an `InMemoryStore`, results in one recorded event (`store.audits` contains a `received` outcome) and is idempotent on a second call.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @savvy/orchestrator test && pnpm --filter @savvy/orchestrator typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/orchestrator/src/events.ts packages/orchestrator/src/publishers.ts packages/orchestrator/src/events.test.ts packages/orchestrator/src/publishers.test.ts
git commit -m "feat(orchestrator): extend event vocabulary for the Slice B bridge"
```

---

## Task B2: `publishDomainEvent()` — the thin durable bridge

**Files:**
- Create: `packages/orchestrator/src/bridge.ts`
- Create: `packages/orchestrator/src/bridge.test.ts`
- Modify: `packages/orchestrator/src/index.ts` (add `export * from "./bridge";`)

**Interfaces:**
- Consumes: `DomainEvent`, `validateEvent` (`events.ts`); `OrchestratorStore`, `InMemoryStore` (`store.ts`); `evaluateEscalations` (`escalations.ts:58`).
- Produces:
  - `type PublishResult = { published: boolean; escalations: EscalationRecord[] }`
  - `async function publishDomainEvent(store: OrchestratorStore, event: DomainEvent): Promise<PublishResult>`

**Why not reuse `Orchestrator.publish`:** `publish()` runs subscriber choreography (`triggers.ts`). In the bridge, the Inngest functions ARE the choreography — running subscribers here would re-fire agent actions on every Inngest step retry. `publishDomainEvent` does only: validate → `insertEventIfNew` (idempotent) → if newly inserted, `evaluateEscalations` and `recordEscalation` each hit. It returns the hits so the caller can also project them into `exception_queue` (Task B3).

- [ ] **Step 1: Write the failing test** — `bridge.test.ts`:

```ts
import { it, expect } from "vitest";
import { makeEvent } from "./events";
import { InMemoryStore } from "./store";
import { publishDomainEvent } from "./bridge";

const TENANT = "11111111-1111-1111-1111-111111111111";
const ev = () => makeEvent({
  type: "lead.first_touch", source: "savvy", tenantId: TENANT,
  correlationId: "lead-1", idempotencyKey: "lead.first_touch:lead-1",
  payload: { leadId: "lead-1", channel: "sms", latencySeconds: 10 },
});

it("inserts a new event once and reports published=true", async () => {
  const store = new InMemoryStore();
  const r = await publishDomainEvent(store, ev());
  expect(r.published).toBe(true);
  expect(store.audits.some((a) => a.idempotencyKey === "lead.first_touch:lead-1")).toBe(true);
});

it("is idempotent — a second publish of the same key reports published=false and adds no audit", async () => {
  const store = new InMemoryStore();
  await publishDomainEvent(store, ev());
  const before = store.audits.length;
  const r = await publishDomainEvent(store, ev());
  expect(r.published).toBe(false);
  expect(store.audits.length).toBe(before);
});

it("rejects an invalid event without throwing (published=false)", async () => {
  const store = new InMemoryStore();
  const bad = { ...ev(), tenantId: "not-a-uuid" };
  const r = await publishDomainEvent(store, bad as any);
  expect(r.published).toBe(false);
});

it("records an escalation hit when the event matches a rule", async () => {
  // handler.failed always escalates (escalations.ts). Use it to prove the sink is wired.
  const store = new InMemoryStore();
  const e = makeEvent({ type: "handler.failed", source: "savvy", tenantId: TENANT, correlationId: "x", idempotencyKey: "handler.failed:x", payload: { handler: "h", error: "boom" } });
  const r = await publishDomainEvent(store, e);
  expect(r.escalations.length).toBeGreaterThan(0);
  expect(store.escalations.length).toBe(r.escalations.length);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @savvy/orchestrator test -- bridge.test.ts`
Expected: FAIL — `./bridge` not found.

- [ ] **Step 3: Implement `bridge.ts`:**

```ts
import type { DomainEvent } from "./events";
import { validateEvent } from "./events";
import type { OrchestratorStore, EscalationRecord } from "./store";
import { evaluateEscalations } from "./escalations";

export interface PublishResult {
  published: boolean;
  escalations: EscalationRecord[];
}

/**
 * Thin durable publish for the Inngest bridge. Unlike Orchestrator.publish(),
 * it does NOT run subscriber choreography — the live agent functions ARE the
 * choreography, so re-running subscribers on an Inngest step retry would double
 * -fire agent actions. Contract: validate -> idempotent insert -> record any
 * escalation hits. Idempotency is the Day-1 (tenant_id, idempotency_key) partial
 * unique index; escalations are only evaluated when the event is newly inserted.
 */
export async function publishDomainEvent(
  store: OrchestratorStore,
  event: DomainEvent,
): Promise<PublishResult> {
  const v = validateEvent(event);
  if (!v.ok) return { published: false, escalations: [] };

  const inserted = await store.insertEventIfNew(v.event);
  if (!inserted) return { published: false, escalations: [] };

  const hits = evaluateEscalations(v.event);
  const records: EscalationRecord[] = hits.map((h) => ({
    ...h,
    tenantId: v.event.tenantId,
    correlationId: v.event.correlationId,
    eventId: v.event.id,
    eventType: v.event.type,
  }));
  for (const r of records) await store.recordEscalation(r);
  return { published: true, escalations: records };
}
```

Verify `EscalationRecord` field names against `store.ts:12-17` and `EscalationHit` against `escalations.ts:14-19`; adjust the spread if the real shape differs.

- [ ] **Step 4: Export + run**

Add `export * from "./bridge";` to `packages/orchestrator/src/index.ts`.
Run: `pnpm --filter @savvy/orchestrator test && pnpm --filter @savvy/orchestrator typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/orchestrator/src/bridge.ts packages/orchestrator/src/bridge.test.ts packages/orchestrator/src/index.ts
git commit -m "feat(orchestrator): publishDomainEvent thin durable bridge"
```

---

## Task B3: Escalations + escalation→exception_queue projector

**Files:**
- Modify: `packages/orchestrator/src/escalations.ts`
- Create: `packages/command-center/src/exception-map.ts` + `.test.ts`
- Modify: `packages/command-center/src/index.ts` (export exception-map)
- Modify: `packages/db/src/command-center/store.ts` (add `recordException`)
- Modify: `packages/db/src/index.ts` (export `recordException`)
- Test: `packages/db/src/command-center/store.test.ts` (extend)

**Interfaces:**
- Consumes: `ESCALATIONS`, `EscalationHit`, `Severity`, `evaluateEscalations` (`escalations.ts`); `EscalationRecord` (`store.ts:12`); `QueueItem`, `escalationToQueueItem` inputs (`exception-queue.ts:5-19`); `upsertQueueItem` (`db/command-center/store.ts:24`).
- Produces:
  - `escalationToQueueItem(esc: EscalationRecord, at: string): QueueItem` (pure; key = `` `${esc.ruleId}:${esc.eventId}` ``, `assignee = esc.notify[0] ?? "unassigned"`, `state: "open"`) — in `command-center/exception-map.ts`.
  - `makeComplianceBlock(input: { tenantId: string; correlationId: string; eventId: string; eventType: string; reason: string; notify?: string[] }): EscalationRecord` — in `escalations.ts`, for the guardedSms `blocked` case which is NOT a DomainEvent.
  - `recordException(tenantId: string, esc: EscalationRecord, at?: Date): Promise<void>` — in `db/command-center/store.ts`; maps via `escalationToQueueItem` then `upsertQueueItem` (idempotent on `(tenant_id, escalation_key)`).

- [ ] **Step 1 — escalation rules (RED):** In `escalations.ts`, add three DATA rules to `ESCALATIONS` and a constructor. First write the test in `escalations.test.ts`:

```ts
import { it, expect } from "vitest";
import { evaluateEscalations, makeComplianceBlock } from "./escalations";
import { makeEvent } from "./events";

const T = "11111111-1111-1111-1111-111111111111";

it("escalates speed-to-lead-breach on a lead.sla_breach event", () => {
  const e = makeEvent({ type: "lead.sla_breach", source: "savvy", tenantId: T, correlationId: "l1", idempotencyKey: "lead.sla_breach:l1", payload: { leadId: "l1", minutes: 12 } });
  const hits = evaluateEscalations(e);
  expect(hits.some((h) => h.ruleId === "speed-to-lead-breach")).toBe(true);
});

it("escalates assignment-failure on a lead.assignment_failed event", () => {
  const e = makeEvent({ type: "lead.assignment_failed", source: "savvy", tenantId: T, correlationId: "l1", idempotencyKey: "lead.assignment_failed:l1", payload: { leadId: "l1", reason: "no-candidate" } });
  expect(evaluateEscalations(e).some((h) => h.ruleId === "assignment-failure")).toBe(true);
});

it("makeComplianceBlock builds a compliance-block escalation record", () => {
  const r = makeComplianceBlock({ tenantId: T, correlationId: "l1", eventId: "e1", eventType: "lead.first_touch", reason: "a2p_unapproved" });
  expect(r.ruleId).toBe("compliance-block");
  expect(r.severity).toBe("high");
});
```

This introduces two more events — `lead.sla_breach { leadId; minutes }` and `lead.assignment_failed { leadId; reason }`. Add them to `payloadSchemas` in `events.ts` (same additive step as B1; if B1 is already merged, add here). `compliance-block` is NOT event-driven (its trigger is a guardedSms verdict), so it has no rule in `ESCALATIONS` — only the `makeComplianceBlock` constructor.

- [ ] **Step 2:** Run `pnpm --filter @savvy/orchestrator test -- escalations.test.ts` → FAIL.

- [ ] **Step 3:** Implement in `escalations.ts`: add two entries to `ESCALATIONS` (mirror the existing rule shape at `:22-56` — `{ ruleId, event: "lead.sla_breach", severity: "high", reason: (e) => ..., notify: [...], when: (e) => true }`; match the real `EscalationRule` field names exactly), and:

```ts
export function makeComplianceBlock(input: {
  tenantId: string; correlationId: string; eventId: string; eventType: string; reason: string; notify?: string[];
}): EscalationRecord {
  return {
    ruleId: "compliance-block",
    severity: "high",
    reason: `SMS blocked: ${input.reason}`,
    notify: input.notify ?? [],
    tenantId: input.tenantId,
    correlationId: input.correlationId,
    eventId: input.eventId,
    eventType: input.eventType,
  };
}
```

Run the test → PASS.

- [ ] **Step 4 — pure mapper (RED):** `exception-map.test.ts`:

```ts
import { it, expect } from "vitest";
import { escalationToQueueItem } from "./exception-map";

const esc = { ruleId: "compliance-block", severity: "high" as const, reason: "SMS blocked: a2p_unapproved", notify: ["ops"], tenantId: "t", correlationId: "l1", eventId: "e1", eventType: "lead.first_touch" };

it("maps an escalation record to an open queue item with a stable key", () => {
  const it0 = escalationToQueueItem(esc, "2026-07-26T10:00:00.000Z");
  expect(it0.key).toBe("compliance-block:e1");
  expect(it0.state).toBe("open");
  expect(it0.assignee).toBe("ops");
  expect(it0.severity).toBe("high");
});

it("defaults assignee to unassigned when notify is empty", () => {
  expect(escalationToQueueItem({ ...esc, notify: [] }, "2026-07-26T10:00:00.000Z").assignee).toBe("unassigned");
});
```

- [ ] **Step 5:** Implement `exception-map.ts` mirroring `ExceptionQueue.intake` field construction (`exception-queue.ts:46-61`):

```ts
import type { EscalationRecord } from "@savvy/orchestrator";
import type { QueueItem } from "./exception-queue";

export function escalationToQueueItem(esc: EscalationRecord, at: string): QueueItem {
  return {
    key: `${esc.ruleId}:${esc.eventId}`,
    ruleId: esc.ruleId,
    eventId: esc.eventId,
    severity: esc.severity,
    reason: esc.reason,
    notify: esc.notify,
    assignee: esc.notify[0] ?? "unassigned",
    state: "open",
    acknowledgedAt: null,
    resolvedAt: null,
    resolutionNote: null,
    snoozeUntil: null,
    createdAt: at,
  };
}
```

Verify every `QueueItem` field against `exception-queue.ts:5-19` and match nullability exactly. Export from `command-center/src/index.ts`. Run `pnpm --filter @savvy/command-center test` → PASS.

- [ ] **Step 6 — db `recordException` (RED):** extend `db/src/command-center/store.test.ts`:

```ts
it("recordException upserts an open queue item idempotently", async () => {
  const esc = { ruleId: "assignment-failure", severity: "medium" as const, reason: "no-candidate", notify: [], tenantId, correlationId: "l1", eventId: "e-abc", eventType: "lead.assignment_failed" };
  await recordException(tenantId, esc, new Date("2026-07-26T10:00:00.000Z"));
  await recordException(tenantId, esc, new Date("2026-07-26T10:00:00.000Z"));
  const rows = await listQueue(tenantId);
  expect(rows.filter((r) => r.escalationKey === "assignment-failure:e-abc")).toHaveLength(1);
});
```

(Match the existing tenant-seeding `beforeAll` in that test file and import `recordException`, `listQueue`.)

- [ ] **Step 7:** Implement `recordException` in `db/src/command-center/store.ts`:

```ts
import { escalationToQueueItem } from "@savvy/command-center";
import type { EscalationRecord } from "@savvy/orchestrator";

export async function recordException(tenantId: string, esc: EscalationRecord, at: Date = new Date()): Promise<void> {
  const item = escalationToQueueItem(esc, at.toISOString());
  await upsertQueueItem(tenantId, item);
}
```

Confirm `@savvy/command-center` and `@savvy/orchestrator` are already deps of `@savvy/db` (they are — `db` imports `QueueItem`/`EscalationRecord` today). Export from `db/src/index.ts`. Run `pnpm --filter @savvy/db test -- command-center/store.test.ts` → PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/orchestrator/src/escalations.ts packages/orchestrator/src/escalations.test.ts packages/orchestrator/src/events.ts packages/command-center/src/exception-map.ts packages/command-center/src/exception-map.test.ts packages/command-center/src/index.ts packages/db/src/command-center/store.ts packages/db/src/command-center/store.test.ts packages/db/src/index.ts
git commit -m "feat: Slice B escalations + escalation->exception_queue projector"
```

---

## Task B4: Fold `lead.first_touch.latencySeconds` into the speed metric

**Files:**
- Modify: `packages/command-center/src/projection.ts` (the `lead.first_touch` case, ~`:98-109`)
- Test: `packages/command-center/src/projection.test.ts`

**Interfaces:**
- Consumes: `DomainEvent`, `projectDay`, `DailyMetrics`, `SLA_MS` (`projection.ts`).
- Produces: no signature change. Behavior change: when a `lead.first_touch` event carries `payload.latencySeconds`, the speed metric uses it directly (in addition to the existing `lead.created`↔`lead.first_touch` pairing), so the Speed panel populates even when no paired `lead.created` DomainEvent exists.

- [ ] **Step 1: RED** — add to `projection.test.ts`:

```ts
it("uses lead.first_touch.latencySeconds directly for the speed metric", () => {
  const D = "2026-07-26";
  const e = makeEvent({ type: "lead.first_touch", source: "savvy", tenantId: T, correlationId: "l1", idempotencyKey: "lead.first_touch:l1", payload: { leadId: "l1", channel: "sms", latencySeconds: 45 }, occurredAt: `${D}T10:00:00.000Z` });
  const m = projectDay([e], D);
  expect(m.speed.firstTouchCount).toBeGreaterThan(0);
  expect(m.speed.withinSlaCount).toBe(1); // 45s < 5min SLA
});
```

(Read `projection.ts:14-21` for the real `DailyMetrics.speed` field names — `firstTouchCount`/`withinSlaCount` are illustrative; use the actual names from `metrics.ts:1-21`.)

- [ ] **Step 2:** Run `pnpm --filter @savvy/command-center test -- projection.test.ts` → FAIL (currently speed requires a paired `lead.created`).

- [ ] **Step 3:** In the `lead.first_touch` branch of the `projectDay` switch, when `payload.latencySeconds != null`, increment the first-touch count and the within-SLA count (`latencySeconds * 1000 <= SLA_MS`) directly, guarding against double-counting a lead that ALSO has a paired `lead.created` (dedupe by `leadId` in a `Set`). Keep the existing pairing path for events that lack `latencySeconds`. Match the exact metric field names.

- [ ] **Step 4:** Run → PASS. Also run the full command-center suite to ensure no regression: `pnpm --filter @savvy/command-center test`.

- [ ] **Step 5: Commit**

```bash
git add packages/command-center/src/projection.ts packages/command-center/src/projection.test.ts
git commit -m "feat(command-center): fold first_touch latencySeconds into speed metric"
```

---

## Task B5: Wire lead-intake — first_touch, assigned, assignment-failure, compliance-block

**Files:**
- Modify: `packages/agents/package.json` (add `"@savvy/orchestrator": "workspace:*"`)
- Modify: `packages/agents/src/functions/lead-intake.ts` (steps `"assign-lead"` `:278-293` and `"send-ack"` `:295-340`)
- Test: `packages/agents/src/functions/lead-intake.test.ts` (add bridge assertions using an injected store) OR a new `lead-intake-bridge.test.ts`

**Interfaces:**
- Consumes: `publishDomainEvent`, `makeEvent`, `makeComplianceBlock` (`@savvy/orchestrator`); `DrizzleOrchestratorStore`, `recordException` (`@savvy/db`); `guardedSms` result union (`comms-gateway.ts:4-7`); `runLeadAssignment` (`lead-intake.ts:103`).
- Produces: durable bridge publications inside the existing steps. No new exported signatures except a testability seam (below).

**Testability seam:** the current `send-ack`/`assign-lead` steps resolve the store internally. To keep the DB-free unit-test pattern, extract a pure helper that the step calls and that a test can drive with an `InMemoryStore`. Add near the other pure helpers in `lead-intake.ts`:

```ts
import type { OrchestratorStore } from "@savvy/orchestrator";
import { publishDomainEvent, makeEvent, makeComplianceBlock } from "@savvy/orchestrator";

/** Publish first-touch + (on block) a compliance-block escalation record. Returns the escalation for the caller to queue. */
export async function bridgeFirstTouch(
  store: OrchestratorStore,
  a: { tenantId: string; leadId: string; locationId?: string | null; latencySeconds: number; occurredAtLeadCreated: string; result: import("../comms-gateway").GuardedSmsResult },
): Promise<{ complianceBlock?: import("@savvy/orchestrator").EscalationRecord }> {
  const deferred = a.result.status === "deferred";
  await publishDomainEvent(store, makeEvent({
    type: "lead.first_touch", source: "savvy", tenantId: a.tenantId,
    correlationId: a.leadId, idempotencyKey: `lead.first_touch:${a.leadId}`,
    payload: {
      leadId: a.leadId, channel: "sms", locationId: a.locationId ?? null,
      latencySeconds: a.latencySeconds, occurredAtLeadCreated: a.occurredAtLeadCreated,
      slaLatencySeconds: a.latencySeconds, quietHoursDeferred: deferred,
    },
  }));
  if (a.result.status === "blocked") {
    const esc = makeComplianceBlock({ tenantId: a.tenantId, correlationId: a.leadId, eventId: `lead.first_touch:${a.leadId}`, eventType: "lead.first_touch", reason: a.result.reason });
    await store.recordEscalation(esc);
    return { complianceBlock: esc };
  }
  return {};
}
```

- [ ] **Step 1: RED** — unit test with `InMemoryStore`:

```ts
it("bridgeFirstTouch publishes lead.first_touch and queues a compliance-block on a blocked send", async () => {
  const store = new InMemoryStore();
  const r = await bridgeFirstTouch(store, { tenantId: T, leadId: "l1", latencySeconds: 12, occurredAtLeadCreated: "2026-07-26T10:00:00.000Z", result: { status: "blocked", reason: "a2p_unapproved" } });
  expect(store.audits.some((x) => x.idempotencyKey === "lead.first_touch:l1")).toBe(true);
  expect(r.complianceBlock?.ruleId).toBe("compliance-block");
});
it("marks quietHoursDeferred when the send was deferred", async () => {
  const store = new InMemoryStore();
  await bridgeFirstTouch(store, { tenantId: T, leadId: "l2", latencySeconds: 3, occurredAtLeadCreated: "2026-07-26T10:00:00.000Z", result: { status: "deferred", untilIso: "2026-07-26T15:00:00.000Z" } });
  const audit = store.audits.find((x) => x.idempotencyKey === "lead.first_touch:l2");
  expect(audit).toBeTruthy();
});
```

- [ ] **Step 2:** Run `pnpm --filter @savvy/agents test -- lead-intake` → FAIL (`bridgeFirstTouch` undefined; `@savvy/orchestrator` not a dep).

- [ ] **Step 3:** Add the dep to `packages/agents/package.json`, run `pnpm install`, implement `bridgeFirstTouch` (above) + an analogous `bridgeAssignment(store, {tenantId, leadId, result})` that publishes `lead.assigned {leadId, userId: assigned, repId: assigned, territory}` when `result.assigned != null`, else publishes a `lead.assignment_failed` event (which evaluates to the `assignment-failure` escalation via B3) and returns its escalation. Then call these helpers inside the existing steps:
  - In `"assign-lead"` (`:278-293`): after `runLeadAssignment` returns, `await step.run("bridge-assigned", () => bridgeAssignment(new DrizzleOrchestratorStore(), {...}))`, then `recordException` for any returned escalation.
  - In `"send-ack"` (`:322-340`): compute `latencySeconds = (Date.now() - lead.createdAt.getTime())/1000` (fetch the lead's `createdAt` — add a small `getLeadCreatedAt(tenantId, leadId)` read in `db/src/lifecycle/leads.ts` if not already loaded), then `await step.run("bridge-first-touch", () => bridgeFirstTouch(new DrizzleOrchestratorStore(), {...result}))`, then `recordException` for any `complianceBlock`. Replace the existing `// Slice B` TODO comment.

  Wrap each `step.run` bridge call so a publish error is caught and logged (fail-soft) — the ack SMS already went out.

- [ ] **Step 4:** Run `pnpm --filter @savvy/agents test && pnpm --filter @savvy/agents typecheck` → PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agents/package.json packages/agents/src/functions/lead-intake.ts packages/agents/src/functions/lead-intake.test.ts packages/db/src/lifecycle/leads.ts pnpm-lock.yaml
git commit -m "feat(agents): bridge lead-intake first_touch + assignment escalations"
```

---

## Task B6: Wire lead-speed-to-lead — durable `speed-to-lead-breach`

**Files:**
- Modify: `packages/agents/src/functions/lead-speed-to-lead.ts` (steps `"emit-overdue"` `:87-91` and `"reassign"` `:102-113`)
- Test: `packages/agents/src/functions/lead-speed-to-lead.test.ts` (extend; assert on the injected store)

**Interfaces:**
- Consumes: `publishDomainEvent`, `makeEvent` (`@savvy/orchestrator`); `DrizzleOrchestratorStore`, `recordException` (`@savvy/db`).
- Produces: a `speed-to-lead-breach` escalation in `exception_queue` when the SLA timer fires. The durable `step.sleep`/`cancelOn` infra already exists (`:45-48,:77,:93`) — this task only adds the orchestrator-side emission; do not change the timer logic.

- [ ] **Step 1: RED** — extract a pure `bridgeBreach(store, {tenantId, leadId, minutes})` that publishes a `lead.sla_breach` event (idempotencyKey `` `lead.sla_breach:${leadId}` ``) and records the resulting `speed-to-lead-breach` escalation; test it with `InMemoryStore` (event audited + one escalation recorded, idempotent on re-run).

- [ ] **Step 2:** Run → FAIL.

- [ ] **Step 3:** Implement `bridgeBreach`; call it inside a new `step.run("bridge-breach", () => bridgeBreach(new DrizzleOrchestratorStore(), {...}))` right after the existing `"emit-overdue"` step, and `recordException` for the escalation. (Emit once at the overdue point; the idempotency key keeps a later `reassign` from double-queuing.) Fail-soft wrap.

- [ ] **Step 4:** Run `pnpm --filter @savvy/agents test -- lead-speed-to-lead && pnpm --filter @savvy/agents typecheck` → PASS.

- [ ] **Step 5: Commit** `feat(agents): bridge speed-to-lead-breach escalation`.

---

## Task B7: Wire appointment-reminders — `reminder.sent`

**Files:**
- Modify: `packages/agents/src/functions/appointment-reminders.ts` (send step `` `send-${r.offsetH}-${r.channel}` `` `:71-98`)
- Test: `packages/agents/src/functions/appointment-reminders.test.ts`

**Interfaces:**
- Consumes: `publishDomainEvent`, `makeEvent` (`@savvy/orchestrator`); `DrizzleOrchestratorStore` (`@savvy/db`).
- Produces: a `reminder.sent { leadId, appointmentId, offset, channel }` event on each successful reminder. `offset` is `` `${r.offsetH}h` `` narrowed to `"24h" | "1h"`.

- [ ] **Step 1: RED** — extract `bridgeReminderSent(store, {tenantId, leadId, appointmentId, offset, channel})`; test with `InMemoryStore` that the event is audited with idempotencyKey `` `reminder.sent:${appointmentId}:${offset}` `` and is idempotent.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement; call inside the send step only when `guardedSms` returns `status==="sent"` (`:96-98`), via `step.run("bridge-reminder-${offset}", ...)`. Fail-soft.
- [ ] **Step 4:** Run `pnpm --filter @savvy/agents test -- appointment-reminders && pnpm --filter @savvy/agents typecheck` → PASS.
- [ ] **Step 5: Commit** `feat(agents): bridge reminder.sent`.

---

## Task B8: Wire drip — `drip.step.sent` + compliance-block

**Files:**
- Modify: `packages/agents/src/functions/drip.ts` (`sendDripStep` `:69-243`, success path `:208-225`, guard result `:164-197`)
- Test: `packages/agents/src/functions/drip.test.ts`

**Interfaces:**
- Consumes: `publishDomainEvent`, `makeEvent`, `makeComplianceBlock` (`@savvy/orchestrator`); `DrizzleOrchestratorStore`, `recordException` (`@savvy/db`).
- Produces: `drip.step.sent { customerId, step, channel }` on `{sent:true}`; a `compliance-block` escalation when the guard returns `status==="blocked"`.

- [ ] **Step 1: RED** — extract `bridgeDripStep(store, {tenantId, customerId, leadId?, step, channel, result})`: on `result.status==="sent"` publish `drip.step.sent` (idempotencyKey `` `drip.step.sent:${customerId}:${step}` ``); on `"blocked"` record a `compliance-block` (eventId = that same key) and return it. Test both branches with `InMemoryStore`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement; call from within the `send-${s.stepNum}` `step.run` wrapper (drip.ts:301-315) using the `{sent}` outcome + the captured guard result. `recordException` for any block. Replace the `// Slice B` TODO at `:194-197`. Fail-soft.
- [ ] **Step 4:** Run `pnpm --filter @savvy/agents test -- drip && pnpm --filter @savvy/agents typecheck` → PASS.
- [ ] **Step 5: Commit** `feat(agents): bridge drip.step.sent + compliance-block`.

---

## Task B9: Wire apps/web — inbound + appointments

**Files:**
- Modify: `apps/web/src/lib/inbound-sms.ts` (inbound log `:24-27`, STOP branch `:56-58`)
- Modify: `apps/web/src/app/api/twilio/inbound/route.ts` (`:34-53`)
- Modify: `apps/web/src/lib/scheduling-actions.ts` (`createAppointmentAction` `:108`, `markStatusAction` `:48-63`)
- Modify: `apps/web/src/lib/booking-action.ts` (`confirmSlot` `:78,:102`)
- Test: `apps/web/src/lib/inbound-sms.test.ts` (or the nearest existing web-lib test); appointment producers covered by an integration assertion in Task B10 if no unit seam exists.

**Interfaces:**
- Consumes: `publishDomainEvent`, `makeEvent` (`@savvy/orchestrator`); `DrizzleOrchestratorStore` (`@savvy/db`).
- Produces: `message.inbound { customerId?, leadId?, channel, isOptOut }` (idempotencyKey `` `message.inbound:${messageSid}` ``) from the inbound handler; `contact.opted_out { channel, reason }` from the STOP branch (idempotencyKey `` `contact.opted_out:sms:${fromPhone}` ``) — this fulfills the `contact-suppression.ts:60-63` note that the caller emits `contact.opted_out`; `appointment.set` on booking; `appointment.no_show` on the no_show status change.

- [ ] **Step 1: RED** — in `inbound-sms.test.ts`, inject an `OrchestratorStore` seam into `handleInboundSms` (add an optional `deps.publish` or `deps.store` param defaulting to `new DrizzleOrchestratorStore()`), assert a `message.inbound` audit with the MessageSid key and `isOptOut:true` on "STOP".
- [ ] **Step 2:** Run the web-lib test → FAIL.
- [ ] **Step 3:** Implement the injectable store seam + publish `message.inbound` in the inbound-log path; publish `contact.opted_out` in the route's STOP branch right after the existing `suppress(...)` (`route.ts:41`). In `scheduling-actions.ts`/`booking-action.ts`, publish `appointment.set` next to each `inngest.send({name:"appointment/booked"})` producer and `appointment.no_show` in `markStatusAction` when status is `no_show`. Use idempotency keys `` `appointment.set:${appointmentId}` `` / `` `appointment.no_show:${appointmentId}` ``. Fail-soft wrap every publish.
- [ ] **Step 4:** Run `pnpm --filter web test -- inbound-sms` (or the applicable filter) + `pnpm --filter web typecheck` → PASS.
- [ ] **Step 5: Commit** `feat(web): bridge message.inbound, contact.opted_out, appointment.set/no_show`.

---

## Task B10: Slice B gate — bridge end-to-end + PR

**Files:**
- Create: `packages/db/src/command-center/bridge-e2e.test.ts` (real Postgres round-trip)
- No production code unless the gate surfaces a defect.

**Interfaces:**
- Consumes: `publishDomainEvent` + `DrizzleOrchestratorStore` (write), `loadEventsForDay` + `projectDay` (`db/command-center/read.ts` + `command-center`), `upsertDailyMetrics`/`getDailyMetrics`, `recordException`/`listQueue`.

- [ ] **Step 1: End-to-end bridge test (RED→GREEN):** seed a tenant; `publishDomainEvent(store, makeEvent({type:"lead.first_touch", ... latencySeconds: 30, occurredAt: <today Denver>}))`; then `loadEventsForDay(tenantId, businessDate)` → `projectDay` → assert the speed metric reflects one within-SLA first touch → `upsertDailyMetrics`/`getDailyMetrics` round-trips. Then publish an event that escalates (or call `recordException` with a `compliance-block`) and assert `listQueue` contains the open item. This proves the bridge end-to-end: event → `orchestrator_event` → read model → `daily_metrics` + `exception_queue`. Mirror the seeding/teardown in `db/src/orchestrator/integration.test.ts:11-20` and `command-center/store.test.ts`.

- [ ] **Step 2: Full gate.** From the repo root:

```bash
pnpm typecheck && pnpm lint && pnpm -r test
```

Expected: all green. Investigate and fix any failure before proceeding (do not skip/retry-around a red test).

- [ ] **Step 3: Push + PR.**

```bash
git push -u origin day3-sliceB
gh pr create --title "Day 3 Slice B — the bridge + durable escalations" --body "<summary of the 6 event types wired, the 3 escalations, and the read-model round-trip; note migs unchanged; note the concurrent task_1ffe88ff overlap on the same agent files so this + that PR must be merged sequentially with a full typecheck on merged main>"
```

- [ ] **Step 4:** Report the PR URL + CI status to Brett and STOP for his explicit per-PR merge word. Do not merge.

---

## Self-Review (completed during authoring)

- **Spec coverage:** bridge (`publishDomainEvent`, B2) ✓; all A.1 emission points (first_touch/assigned/appointment.set/no_show/reminder.sent/drip.step.sent/message.inbound/contact.opted_out/call.missed vocabulary) ✓ (call.missed vocabulary added in B1; its *producer* is Slice C's missed-call webhook, so no wiring task here — intentional); durable speed-to-lead-breach (B6) ✓; assignment-failure (B5) ✓; compliance-block (B5/B8) ✓; escalations → exception_queue (B3 projector) ✓; Command Center speed panel populates (B4 + B10 e2e) ✓.
- **Placeholder scan:** none — every code step carries real code or exact `path:line` + signature references.
- **Type consistency:** `EscalationRecord`/`EscalationHit`/`QueueItem`/`GuardedSmsResult` field names are pinned to recon `path:line`; each implement step says to verify against the real shape before finalizing.
- **Deferred to Slice C/D (intentional, not gaps):** the `call.missed` *producer* (missed-call webhook), no-show reschedule *message*, bilingual templates, and the full 11-check §8 acceptance test.
- **Concurrency risk:** `task_1ffe88ff` edits the same agent SMS senders. Worktree isolates files; B10's PR body flags sequential merge + full typecheck on merged main.
