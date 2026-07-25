# Orchestrator — Event Bus & Trigger Schema (Day 1)

**Date:** 2026-07-21
**Status:** Approved (Brett) — **standalone** build (Brett's explicit call), tenantId+RLS in the
envelope, Slice 1 = pure core + acceptance test, Slice 2 = Drizzle store + publishers.

## Context & the standalone decision (flagged, then chosen)
Savvy **already** has an event bus — **Inngest, 67 functions** — plus the 5 agents
(`packages/agents`), an `audit_log`/`agent_run` schema, idempotency (Inngest steps +
`import_record` ledger), and the Today "decision queue" (`buildExceptionQueue`) which is
literally Arrington's exception surface. The Day-1 prompt's catalog maps ~1:1 onto events
Savvy already emits (`lead/created`, `canvass/contract.signed`, `invoice/paid`, …). CLAUDE.md's
non-negotiable is "anything async is an Inngest workflow."

I recommended mapping the contracts onto that existing spine. **Brett chose to build the
Orchestrator standalone** (his call). This spec therefore builds a self-contained event bus in
a new package, independent of Inngest. **Known overlap / risk:** two event systems + two
exception surfaces now coexist; keeping them from diverging is a follow-up concern (a later
adapter could bridge Orchestrator ↔ Inngest, or migrate one onto the other). Recorded here so
it's a deliberate, visible trade-off, not an accident.

## Goal (Day-1 definition of done)
A typed/versioned/validated canonical event schema; a data-driven trigger registry
(event→agent→action) + escalation rules; a dispatch engine with idempotency, an append-only
audit log, a dead-letter path, and an escalation sink; 3 real publishers
(`lead.created`, `contract.signed`, `payment.received`); and a passing acceptance test that
fires a full job-lifecycle chain and prints a readable trace + the exception queue. **Out of
scope:** real agent business logic (stubs only), the Command Center UI, real external API calls,
and the durable/realtime transport.

## Architecture

New package **`packages/orchestrator`**. Two layers:

### Core (transport-independent, pure TS — what the acceptance test exercises)
1. **Event schema (§4)** — `DomainEvent` envelope + a typed payload map per `EventType`.
   Envelope: `id, type, version, occurredAt, source, correlationId, idempotencyKey, actor?,
   tenantId, payload`. **`tenantId` added** (Savvy is multi-tenant; the prompt omits it).
   `validateEvent(e)` → ok | `{ reason }`; unknown type / missing envelope field / bad payload
   shape is **rejected, not dropped** (routed to dead-letter). Zod schemas per event type.
2. **Trigger registry (§5)** — `Subscription[] = { event, agent, action, silent }` where `action`
   is `(event, ctx) => Promise<{ emit?: DomainEvent[] }>`. Agent actions are **stubs**: they emit
   the follow-on events (and may escalate) but contain no real business logic.
3. **Escalation registry (§6)** — `EscalationRule[] = { id, when(event): boolean, severity,
   reason(event): string, notify }`. Rules are data, tunable without touching dispatch.
4. **Dispatch engine** — `publish(event)`:
   validate → dedupe on `idempotencyKey` (seen → no-op) → append audit record → run each matching
   subscriber **in isolation** (one throw → dead-letter + synthesize a `handler.failed` event →
   `handler-failure` escalation; other subscribers unaffected) → collect emitted events and loop
   them back (chaining) → evaluate escalation rules against the event → matches go to the exception
   sink. Processing is ordered per `correlationId` (a job's events don't leapfrog). Every step is
   recorded so the log is replay-safe.

### Store (behind an interface — in-memory for tests, Drizzle for prod)
`OrchestratorStore`: `insertEventIfNew(event) → boolean` (dedupe), `appendAudit(record)`,
`recordEscalation(esc)`, `traceByCorrelation(id)`, `listEscalations()`.
- **In-memory** impl → the acceptance test + unit tests.
- **Drizzle/Postgres** impl (Slice 2) → tables **`orchestrator_event`** (append-only audit:
  envelope + `{handler, outcome, emitted[], escalated?}`) and **`orchestrator_escalation`** (the
  exception queue). **Unique index on `idempotency_key`** enforces dedupe at the DB. Both
  **RLS-scoped by `tenant_id`** (non-negotiable #1). Migration `0118`.

### Day-1 transport
**In-process synchronous** dispatch. Durable/realtime transport (Postgres LISTEN/NOTIFY or a
cron consumer) is deferred (§3: "keep the core transport-independent so you can swap later").

## Event catalog (§4)
All types from the prompt implemented in the payload map (`lead.created … review.posted`).
`Tool = savvy | canvass | alta-estimates | supplement-iq | bloomcam | bloom-materials | system`.

## Trigger registry seed (§5)
The prompt's table, e.g. `lead.created`→Comms(first_touch, emits `lead.first_touch`) +
Orchestrator(score/assign, emits `lead.qualified`+`lead.assigned`); `contract.signed`→
Scheduling(emits `material.order.created`) + Orchestrator(emits `job.approved`);
`estimate.approved`→Finance(guardrail, escalate if low); `job.completed`→Comms(review request) +
Finance(emits `invoice.created`); `payment.received`→Finance(reconcile/close, silent);
`invoice.past_due`→Finance(dunning, escalate at 90); `review.posted`→Comms(referral or escalate).

## Escalation rules seed (§6)
`low-margin` (`estimate.approved` & marginPct<25, high, sales mgr+Arrington);
`collections-90` (`invoice.past_due` & daysPastDue≥90, high, admin+Arrington);
`negative-review` (`review.posted` & stars≤3, high, manager);
`supplement-denied` (`supplement.approved` amount 0/denied, medium, claims);
`speed-to-lead-breach` (no `lead.first_touch` within N min of `lead.created`, medium, rep+mgr);
`handler-failure` (any subscriber throws, high, eng on-call).

## Testing (§8 acceptance + units)
**Acceptance test** (in-memory store) fires the 8-step chain and asserts: (1) `lead.created`
emits first_touch+qualified+assigned; (2) `contract.signed` emits material.order.created+
job.approved; (3) `estimate.approved` marginPct:18 → `low-margin` in the queue; (4)
`job.completed` emits invoice.created + schedules review; (5) full `payment.received` closes
silently (no escalation); (6) `invoice.past_due` days:92 → `collections-90`; (7) re-publish
step-1's event with the same idempotencyKey → no double-processing; (8) a throwing handler →
dead-letter + `handler-failure`, others unaffected. Prints a readable trace + final exception
queue. **Unit tests:** schema validation (reject paths), registry lookup, each escalation
predicate, dedupe, per-correlation ordering.

## Slices
- **Slice 1** — `packages/orchestrator` core: schema+validation, registry, escalation rules,
  dispatch engine, in-memory store, and the acceptance test (§8 green). The whole spine, no DB.
- **Slice 2** — Drizzle store (`orchestrator_event` + `orchestrator_escalation`, migration 0118,
  RLS, dedupe unique index) behind the store interface + the 3 real publishers
  (`lead.created`, `contract.signed`, `payment.received`) as thin `publish()` calls.

## Handoff to Day 2 (§9)
Day 2's Command Center reads `orchestrator_event` (audit) + `orchestrator_escalation`
(exception queue) by `correlationId`. Those two shapes are the stable contract — don't change
them without telling the Day-2 owner.
