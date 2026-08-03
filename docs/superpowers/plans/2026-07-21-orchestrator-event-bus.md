# Orchestrator — Event Bus & Trigger Schema (Day 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone, typed, validated event bus (`packages/orchestrator`) with a data-driven trigger + escalation registry and a dispatch engine (idempotency, audit log, dead-letter, escalation sink), then back it with a Drizzle store and 3 real publishers.

**Architecture:** A pure-TS core (`packages/orchestrator`) owns the `DomainEvent` schema, the trigger/escalation registries, and a synchronous dispatch engine that runs subscribers in isolation and chains their emitted events. Persistence sits behind an `OrchestratorStore` interface: an in-memory impl drives tests; a Drizzle impl (in `packages/db`, so migrations stay in one place) backs prod with two RLS tables + a unique dedupe index. Day-1 transport is in-process synchronous — the durable transport is a later swap the interface already allows.

**Tech Stack:** TypeScript (strict, `noUncheckedIndexedAccess`), zod ^3.23, Vitest, Drizzle ORM ^0.36 + Postgres, pnpm + Turborepo workspace.

## Global Constraints

- **Standalone, NOT Inngest** — this is a deliberate separate bus per Brett's call. Do not route through `packages/agents`' Inngest client. (Overlap with the existing Inngest bus + Today decision queue is a known, accepted trade-off.)
- **Tenant isolation on every table and query** — every event carries `tenantId`; both Drizzle tables carry `tenant_id`, the `tenantIsolation()` RLS policy, and are written through `withTenant`.
- **New package conventions** (copy from `packages/core`): `name: "@savvy/orchestrator"`, `"type": "module"`, `main`/`types` → `./src/index.ts`, `tsconfig` extends `../../tsconfig.base.json`, scripts `lint`/`typecheck`/`test`, deps use `workspace:*`, `zod: "^3.23.0"`, `typescript: "^5.6.0"`, `vitest: "^2.1.0"`.
- **`noUncheckedIndexedAccess` is ON** — array/record index access is `T | undefined`; guard it.
- **TDD** — every task writes the failing test first, watches it fail, then implements. Small commits.
- **Migrations** — the next number is `0118`; generate with `pnpm db:generate`, never hand-number.
- **Tests run** from repo root: `pnpm test` (= `vitest run --no-file-parallelism`) or per-package `pnpm --filter @savvy/orchestrator test`.
- **Commit co-author** line: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- **Merges require Brett's explicit per-PR word** — the slice-gate tasks stop at "PR opened + CI green" and hand off.

---

## File Structure

**Slice 1 — `packages/orchestrator` (pure core):**
- `package.json`, `tsconfig.json` — package scaffold.
- `src/events.ts` — `DomainEvent` envelope, `EventType` union, typed payload map, per-type zod schemas, `validateEvent()`, `makeEvent()` helper.
- `src/triggers.ts` — `Subscription` type, stub agent actions, `TRIGGERS` registry, `subscriptionsFor()`.
- `src/escalations.ts` — `EscalationRule` type, `ESCALATIONS` registry, `evaluateEscalations()`.
- `src/store.ts` — `OrchestratorStore` interface + `AuditRecord`/`EscalationRecord` types + `InMemoryStore`.
- `src/engine.ts` — `Orchestrator` dispatch engine (`publish`).
- `src/index.ts` — barrel export.
- `src/*.test.ts` — colocated unit tests + `acceptance.test.ts`.

**Slice 2 — persistence + publishers:**
- `packages/db/src/schema/orchestrator.ts` — `orchestratorEvent` + `orchestratorEscalation` tables (RLS).
- `packages/db/drizzle/0118_*.sql` — generated migration.
- `packages/db/src/orchestrator/store.ts` — `DrizzleOrchestratorStore` (implements the interface from `@savvy/orchestrator`).
- `packages/db/src/orchestrator/store.test.ts` — integration test against local Postgres.
- `packages/orchestrator/src/publishers.ts` — `publishLeadCreated`, `publishContractSigned`, `publishPaymentReceived` thin helpers.
- `packages/orchestrator/src/publishers.test.ts` — publisher unit tests.
- `packages/db/src/orchestrator/integration.test.ts` — publisher → engine → Drizzle store round-trip.
- `packages/db/src/index.ts` — export the Drizzle store + schema.

---

# SLICE 1 — Core event bus (pure TS, no DB)

## Task 1: Package scaffold + event schema & validation

**Files:**
- Create: `packages/orchestrator/package.json`
- Create: `packages/orchestrator/tsconfig.json`
- Create: `packages/orchestrator/src/events.ts`
- Create: `packages/orchestrator/src/index.ts`
- Test: `packages/orchestrator/src/events.test.ts`

**Interfaces:**
- Produces:
  - `type EventType` — union of the catalog string literals.
  - `type Tool = "savvy" | "canvass" | "supplement-iq" | "bloomcam" | "bloom-materials" | "system"`.
  - `interface DomainEvent<T extends EventType = EventType> { id: string; type: T; version: number; occurredAt: string; source: Tool; correlationId: string; idempotencyKey: string; actor?: string; tenantId: string; payload: PayloadFor<T>; }`
  - `type PayloadFor<T extends EventType>` — maps each event type to its payload shape.
  - `function validateEvent(e: unknown): { ok: true; event: DomainEvent } | { ok: false; reason: string }`
  - `function makeEvent<T extends EventType>(input: { type: T; source: Tool; tenantId: string; correlationId: string; idempotencyKey: string; payload: PayloadFor<T>; actor?: string; id?: string; occurredAt?: string; version?: number }): DomainEvent<T>`

- [ ] **Step 1: Scaffold the package**

Create `packages/orchestrator/package.json`:

```json
{
  "name": "@savvy/orchestrator",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "scripts": {
    "lint": "eslint .",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": { "zod": "^3.23.0" },
  "devDependencies": { "typescript": "^5.6.0", "vitest": "^2.1.0" }
}
```

Create `packages/orchestrator/tsconfig.json`:

```json
{ "extends": "../../tsconfig.base.json", "include": ["src"] }
```

Then run `pnpm install` from the repo root so the workspace links `@savvy/orchestrator`.

- [ ] **Step 2: Write the failing test**

Create `packages/orchestrator/src/events.test.ts`:

```ts
import { it, expect } from "vitest";
import { validateEvent, makeEvent } from "./events";

const base = {
  type: "lead.created" as const,
  source: "savvy" as const,
  tenantId: "11111111-1111-1111-1111-111111111111",
  correlationId: "corr-1",
  idempotencyKey: "lead.created:lead-1",
  payload: { leadId: "lead-1", customerId: "cust-1" },
};

it("makeEvent fills id/occurredAt/version and preserves fields", () => {
  const e = makeEvent(base);
  expect(e.id).toMatch(/./);
  expect(e.version).toBe(1);
  expect(typeof e.occurredAt).toBe("string");
  expect(e.type).toBe("lead.created");
  expect(e.payload).toEqual({ leadId: "lead-1", customerId: "cust-1" });
});

it("validateEvent accepts a well-formed event", () => {
  const r = validateEvent(makeEvent(base));
  expect(r.ok).toBe(true);
});

it("validateEvent rejects an unknown type", () => {
  const bad = { ...makeEvent(base), type: "lead.exploded" };
  const r = validateEvent(bad);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.reason).toMatch(/type/i);
});

it("validateEvent rejects a missing envelope field", () => {
  const e = makeEvent(base) as Record<string, unknown>;
  delete e.tenantId;
  const r = validateEvent(e);
  expect(r.ok).toBe(false);
});

it("validateEvent rejects a payload that does not match its type", () => {
  const e = makeEvent(base) as Record<string, unknown>;
  e.payload = { wrong: true };
  const r = validateEvent(e);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.reason).toMatch(/payload/i);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @savvy/orchestrator test`
Expected: FAIL — `Cannot find module './events'`.

- [ ] **Step 4: Implement `events.ts`**

Create `packages/orchestrator/src/events.ts`:

```ts
import { z } from "zod";

// The tools that can originate an event. `system` = the orchestrator itself
// (synthesized events like a handler failure).
export type Tool =
  | "savvy" | "canvass"
  | "supplement-iq" | "bloomcam" | "bloom-materials" | "system";

const TOOL = z.enum([
  "savvy", "canvass",
  "supplement-iq", "bloomcam", "bloom-materials", "system",
]);

// Per-type payload schemas. Add a new event by adding one entry here; the
// EventType union, PayloadFor map, and validateEvent all derive from it.
const payloadSchemas = {
  "lead.created": z.object({ leadId: z.string(), customerId: z.string() }),
  "lead.first_touch": z.object({ leadId: z.string(), channel: z.string() }),
  "lead.qualified": z.object({ leadId: z.string(), score: z.number() }),
  "lead.assigned": z.object({ leadId: z.string(), userId: z.string() }),
  "contract.signed": z.object({ jobId: z.string(), customerId: z.string() }),
  "material.order.created": z.object({ jobId: z.string() }),
  "job.approved": z.object({ jobId: z.string() }),
  "estimate.approved": z.object({ estimateId: z.string(), jobId: z.string(), marginPct: z.number() }),
  "job.completed": z.object({ jobId: z.string() }),
  "invoice.created": z.object({ invoiceId: z.string(), jobId: z.string() }),
  "review.requested": z.object({ jobId: z.string(), customerId: z.string() }),
  "payment.received": z.object({ invoiceId: z.string(), amountCents: z.number() }),
  "invoice.past_due": z.object({ invoiceId: z.string(), daysPastDue: z.number() }),
  "supplement.approved": z.object({ supplementId: z.string(), amountCents: z.number() }),
  "review.posted": z.object({ jobId: z.string(), stars: z.number() }),
  // system-synthesized: emitted when a subscriber throws.
  "handler.failed": z.object({ ofType: z.string(), agent: z.string(), error: z.string() }),
} as const;

export type EventType = keyof typeof payloadSchemas;
export type PayloadFor<T extends EventType> = z.infer<(typeof payloadSchemas)[T]>;

export interface DomainEvent<T extends EventType = EventType> {
  id: string;
  type: T;
  version: number;
  occurredAt: string; // ISO-8601
  source: Tool;
  correlationId: string;
  idempotencyKey: string;
  actor?: string;
  tenantId: string;
  payload: PayloadFor<T>;
}

const envelope = z.object({
  id: z.string().min(1),
  type: z.string(),
  version: z.number().int().positive(),
  occurredAt: z.string().min(1),
  source: TOOL,
  correlationId: z.string().min(1),
  idempotencyKey: z.string().min(1),
  actor: z.string().optional(),
  tenantId: z.string().uuid(),
});

// uuid-ish id + timestamp without pulling a dep. crypto.randomUUID is in Node
// 18+ and the browser; both targets have it.
function newId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `evt-${Math.random().toString(36).slice(2)}`;
}

export function makeEvent<T extends EventType>(input: {
  type: T; source: Tool; tenantId: string; correlationId: string;
  idempotencyKey: string; payload: PayloadFor<T>; actor?: string;
  id?: string; occurredAt?: string; version?: number;
}): DomainEvent<T> {
  return {
    id: input.id ?? newId(),
    type: input.type,
    version: input.version ?? 1,
    occurredAt: input.occurredAt ?? new Date().toISOString(),
    source: input.source,
    correlationId: input.correlationId,
    idempotencyKey: input.idempotencyKey,
    ...(input.actor ? { actor: input.actor } : {}),
    tenantId: input.tenantId,
    payload: input.payload,
  };
}

export function validateEvent(
  e: unknown,
): { ok: true; event: DomainEvent } | { ok: false; reason: string } {
  const env = envelope.safeParse(e);
  if (!env.success) return { ok: false, reason: `envelope: ${env.error.issues[0]?.message ?? "invalid"}` };
  const type = env.data.type;
  if (!(type in payloadSchemas)) return { ok: false, reason: `unknown type "${type}"` };
  const schema = payloadSchemas[type as EventType];
  const payload = schema.safeParse((e as { payload: unknown }).payload);
  if (!payload.success) return { ok: false, reason: `payload: ${payload.error.issues[0]?.message ?? "invalid"}` };
  return { ok: true, event: e as DomainEvent };
}
```

Create `packages/orchestrator/src/index.ts`:

```ts
export * from "./events";
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @savvy/orchestrator test`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/orchestrator pnpm-lock.yaml
git commit -m "feat(orchestrator): package scaffold + DomainEvent schema & validation

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 2: Trigger registry + stub agent actions

**Files:**
- Create: `packages/orchestrator/src/triggers.ts`
- Modify: `packages/orchestrator/src/index.ts`
- Test: `packages/orchestrator/src/triggers.test.ts`

**Interfaces:**
- Consumes: `DomainEvent`, `EventType`, `makeEvent` (Task 1).
- Produces:
  - `type Agent = "orchestrator" | "comms" | "scheduling" | "finance" | "claims"`.
  - `interface ActionCtx { emit: <T extends EventType>(type: T, payload: PayloadFor<T>) => void }`
  - `type Action = (event: DomainEvent, ctx: ActionCtx) => Promise<void> | void`
  - `interface Subscription { event: EventType; agent: Agent; action: Action; silent?: boolean }`
  - `const TRIGGERS: Subscription[]`
  - `function subscriptionsFor(type: EventType): Subscription[]`

- [ ] **Step 1: Write the failing test**

Create `packages/orchestrator/src/triggers.test.ts`:

```ts
import { it, expect } from "vitest";
import { subscriptionsFor, type ActionCtx } from "./triggers";
import { makeEvent, type EventType, type PayloadFor } from "./events";

function collectEmits(type: EventType, payload: PayloadFor<EventType>) {
  const emitted: { type: EventType }[] = [];
  const ctx: ActionCtx = { emit: (t) => emitted.push({ type: t }) };
  const subs = subscriptionsFor(type);
  const ev = makeEvent({ type, source: "savvy", tenantId: "11111111-1111-1111-1111-111111111111", correlationId: "c", idempotencyKey: "k", payload } as never);
  for (const s of subs) s.action(ev, ctx);
  return { subs, emitted: emitted.map((e) => e.type) };
}

it("lead.created fans out to comms + orchestrator and emits the follow-ons", () => {
  const { subs, emitted } = collectEmits("lead.created", { leadId: "l1", customerId: "c1" });
  expect(subs.map((s) => s.agent).sort()).toEqual(["comms", "orchestrator"]);
  expect(emitted.sort()).toEqual(["lead.assigned", "lead.first_touch", "lead.qualified"]);
});

it("contract.signed emits material order + job approved", () => {
  const { emitted } = collectEmits("contract.signed", { jobId: "j1", customerId: "c1" });
  expect(emitted.sort()).toEqual(["job.approved", "material.order.created"]);
});

it("payment.received is handled silently (no follow-on)", () => {
  const { subs, emitted } = collectEmits("payment.received", { invoiceId: "i1", amountCents: 100 });
  expect(subs.every((s) => s.silent)).toBe(true);
  expect(emitted).toEqual([]);
});

it("an event with no subscribers returns []", () => {
  expect(subscriptionsFor("lead.assigned")).toEqual([]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @savvy/orchestrator test triggers`
Expected: FAIL — `Cannot find module './triggers'`.

- [ ] **Step 3: Implement `triggers.ts`**

Create `packages/orchestrator/src/triggers.ts`:

```ts
import type { DomainEvent, EventType, PayloadFor } from "./events";

export type Agent = "orchestrator" | "comms" | "scheduling" | "finance" | "claims";

export interface ActionCtx {
  emit: <T extends EventType>(type: T, payload: PayloadFor<T>) => void;
}

export type Action = (event: DomainEvent, ctx: ActionCtx) => Promise<void> | void;

export interface Subscription {
  event: EventType;
  agent: Agent;
  action: Action;
  silent?: boolean; // routine, no exception-queue interest even if a rule matches
}

// STUB agent actions — Day 1 emits the follow-on events (the choreography) but
// contains no real business logic. Real handlers land on later days.
export const TRIGGERS: Subscription[] = [
  {
    event: "lead.created", agent: "comms",
    action: (e, ctx) => {
      const p = e.payload as PayloadFor<"lead.created">;
      ctx.emit("lead.first_touch", { leadId: p.leadId, channel: "sms" });
    },
  },
  {
    event: "lead.created", agent: "orchestrator",
    action: (e, ctx) => {
      const p = e.payload as PayloadFor<"lead.created">;
      ctx.emit("lead.qualified", { leadId: p.leadId, score: 80 });
      ctx.emit("lead.assigned", { leadId: p.leadId, userId: "auto" });
    },
  },
  {
    event: "contract.signed", agent: "scheduling",
    action: (e, ctx) => {
      const p = e.payload as PayloadFor<"contract.signed">;
      ctx.emit("material.order.created", { jobId: p.jobId });
    },
  },
  {
    event: "contract.signed", agent: "orchestrator",
    action: (e, ctx) => {
      const p = e.payload as PayloadFor<"contract.signed">;
      ctx.emit("job.approved", { jobId: p.jobId });
    },
  },
  {
    // Finance guardrail. Escalation is data (see escalations.ts) — the action
    // just acknowledges; a low margin is caught by the rule, not here.
    event: "estimate.approved", agent: "finance",
    action: () => {},
  },
  {
    event: "job.completed", agent: "comms",
    action: (e, ctx) => {
      const p = e.payload as PayloadFor<"job.completed">;
      ctx.emit("review.requested", { jobId: p.jobId, customerId: "unknown" });
    },
  },
  {
    event: "job.completed", agent: "finance",
    action: (e, ctx) => {
      const p = e.payload as PayloadFor<"job.completed">;
      ctx.emit("invoice.created", { invoiceId: `inv-${p.jobId}`, jobId: p.jobId });
    },
  },
  {
    event: "payment.received", agent: "finance", silent: true,
    action: () => {}, // reconcile + close; routine, emits nothing on Day 1
  },
  {
    event: "invoice.past_due", agent: "finance",
    action: () => {}, // dunning; escalation at 90 days is a rule
  },
  {
    event: "review.posted", agent: "comms",
    action: () => {}, // referral ask or escalation (negative-review rule)
  },
];

export function subscriptionsFor(type: EventType): Subscription[] {
  return TRIGGERS.filter((s) => s.event === type);
}
```

Add to `packages/orchestrator/src/index.ts`:

```ts
export * from "./triggers";
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @savvy/orchestrator test triggers`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/orchestrator/src
git commit -m "feat(orchestrator): trigger registry with stub agent actions

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 3: Escalation registry

**Files:**
- Create: `packages/orchestrator/src/escalations.ts`
- Modify: `packages/orchestrator/src/index.ts`
- Test: `packages/orchestrator/src/escalations.test.ts`

**Interfaces:**
- Consumes: `DomainEvent`, `EventType`, `PayloadFor` (Task 1).
- Produces:
  - `type Severity = "low" | "medium" | "high"`
  - `interface EscalationRule { id: string; event: EventType; severity: Severity; notify: string[]; when: (e: DomainEvent) => boolean; reason: (e: DomainEvent) => string }`
  - `const ESCALATIONS: EscalationRule[]`
  - `interface EscalationHit { ruleId: string; severity: Severity; reason: string; notify: string[] }`
  - `function evaluateEscalations(e: DomainEvent): EscalationHit[]`

- [ ] **Step 1: Write the failing test**

Create `packages/orchestrator/src/escalations.test.ts`:

```ts
import { it, expect } from "vitest";
import { evaluateEscalations } from "./escalations";
import { makeEvent } from "./events";

const T = "11111111-1111-1111-1111-111111111111";
const mk = (type: never, payload: never) =>
  makeEvent({ type, source: "savvy", tenantId: T, correlationId: "c", idempotencyKey: "k", payload });

it("estimate.approved under 25% margin fires low-margin (high)", () => {
  const hits = evaluateEscalations(mk("estimate.approved" as never, { estimateId: "e1", jobId: "j1", marginPct: 18 } as never));
  expect(hits.map((h) => h.ruleId)).toContain("low-margin");
  expect(hits.find((h) => h.ruleId === "low-margin")?.severity).toBe("high");
});

it("estimate.approved at healthy margin fires nothing", () => {
  const hits = evaluateEscalations(mk("estimate.approved" as never, { estimateId: "e1", jobId: "j1", marginPct: 40 } as never));
  expect(hits).toEqual([]);
});

it("invoice.past_due at 92 days fires collections-90", () => {
  const hits = evaluateEscalations(mk("invoice.past_due" as never, { invoiceId: "i1", daysPastDue: 92 } as never));
  expect(hits.map((h) => h.ruleId)).toContain("collections-90");
});

it("invoice.past_due at 30 days fires nothing", () => {
  expect(evaluateEscalations(mk("invoice.past_due" as never, { invoiceId: "i1", daysPastDue: 30 } as never))).toEqual([]);
});

it("review.posted at 2 stars fires negative-review", () => {
  const hits = evaluateEscalations(mk("review.posted" as never, { jobId: "j1", stars: 2 } as never));
  expect(hits.map((h) => h.ruleId)).toContain("negative-review");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @savvy/orchestrator test escalations`
Expected: FAIL — `Cannot find module './escalations'`.

- [ ] **Step 3: Implement `escalations.ts`**

Create `packages/orchestrator/src/escalations.ts`:

```ts
import type { DomainEvent, EventType, PayloadFor } from "./events";

export type Severity = "low" | "medium" | "high";

export interface EscalationRule {
  id: string;
  event: EventType;
  severity: Severity;
  notify: string[];
  when: (e: DomainEvent) => boolean;
  reason: (e: DomainEvent) => string;
}

export interface EscalationHit {
  ruleId: string;
  severity: Severity;
  reason: string;
  notify: string[];
}

// Rules are DATA — tune a threshold or add a rule without touching the engine.
export const ESCALATIONS: EscalationRule[] = [
  {
    id: "low-margin", event: "estimate.approved", severity: "high",
    notify: ["sales-manager", "arrington"],
    when: (e) => (e.payload as PayloadFor<"estimate.approved">).marginPct < 25,
    reason: (e) => `estimate margin ${(e.payload as PayloadFor<"estimate.approved">).marginPct}% below 25% floor`,
  },
  {
    id: "collections-90", event: "invoice.past_due", severity: "high",
    notify: ["admin", "arrington"],
    when: (e) => (e.payload as PayloadFor<"invoice.past_due">).daysPastDue >= 90,
    reason: (e) => `invoice ${(e.payload as PayloadFor<"invoice.past_due">).daysPastDue} days past due`,
  },
  {
    id: "negative-review", event: "review.posted", severity: "high",
    notify: ["manager"],
    when: (e) => (e.payload as PayloadFor<"review.posted">).stars <= 3,
    reason: (e) => `${(e.payload as PayloadFor<"review.posted">).stars}-star review posted`,
  },
  {
    id: "supplement-denied", event: "supplement.approved", severity: "medium",
    notify: ["claims"],
    when: (e) => (e.payload as PayloadFor<"supplement.approved">).amountCents <= 0,
    reason: () => `supplement denied / zero amount`,
  },
  {
    id: "handler-failure", event: "handler.failed", severity: "high",
    notify: ["eng-oncall"],
    when: () => true,
    reason: (e) => {
      const p = e.payload as PayloadFor<"handler.failed">;
      return `${p.agent} handler for ${p.ofType} threw: ${p.error}`;
    },
  },
];

export function evaluateEscalations(e: DomainEvent): EscalationHit[] {
  return ESCALATIONS
    .filter((r) => r.event === e.type && r.when(e))
    .map((r) => ({ ruleId: r.id, severity: r.severity, reason: r.reason(e), notify: r.notify }));
}
```

> Note: `speed-to-lead-breach` from the spec is time-window based (no first_touch within N minutes of lead.created). That needs a scheduled sweep the Day-1 synchronous engine can't express, so it is **deliberately deferred** to the durable-transport day. Every other seed rule is implemented here.

Add to `packages/orchestrator/src/index.ts`:

```ts
export * from "./escalations";
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @savvy/orchestrator test escalations`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/orchestrator/src
git commit -m "feat(orchestrator): escalation rule registry (data-driven)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 4: Store interface + in-memory implementation

**Files:**
- Create: `packages/orchestrator/src/store.ts`
- Modify: `packages/orchestrator/src/index.ts`
- Test: `packages/orchestrator/src/store.test.ts`

**Interfaces:**
- Consumes: `DomainEvent` (Task 1), `EscalationHit` (Task 3).
- Produces:
  - `interface AuditRecord { event: DomainEvent; agent: string; outcome: "handled" | "dead_letter" | "received"; emitted: string[]; error?: string }`
  - `interface EscalationRecord extends EscalationHit { tenantId: string; correlationId: string; eventId: string; eventType: string }`
  - `interface OrchestratorStore { insertEventIfNew(e: DomainEvent): Promise<boolean>; appendAudit(r: AuditRecord): Promise<void>; recordEscalation(r: EscalationRecord): Promise<void>; traceByCorrelation(tenantId: string, correlationId: string): Promise<AuditRecord[]>; listEscalations(tenantId: string): Promise<EscalationRecord[]> }`
  - `class InMemoryStore implements OrchestratorStore` (with public `audits` / `escalations` arrays for assertions).

- [ ] **Step 1: Write the failing test**

Create `packages/orchestrator/src/store.test.ts`:

```ts
import { it, expect } from "vitest";
import { InMemoryStore } from "./store";
import { makeEvent } from "./events";

const T = "11111111-1111-1111-1111-111111111111";
const ev = makeEvent({ type: "lead.created", source: "savvy", tenantId: T, correlationId: "corr-1", idempotencyKey: "idem-1", payload: { leadId: "l1", customerId: "c1" } });

it("insertEventIfNew returns true first time, false on a repeat idempotencyKey", async () => {
  const s = new InMemoryStore();
  expect(await s.insertEventIfNew(ev)).toBe(true);
  expect(await s.insertEventIfNew(ev)).toBe(false);
});

it("dedupe is scoped per tenant", async () => {
  const s = new InMemoryStore();
  await s.insertEventIfNew(ev);
  const other = { ...ev, tenantId: "22222222-2222-2222-2222-222222222222" };
  expect(await s.insertEventIfNew(other)).toBe(true);
});

it("traceByCorrelation returns appended audits in order for that correlation only", async () => {
  const s = new InMemoryStore();
  await s.appendAudit({ event: ev, agent: "comms", outcome: "handled", emitted: ["lead.first_touch"] });
  await s.appendAudit({ event: { ...ev, correlationId: "other" }, agent: "x", outcome: "handled", emitted: [] });
  const trace = await s.traceByCorrelation(T, "corr-1");
  expect(trace).toHaveLength(1);
  expect(trace[0]?.agent).toBe("comms");
});

it("listEscalations returns recorded escalations for the tenant", async () => {
  const s = new InMemoryStore();
  await s.recordEscalation({ tenantId: T, correlationId: "corr-1", eventId: ev.id, eventType: "estimate.approved", ruleId: "low-margin", severity: "high", reason: "18% margin", notify: ["arrington"] });
  const list = await s.listEscalations(T);
  expect(list).toHaveLength(1);
  expect(list[0]?.ruleId).toBe("low-margin");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @savvy/orchestrator test store`
Expected: FAIL — `Cannot find module './store'`.

- [ ] **Step 3: Implement `store.ts`**

Create `packages/orchestrator/src/store.ts`:

```ts
import type { DomainEvent } from "./events";
import type { EscalationHit } from "./escalations";

export interface AuditRecord {
  event: DomainEvent;
  agent: string;
  outcome: "handled" | "dead_letter" | "received";
  emitted: string[];
  error?: string;
}

export interface EscalationRecord extends EscalationHit {
  tenantId: string;
  correlationId: string;
  eventId: string;
  eventType: string;
}

export interface OrchestratorStore {
  /** Append-only dedupe: true if this (tenant, idempotencyKey) is new, false if seen. */
  insertEventIfNew(e: DomainEvent): Promise<boolean>;
  appendAudit(r: AuditRecord): Promise<void>;
  recordEscalation(r: EscalationRecord): Promise<void>;
  traceByCorrelation(tenantId: string, correlationId: string): Promise<AuditRecord[]>;
  listEscalations(tenantId: string): Promise<EscalationRecord[]>;
}

// In-memory backing for tests + the acceptance harness. The public arrays let
// tests assert on the recorded trace directly.
export class InMemoryStore implements OrchestratorStore {
  readonly audits: AuditRecord[] = [];
  readonly escalations: EscalationRecord[] = [];
  private seen = new Set<string>();

  private key(e: DomainEvent): string {
    return `${e.tenantId}:${e.idempotencyKey}`;
  }

  async insertEventIfNew(e: DomainEvent): Promise<boolean> {
    const k = this.key(e);
    if (this.seen.has(k)) return false;
    this.seen.add(k);
    return true;
  }

  async appendAudit(r: AuditRecord): Promise<void> {
    this.audits.push(r);
  }

  async recordEscalation(r: EscalationRecord): Promise<void> {
    this.escalations.push(r);
  }

  async traceByCorrelation(tenantId: string, correlationId: string): Promise<AuditRecord[]> {
    return this.audits.filter((a) => a.event.tenantId === tenantId && a.event.correlationId === correlationId);
  }

  async listEscalations(tenantId: string): Promise<EscalationRecord[]> {
    return this.escalations.filter((e) => e.tenantId === tenantId);
  }
}
```

Add to `packages/orchestrator/src/index.ts`:

```ts
export * from "./store";
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @savvy/orchestrator test store`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/orchestrator/src
git commit -m "feat(orchestrator): store interface + in-memory impl

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 5: Dispatch engine

**Files:**
- Create: `packages/orchestrator/src/engine.ts`
- Modify: `packages/orchestrator/src/index.ts`
- Test: `packages/orchestrator/src/engine.test.ts`

**Interfaces:**
- Consumes: `DomainEvent`, `validateEvent`, `makeEvent`, `EventType`, `PayloadFor` (Task 1); `subscriptionsFor`, `ActionCtx` (Task 2); `evaluateEscalations` (Task 3); `OrchestratorStore`, `AuditRecord`, `EscalationRecord` (Task 4).
- Produces:
  - `interface OrchestratorOpts { store: OrchestratorStore; triggers?: (t: EventType) => Subscription[]; escalate?: (e: DomainEvent) => EscalationHit[] }`
  - `class Orchestrator { constructor(opts: OrchestratorOpts); publish(e: DomainEvent): Promise<void> }`

  Behavior of `publish`: validate (bad → dead-letter audit, stop); dedupe via `insertEventIfNew` (seen → stop); append a `received` audit; for each subscription run the action in a try/catch collecting `emit`s; on success append a `handled` audit and queue the emitted events; on throw append a `dead_letter` audit **and** synthesize+enqueue a `handler.failed` event; after subscribers, evaluate escalations and `recordEscalation` each hit; process the queue FIFO (per-correlation order preserved because processing is synchronous single-threaded).

- [ ] **Step 1: Write the failing test**

Create `packages/orchestrator/src/engine.test.ts`:

```ts
import { it, expect } from "vitest";
import { Orchestrator } from "./engine";
import { InMemoryStore } from "./store";
import { makeEvent, type EventType } from "./events";
import type { Subscription } from "./triggers";

const T = "11111111-1111-1111-1111-111111111111";
const lead = () => makeEvent({ type: "lead.created", source: "savvy", tenantId: T, correlationId: "corr-1", idempotencyKey: "idem-1", payload: { leadId: "l1", customerId: "c1" } });

it("chains emitted events: lead.created produces first_touch/qualified/assigned", async () => {
  const store = new InMemoryStore();
  const o = new Orchestrator({ store });
  await o.publish(lead());
  const seen = store.audits.map((a) => a.event.type);
  expect(seen).toContain("lead.created");
  expect(seen).toContain("lead.first_touch");
  expect(seen).toContain("lead.qualified");
  expect(seen).toContain("lead.assigned");
});

it("a duplicate idempotencyKey is not processed twice", async () => {
  const store = new InMemoryStore();
  const o = new Orchestrator({ store });
  await o.publish(lead());
  const countAfterFirst = store.audits.filter((a) => a.event.type === "lead.created").length;
  await o.publish(lead()); // same idem key
  const countAfterSecond = store.audits.filter((a) => a.event.type === "lead.created").length;
  expect(countAfterFirst).toBe(countAfterSecond);
});

it("an invalid event is dead-lettered, not processed", async () => {
  const store = new InMemoryStore();
  const o = new Orchestrator({ store });
  const bad = { ...lead(), payload: { nope: true } } as never;
  await o.publish(bad);
  expect(store.audits.some((a) => a.outcome === "dead_letter")).toBe(true);
});

it("an escalation rule records to the exception queue", async () => {
  const store = new InMemoryStore();
  const o = new Orchestrator({ store });
  await o.publish(makeEvent({ type: "estimate.approved", source: "savvy", tenantId: T, correlationId: "corr-2", idempotencyKey: "idem-est", payload: { estimateId: "e1", jobId: "j1", marginPct: 18 } }));
  const q = await store.listEscalations(T);
  expect(q.map((e) => e.ruleId)).toContain("low-margin");
});

it("a throwing subscriber is isolated: dead-letter + handler.failed, siblings still run", async () => {
  const store = new InMemoryStore();
  const throwing: Subscription = { event: "lead.created", agent: "comms", action: () => { throw new Error("boom"); } };
  const ok: Subscription = { event: "lead.created", agent: "orchestrator", action: (_e, ctx) => ctx.emit("lead.qualified", { leadId: "l1", score: 50 }) };
  const triggers = (t: EventType) => (t === "lead.created" ? [throwing, ok] : []);
  const o = new Orchestrator({ store, triggers });
  await o.publish(lead());
  expect(store.audits.some((a) => a.outcome === "dead_letter" && a.agent === "comms")).toBe(true);
  expect(store.audits.some((a) => a.event.type === "lead.qualified")).toBe(true); // sibling ran
  const q = await store.listEscalations(T);
  expect(q.map((e) => e.ruleId)).toContain("handler-failure");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @savvy/orchestrator test engine`
Expected: FAIL — `Cannot find module './engine'`.

- [ ] **Step 3: Implement `engine.ts`**

Create `packages/orchestrator/src/engine.ts`:

```ts
import { validateEvent, makeEvent, type DomainEvent, type EventType, type PayloadFor } from "./events";
import { subscriptionsFor, type Subscription, type ActionCtx } from "./triggers";
import { evaluateEscalations, type EscalationHit } from "./escalations";
import type { OrchestratorStore } from "./store";

export interface OrchestratorOpts {
  store: OrchestratorStore;
  triggers?: (t: EventType) => Subscription[];
  escalate?: (e: DomainEvent) => EscalationHit[];
}

// Synchronous in-process dispatch. A single FIFO queue drained one event at a
// time keeps per-correlation ordering (an event's children are enqueued behind
// whatever is already queued, and nothing runs concurrently).
export class Orchestrator {
  private readonly store: OrchestratorStore;
  private readonly triggers: (t: EventType) => Subscription[];
  private readonly escalate: (e: DomainEvent) => EscalationHit[];

  constructor(opts: OrchestratorOpts) {
    this.store = opts.store;
    this.triggers = opts.triggers ?? subscriptionsFor;
    this.escalate = opts.escalate ?? evaluateEscalations;
  }

  async publish(input: DomainEvent): Promise<void> {
    const queue: DomainEvent[] = [input];
    while (queue.length > 0) {
      const event = queue.shift()!;
      await this.process(event, queue);
    }
  }

  private async process(event: DomainEvent, queue: DomainEvent[]): Promise<void> {
    // 1. Validate — a malformed event never enters the pipeline.
    const v = validateEvent(event);
    if (!v.ok) {
      await this.store.appendAudit({ event, agent: "system", outcome: "dead_letter", emitted: [], error: v.reason });
      return;
    }

    // 2. Dedupe on (tenant, idempotencyKey).
    const isNew = await this.store.insertEventIfNew(event);
    if (!isNew) return;

    // 3. Record receipt.
    await this.store.appendAudit({ event, agent: "system", outcome: "received", emitted: [] });

    // 4. Run each subscriber in isolation; collect its emits.
    for (const sub of this.triggers(event.type)) {
      const emitted: DomainEvent[] = [];
      const ctx: ActionCtx = {
        emit: <U extends EventType>(type: U, payload: PayloadFor<U>) =>
          emitted.push(makeEvent({
            type, payload, source: "system", tenantId: event.tenantId,
            correlationId: event.correlationId,
            idempotencyKey: `${event.idempotencyKey}>${type}`,
          })),
      };
      try {
        await sub.action(event, ctx);
        await this.store.appendAudit({ event, agent: sub.agent, outcome: "handled", emitted: emitted.map((e) => e.type) });
        queue.push(...emitted);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await this.store.appendAudit({ event, agent: sub.agent, outcome: "dead_letter", emitted: [], error: message });
        queue.push(makeEvent({
          type: "handler.failed",
          payload: { ofType: event.type, agent: sub.agent, error: message },
          source: "system", tenantId: event.tenantId,
          correlationId: event.correlationId,
          idempotencyKey: `${event.idempotencyKey}>fail>${sub.agent}`,
        }));
      }
    }

    // 5. Escalations are evaluated against the event and sunk to the queue.
    for (const hit of this.escalate(event)) {
      await this.store.recordEscalation({
        ...hit, tenantId: event.tenantId, correlationId: event.correlationId,
        eventId: event.id, eventType: event.type,
      });
    }
  }
}
```

Add to `packages/orchestrator/src/index.ts`:

```ts
export * from "./engine";
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @savvy/orchestrator test engine`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/orchestrator/src
git commit -m "feat(orchestrator): synchronous dispatch engine (dedupe/audit/dead-letter/escalation/chaining)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 6: §8 acceptance test + Slice 1 gate

**Files:**
- Create: `packages/orchestrator/src/acceptance.test.ts`

**Interfaces:**
- Consumes: `Orchestrator` (Task 5), `InMemoryStore` (Task 4), `makeEvent` (Task 1).

- [ ] **Step 1: Write the acceptance test (§8, all 8 steps)**

Create `packages/orchestrator/src/acceptance.test.ts`:

```ts
import { it, expect } from "vitest";
import { Orchestrator } from "./engine";
import { InMemoryStore } from "./store";
import { makeEvent, type EventType, type PayloadFor } from "./events";

const T = "11111111-1111-1111-1111-111111111111";
function fire<Tp extends EventType>(o: Orchestrator, type: Tp, correlationId: string, idem: string, payload: PayloadFor<Tp>) {
  return o.publish(makeEvent({ type, source: "savvy", tenantId: T, correlationId, idempotencyKey: idem, payload }));
}

it("§8 acceptance: a full job lifecycle chains, escalates, dedupes, and isolates failures", async () => {
  const store = new InMemoryStore();
  const o = new Orchestrator({ store });

  // (1) lead.created → first_touch + qualified + assigned
  await fire(o, "lead.created", "job-1", "lc-1", { leadId: "l1", customerId: "c1" });
  // (2) contract.signed → material.order.created + job.approved
  await fire(o, "contract.signed", "job-1", "cs-1", { jobId: "j1", customerId: "c1" });
  // (3) estimate.approved @ 18% → low-margin escalation
  await fire(o, "estimate.approved", "job-1", "ea-1", { estimateId: "e1", jobId: "j1", marginPct: 18 });
  // (4) job.completed → invoice.created + review.requested
  await fire(o, "job.completed", "job-1", "jc-1", { jobId: "j1" });
  // (5) payment.received → closes silently, no escalation
  await fire(o, "payment.received", "job-1", "pr-1", { invoiceId: "i1", amountCents: 926722 });
  // (6) invoice.past_due @ 92 → collections-90
  await fire(o, "invoice.past_due", "job-2", "pd-1", { invoiceId: "i2", daysPastDue: 92 });
  // (7) re-publish step 1 with the SAME idempotencyKey → no double processing
  const before = store.audits.length;
  await fire(o, "lead.created", "job-1", "lc-1", { leadId: "l1", customerId: "c1" });
  expect(store.audits.length).toBe(before);

  const types = store.audits.map((a) => `${a.event.type}:${a.outcome}`);
  expect(types).toContain("lead.first_touch:handled");
  expect(types).toContain("material.order.created:handled");
  expect(types).toContain("job.approved:handled");
  expect(types).toContain("invoice.created:handled");
  expect(types).toContain("review.requested:handled");

  const queue = await store.listEscalations(T);
  const ruleIds = queue.map((e) => e.ruleId);
  expect(ruleIds).toContain("low-margin");
  expect(ruleIds).toContain("collections-90");
  expect(ruleIds).not.toContain("negative-review"); // no bad review fired

  // (8) a throwing handler dead-letters + raises handler-failure, siblings unaffected
  const failStore = new InMemoryStore();
  const failing = new Orchestrator({
    store: failStore,
    triggers: (t) => (t === "review.posted"
      ? [
          { event: "review.posted", agent: "comms", action: () => { throw new Error("notify failed"); } },
          { event: "review.posted", agent: "orchestrator", action: (_e, ctx) => ctx.emit("review.requested", { jobId: "j9", customerId: "c9" }) },
        ]
      : []),
  });
  await fire(failing, "review.posted", "job-9", "rp-1", { jobId: "j9", stars: 2 });
  expect(failStore.audits.some((a) => a.outcome === "dead_letter" && a.agent === "comms")).toBe(true);
  expect(failStore.audits.some((a) => a.event.type === "review.requested")).toBe(true);
  const fq = await failStore.listEscalations(T);
  expect(fq.map((e) => e.ruleId)).toContain("handler-failure");
  expect(fq.map((e) => e.ruleId)).toContain("negative-review");

  // Human-readable trace dump (the spec asks the acceptance test to print one).
  const trace = await store.traceByCorrelation(T, "job-1");
  // eslint-disable-next-line no-console
  console.log("\n=== job-1 trace ===\n" + trace.map((a) => `  ${a.event.type.padEnd(24)} ${a.agent.padEnd(13)} ${a.outcome}${a.emitted.length ? " → " + a.emitted.join(", ") : ""}`).join("\n"));
  // eslint-disable-next-line no-console
  console.log("\n=== exception queue ===\n" + queue.map((e) => `  [${e.severity}] ${e.ruleId}: ${e.reason} → ${e.notify.join(", ")}`).join("\n") + "\n");
});
```

- [ ] **Step 2: Run the acceptance test**

Run: `pnpm --filter @savvy/orchestrator test acceptance`
Expected: PASS, with the trace + exception queue printed to stdout.

- [ ] **Step 3: Full suite + typecheck + lint**

Run:
```bash
pnpm --filter @savvy/orchestrator test
pnpm --filter @savvy/orchestrator typecheck
pnpm --filter @savvy/orchestrator lint
```
Expected: all green.

- [ ] **Step 4: Commit + open PR (STOP for Brett's word before merge)**

```bash
git add packages/orchestrator/src/acceptance.test.ts
git commit -m "test(orchestrator): §8 acceptance test — full lifecycle chain + exception queue

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git push -u origin orchestrator-day1
gh pr create --title "Orchestrator Day 1 — Slice 1: standalone event bus core" \
  --body "Standalone event bus (per Brett's call). DomainEvent schema + validation, trigger + escalation registries, synchronous dispatch engine (dedupe/audit/dead-letter/escalation/chaining), in-memory store, §8 acceptance test. No DB yet — Slice 2 adds the Drizzle store + publishers.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

Then **stop and report** the PR link + CI status. Do not merge — merges need Brett's explicit per-PR word.

---

# SLICE 2 — Drizzle persistence + real publishers

## Task 7: Orchestrator schema tables + migration 0118

**Files:**
- Create: `packages/db/src/schema/orchestrator.ts`
- Modify: `packages/db/src/schema/index.ts` (or wherever schema is aggregated — check first)
- Create: `packages/db/drizzle/0118_*.sql` (generated)

**Interfaces:**
- Produces: `orchestratorEvent`, `orchestratorEscalation` Drizzle tables.

- [ ] **Step 1: Add `@savvy/orchestrator` as a db dependency**

In `packages/db/package.json`, add to `dependencies`: `"@savvy/orchestrator": "workspace:*"`, then run `pnpm install` from the repo root.

- [ ] **Step 2: Write the schema**

Create `packages/db/src/schema/orchestrator.ts`:

```ts
import { pgTable, uuid, text, integer, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { idCol, createdAt, tenantIsolation } from "./_rls";
import { tenant } from "./tenancy";

// Append-only audit log of every event the orchestrator processed. One row per
// (event, subscriber-outcome). `idempotency_key` carries a UNIQUE index scoped
// per tenant so a double-publish across instances cannot double-process — the
// DB is the real dedupe backstop behind the engine's in-memory check.
export const orchestratorEvent = pgTable("orchestrator_event", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  eventId: text("event_id").notNull(),
  eventType: text("event_type").notNull(),
  version: integer("version").notNull().default(1),
  source: text("source").notNull(),
  correlationId: text("correlation_id").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  actor: text("actor"),
  agent: text("agent").notNull(),
  outcome: text("outcome").notNull(), // received|handled|dead_letter
  emitted: jsonb("emitted").$type<string[]>().default([]).notNull(),
  error: text("error"),
  payload: jsonb("payload").$type<Record<string, unknown>>(),
  createdAt: createdAt(),
}, (t) => [
  index("orchestrator_event_corr_idx").on(t.tenantId, t.correlationId),
  // Dedupe backstop: an idempotencyKey processes at most once per tenant. The
  // "received" audit row is the one that claims the key.
  uniqueIndex("orchestrator_event_idem_uq").on(t.tenantId, t.idempotencyKey).where(
    // only the receipt row participates in dedupe
    // (a raw SQL predicate keeps handled/dead_letter rows out of the constraint)
    // eslint-disable-next-line
    // @ts-expect-error drizzle sql predicate
    undefined,
  ),
  tenantIsolation(),
]);

export const orchestratorEscalation = pgTable("orchestrator_escalation", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  ruleId: text("rule_id").notNull(),
  severity: text("severity").notNull(), // low|medium|high
  reason: text("reason").notNull(),
  notify: jsonb("notify").$type<string[]>().default([]).notNull(),
  eventId: text("event_id").notNull(),
  eventType: text("event_type").notNull(),
  correlationId: text("correlation_id").notNull(),
  status: text("status").notNull().default("open"), // open|resolved
  createdAt: createdAt(),
}, (t) => [
  index("orchestrator_escalation_open_idx").on(t.tenantId, t.status),
  tenantIsolation(),
]);
```

> **Correction for the implementer:** the `@ts-expect-error` predicate hack above is wrong — do NOT ship it. Instead scope dedupe to the receipt row with a proper partial unique index. Replace the `uniqueIndex(...)` line with:
> ```ts
> uniqueIndex("orchestrator_event_idem_uq")
>   .on(t.tenantId, t.idempotencyKey)
>   .where(sql`outcome = 'received'`),
> ```
> and add `import { sql } from "drizzle-orm";` at the top. The receipt row (`outcome='received'`) is the single row that claims an idempotencyKey; `handled`/`dead_letter` rows are unconstrained (there can be several per event, one per subscriber).

- [ ] **Step 3: Register the schema in the aggregator**

Check how `packages/db/src/client.ts` builds `schema` (grep for other `export * from "./schema/..."` or a schema barrel). Add `orchestrator` the same way the other tables are registered so drizzle-kit sees it. Run:
```bash
grep -rn "schema/ops\|schema/import-record" packages/db/src
```
Follow whatever pattern that reveals (a barrel `schema/index.ts` or a `client.ts` import map).

- [ ] **Step 4: Generate the migration**

Run: `pnpm db:generate`
Expected: creates `packages/db/drizzle/0118_*.sql` containing both tables, the RLS `ENABLE ROW LEVEL SECURITY`, the `tenant_isolation` policy, and the partial unique index. Open the file and confirm the `WHERE (outcome = 'received')` predicate is present on `orchestrator_event_idem_uq`.

- [ ] **Step 5: Apply locally + commit**

Run: `pnpm db:migrate` (or, if the shared local DB has drift, apply the 0118 SQL directly with the `postgres` superuser as done for 0116/0117).

```bash
git add packages/db/src/schema/orchestrator.ts packages/db/drizzle/0118_*.sql packages/db/package.json pnpm-lock.yaml packages/db/src
git commit -m "feat(db): orchestrator_event + orchestrator_escalation tables (RLS, dedupe index), mig 0118

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 8: DrizzleOrchestratorStore

**Files:**
- Create: `packages/db/src/orchestrator/store.ts`
- Test: `packages/db/src/orchestrator/store.test.ts`

**Interfaces:**
- Consumes: `OrchestratorStore`, `AuditRecord`, `EscalationRecord` (from `@savvy/orchestrator`); `withTenant`, `adminDb`; `orchestratorEvent`, `orchestratorEscalation` (Task 7).
- Produces: `class DrizzleOrchestratorStore implements OrchestratorStore`.

- [ ] **Step 1: Write the failing integration test**

Create `packages/db/src/orchestrator/store.test.ts` (mirrors the pattern in `acculynx-attachments-import.test.ts` — real local Postgres, per-tenant cleanup):

```ts
import { it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { makeEvent } from "@savvy/orchestrator";
import { adminDb, tenant } from "../index";
import { orchestratorEvent, orchestratorEscalation } from "../schema/orchestrator";
import { DrizzleOrchestratorStore } from "./store";

let tenantId: string;

beforeAll(async () => {
  tenantId = randomUUID();
  await adminDb.insert(tenant).values({ id: tenantId, name: "Orch-Test Co", publicKey: `orch-${tenantId.slice(0, 8)}` });
});

afterAll(async () => {
  await adminDb.delete(orchestratorEscalation).where(eq(orchestratorEscalation.tenantId, tenantId));
  await adminDb.delete(orchestratorEvent).where(eq(orchestratorEvent.tenantId, tenantId));
  await adminDb.delete(tenant).where(eq(tenant.id, tenantId));
});

const ev = () => makeEvent({ type: "lead.created", source: "savvy", tenantId, correlationId: "corr-1", idempotencyKey: `idem-${randomUUID()}`, payload: { leadId: "l1", customerId: "c1" } });

it("insertEventIfNew is true then false for the same idempotencyKey", async () => {
  const store = new DrizzleOrchestratorStore();
  const e = ev();
  expect(await store.insertEventIfNew(e)).toBe(true);
  expect(await store.insertEventIfNew(e)).toBe(false);
});

it("appendAudit + traceByCorrelation round-trips", async () => {
  const store = new DrizzleOrchestratorStore();
  const e = ev();
  await store.insertEventIfNew(e);
  await store.appendAudit({ event: e, agent: "comms", outcome: "handled", emitted: ["lead.first_touch"] });
  const trace = await store.traceByCorrelation(tenantId, "corr-1");
  expect(trace.some((a) => a.agent === "comms" && a.emitted.includes("lead.first_touch"))).toBe(true);
});

it("recordEscalation + listEscalations round-trips", async () => {
  const store = new DrizzleOrchestratorStore();
  const e = ev();
  await store.recordEscalation({ tenantId, correlationId: "corr-1", eventId: e.id, eventType: "estimate.approved", ruleId: "low-margin", severity: "high", reason: "18%", notify: ["arrington"] });
  const list = await store.listEscalations(tenantId);
  expect(list.some((x) => x.ruleId === "low-margin")).toBe(true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @savvy/db test orchestrator/store`
Expected: FAIL — `Cannot find module './store'`.

- [ ] **Step 3: Implement the Drizzle store**

Create `packages/db/src/orchestrator/store.ts`:

```ts
import { and, eq } from "drizzle-orm";
import type { OrchestratorStore, AuditRecord, EscalationRecord } from "@savvy/orchestrator";
import type { DomainEvent } from "@savvy/orchestrator";
import { withTenant } from "../tenant";
import { orchestratorEvent, orchestratorEscalation } from "../schema/orchestrator";

// Drizzle-backed store. Every write goes through withTenant so RLS is enforced
// on the app connection. insertEventIfNew leans on the partial unique index
// (outcome='received') — a duplicate receipt violates it and returns false.
export class DrizzleOrchestratorStore implements OrchestratorStore {
  async insertEventIfNew(e: DomainEvent): Promise<boolean> {
    return withTenant(e.tenantId, async (tx) => {
      const rows = await tx.insert(orchestratorEvent).values({
        tenantId: e.tenantId, eventId: e.id, eventType: e.type, version: e.version,
        source: e.source, correlationId: e.correlationId, idempotencyKey: e.idempotencyKey,
        actor: e.actor ?? null, agent: "system", outcome: "received",
        emitted: [], payload: e.payload as Record<string, unknown>,
      }).onConflictDoNothing({ target: [orchestratorEvent.tenantId, orchestratorEvent.idempotencyKey] }).returning({ id: orchestratorEvent.id });
      return rows.length > 0;
    });
  }

  async appendAudit(r: AuditRecord): Promise<void> {
    // The "received" outcome is written by insertEventIfNew; skip it here so we
    // don't collide with the dedupe index.
    if (r.outcome === "received") return;
    await withTenant(r.event.tenantId, async (tx) => {
      await tx.insert(orchestratorEvent).values({
        tenantId: r.event.tenantId, eventId: r.event.id, eventType: r.event.type, version: r.event.version,
        source: r.event.source, correlationId: r.event.correlationId, idempotencyKey: r.event.idempotencyKey,
        actor: r.event.actor ?? null, agent: r.agent, outcome: r.outcome,
        emitted: r.emitted, error: r.error ?? null, payload: r.event.payload as Record<string, unknown>,
      });
    });
  }

  async recordEscalation(r: EscalationRecord): Promise<void> {
    await withTenant(r.tenantId, async (tx) => {
      await tx.insert(orchestratorEscalation).values({
        tenantId: r.tenantId, ruleId: r.ruleId, severity: r.severity, reason: r.reason,
        notify: r.notify, eventId: r.eventId, eventType: r.eventType, correlationId: r.correlationId,
      });
    });
  }

  async traceByCorrelation(tenantId: string, correlationId: string): Promise<AuditRecord[]> {
    return withTenant(tenantId, async (tx) => {
      const rows = await tx.select().from(orchestratorEvent)
        .where(and(eq(orchestratorEvent.tenantId, tenantId), eq(orchestratorEvent.correlationId, correlationId)));
      return rows.map((row) => ({
        event: {
          id: row.eventId, type: row.eventType as DomainEvent["type"], version: row.version,
          occurredAt: row.createdAt.toISOString(), source: row.source as DomainEvent["source"],
          correlationId: row.correlationId, idempotencyKey: row.idempotencyKey,
          ...(row.actor ? { actor: row.actor } : {}), tenantId: row.tenantId,
          payload: (row.payload ?? {}) as never,
        },
        agent: row.agent,
        outcome: row.outcome as AuditRecord["outcome"],
        emitted: row.emitted,
        ...(row.error ? { error: row.error } : {}),
      }));
    });
  }

  async listEscalations(tenantId: string): Promise<EscalationRecord[]> {
    return withTenant(tenantId, async (tx) => {
      const rows = await tx.select().from(orchestratorEscalation)
        .where(eq(orchestratorEscalation.tenantId, tenantId));
      return rows.map((row) => ({
        tenantId: row.tenantId, correlationId: row.correlationId, eventId: row.eventId,
        eventType: row.eventType, ruleId: row.ruleId,
        severity: row.severity as EscalationRecord["severity"], reason: row.reason, notify: row.notify,
      }));
    });
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @savvy/db test orchestrator/store`
Expected: PASS (3 tests).

- [ ] **Step 5: Export + commit**

Add to `packages/db/src/index.ts`:
```ts
export { DrizzleOrchestratorStore } from "./orchestrator/store";
export { orchestratorEvent, orchestratorEscalation } from "./schema/orchestrator";
```

```bash
git add packages/db/src
git commit -m "feat(db): DrizzleOrchestratorStore (RLS-scoped, dedupe via partial unique index)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 9: Three real publishers + round-trip integration test

**Files:**
- Create: `packages/orchestrator/src/publishers.ts`
- Modify: `packages/orchestrator/src/index.ts`
- Test: `packages/orchestrator/src/publishers.test.ts`
- Test: `packages/db/src/orchestrator/integration.test.ts`

**Interfaces:**
- Consumes: `Orchestrator` (Task 5), `makeEvent` (Task 1).
- Produces:
  - `function publishLeadCreated(o: Orchestrator, a: { tenantId: string; leadId: string; customerId: string; actor?: string }): Promise<void>`
  - `function publishContractSigned(o: Orchestrator, a: { tenantId: string; jobId: string; customerId: string; actor?: string }): Promise<void>`
  - `function publishPaymentReceived(o: Orchestrator, a: { tenantId: string; invoiceId: string; amountCents: number; actor?: string }): Promise<void>`

- [ ] **Step 1: Write the failing publisher test**

Create `packages/orchestrator/src/publishers.test.ts`:

```ts
import { it, expect } from "vitest";
import { Orchestrator } from "./engine";
import { InMemoryStore } from "./store";
import { publishLeadCreated, publishContractSigned, publishPaymentReceived } from "./publishers";

const T = "11111111-1111-1111-1111-111111111111";

it("publishLeadCreated fires the lead.created chain", async () => {
  const store = new InMemoryStore();
  const o = new Orchestrator({ store });
  await publishLeadCreated(o, { tenantId: T, leadId: "l1", customerId: "c1" });
  expect(store.audits.some((a) => a.event.type === "lead.qualified")).toBe(true);
});

it("publishContractSigned fires job.approved", async () => {
  const store = new InMemoryStore();
  const o = new Orchestrator({ store });
  await publishContractSigned(o, { tenantId: T, jobId: "j1", customerId: "c1" });
  expect(store.audits.some((a) => a.event.type === "job.approved")).toBe(true);
});

it("publishPaymentReceived records a received audit and no escalation", async () => {
  const store = new InMemoryStore();
  const o = new Orchestrator({ store });
  await publishPaymentReceived(o, { tenantId: T, invoiceId: "i1", amountCents: 100 });
  expect(store.audits.some((a) => a.event.type === "payment.received")).toBe(true);
  expect(await store.listEscalations(T)).toEqual([]);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @savvy/orchestrator test publishers`
Expected: FAIL — `Cannot find module './publishers'`.

- [ ] **Step 3: Implement `publishers.ts`**

Create `packages/orchestrator/src/publishers.ts`:

```ts
import { makeEvent } from "./events";
import type { Orchestrator } from "./engine";

// Thin publish() helpers — the seam a real code path (lead intake, contract
// signing, payment webhook) calls to drop a canonical event on the bus. The
// idempotencyKey is derived from the entity so a retried webhook dedupes.

export function publishLeadCreated(
  o: Orchestrator, a: { tenantId: string; leadId: string; customerId: string; actor?: string },
): Promise<void> {
  return o.publish(makeEvent({
    type: "lead.created", source: "savvy", tenantId: a.tenantId,
    correlationId: a.leadId, idempotencyKey: `lead.created:${a.leadId}`,
    ...(a.actor ? { actor: a.actor } : {}),
    payload: { leadId: a.leadId, customerId: a.customerId },
  }));
}

export function publishContractSigned(
  o: Orchestrator, a: { tenantId: string; jobId: string; customerId: string; actor?: string },
): Promise<void> {
  return o.publish(makeEvent({
    type: "contract.signed", source: "canvass", tenantId: a.tenantId,
    correlationId: a.jobId, idempotencyKey: `contract.signed:${a.jobId}`,
    ...(a.actor ? { actor: a.actor } : {}),
    payload: { jobId: a.jobId, customerId: a.customerId },
  }));
}

export function publishPaymentReceived(
  o: Orchestrator, a: { tenantId: string; invoiceId: string; amountCents: number; actor?: string },
): Promise<void> {
  return o.publish(makeEvent({
    type: "payment.received", source: "savvy", tenantId: a.tenantId,
    correlationId: a.invoiceId, idempotencyKey: `payment.received:${a.invoiceId}`,
    ...(a.actor ? { actor: a.actor } : {}),
    payload: { invoiceId: a.invoiceId, amountCents: a.amountCents },
  }));
}
```

Add to `packages/orchestrator/src/index.ts`:
```ts
export * from "./publishers";
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @savvy/orchestrator test publishers`
Expected: PASS (3 tests).

- [ ] **Step 5: Write the DB round-trip integration test**

Create `packages/db/src/orchestrator/integration.test.ts`:

```ts
import { it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { Orchestrator, publishContractSigned, publishLeadCreated } from "@savvy/orchestrator";
import { adminDb, tenant } from "../index";
import { orchestratorEvent, orchestratorEscalation } from "../schema/orchestrator";
import { DrizzleOrchestratorStore } from "./store";

let tenantId: string;

beforeAll(async () => {
  tenantId = randomUUID();
  await adminDb.insert(tenant).values({ id: tenantId, name: "Orch-Int Co", publicKey: `oi-${tenantId.slice(0, 8)}` });
});

afterAll(async () => {
  await adminDb.delete(orchestratorEscalation).where(eq(orchestratorEscalation.tenantId, tenantId));
  await adminDb.delete(orchestratorEvent).where(eq(orchestratorEvent.tenantId, tenantId));
  await adminDb.delete(tenant).where(eq(tenant.id, tenantId));
});

it("a published lead persists its whole chain to the Drizzle store", async () => {
  const o = new Orchestrator({ store: new DrizzleOrchestratorStore() });
  await publishLeadCreated(o, { tenantId, leadId: `l-${randomUUID()}`, customerId: "c1" });
  const rows = await adminDb.select().from(orchestratorEvent).where(eq(orchestratorEvent.tenantId, tenantId));
  const types = rows.map((r) => r.eventType);
  expect(types).toContain("lead.created");
  expect(types).toContain("lead.qualified");
  expect(types).toContain("lead.assigned");
});

it("a re-published contract with the same key does not double-process", async () => {
  const o = new Orchestrator({ store: new DrizzleOrchestratorStore() });
  const jobId = `j-${randomUUID()}`;
  await publishContractSigned(o, { tenantId, jobId, customerId: "c1" });
  const before = (await adminDb.select().from(orchestratorEvent).where(eq(orchestratorEvent.tenantId, tenantId))).length;
  await publishContractSigned(o, { tenantId, jobId, customerId: "c1" }); // same idem key
  const after = (await adminDb.select().from(orchestratorEvent).where(eq(orchestratorEvent.tenantId, tenantId))).length;
  expect(after).toBe(before);
});
```

- [ ] **Step 6: Run the integration test**

Run: `pnpm --filter @savvy/db test orchestrator/integration`
Expected: PASS (2 tests).

- [ ] **Step 7: Commit**

```bash
git add packages/orchestrator/src packages/db/src
git commit -m "feat(orchestrator): 3 real publishers + DB round-trip integration test

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 10: Slice 2 gate — full suite + typecheck + lint + PR

- [ ] **Step 1: Run the full monorepo suite**

Run:
```bash
pnpm test
pnpm typecheck
pnpm lint
```
Expected: all green (orchestrator + db + everything else). If the shared local Postgres has fixture drift from other worktrees, scope to the two packages: `pnpm --filter @savvy/orchestrator --filter @savvy/db test`.

- [ ] **Step 2: Push + update the PR**

```bash
git push
```
The existing `orchestrator-day1` PR now carries both slices. Report the PR link + CI status and **stop for Brett's explicit merge word.** Do not merge, and do not deploy — this is library code with no runtime wiring yet, so no Vercel deploy is needed for Day 1.

---

## Self-Review Notes (author)

- **Spec coverage:** §1 bus (engine) ✓ · §2 idempotency+audit+dead-letter (engine + store) ✓ · §3 transport-independent core (store interface, in-memory + Drizzle) ✓ · §4 schema (events.ts) ✓ · §5 trigger registry (triggers.ts) ✓ · §6 escalation rules (escalations.ts; `speed-to-lead-breach` deferred with a written reason — it needs a timer the synchronous engine can't provide) ✓ · §8 acceptance test (acceptance.test.ts, all 8 steps + printed trace) ✓ · §9 Day-2 handoff shapes (`orchestrator_event` + `orchestrator_escalation`) ✓ · 3 publishers ✓.
- **Type consistency:** `OrchestratorStore` method names match between interface (Task 4), engine usage (Task 5), in-memory (Task 4) and Drizzle (Task 8). `EscalationRecord`/`AuditRecord` shapes are defined once in `store.ts` and imported everywhere.
- **Known implementer trap flagged inline:** the partial-unique-index `@ts-expect-error` sketch in Task 7 Step 2 is explicitly corrected in the same step — the real predicate is `where(sql\`outcome = 'received'\`)`, and `appendAudit` skips the `received` outcome (Task 8) so it never collides with that index.
- **tenantId + RLS** present on both tables and every store write goes through `withTenant`.
