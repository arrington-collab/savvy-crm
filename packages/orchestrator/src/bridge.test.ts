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
  expect(store.audits.some((a) => a.event.idempotencyKey === "lead.first_touch:lead-1")).toBe(true);
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
  const e = makeEvent({ type: "handler.failed", source: "savvy", tenantId: TENANT, correlationId: "x", idempotencyKey: "handler.failed:x", payload: { ofType: "lead.created", agent: "h", error: "boom" } });
  const r = await publishDomainEvent(store, e);
  expect(r.escalations.length).toBeGreaterThan(0);
  expect(store.escalations.length).toBe(r.escalations.length);
});

it("never runs subscriber choreography — a bridged publish records only the receipt audit, not the subscriber-handled outcomes Orchestrator.publish() would produce", async () => {
  // lead.created has TWO registered subscriptions in triggers.ts (comms ->
  // lead.first_touch, orchestrator -> lead.qualified/lead.assigned). If
  // publishDomainEvent were ever swapped for (or delegated to)
  // Orchestrator.publish(), those subscribers would run and re-fire agent
  // actions on every Inngest retry — the whole reason this bridge exists
  // instead of engine.ts's publish(). Assert the store sees exactly the
  // system "received" audit and nothing that looks like subscriber
  // choreography (no "handled" outcome, no non-"system" agent, no child
  // events queued).
  const store = new InMemoryStore();
  const e = makeEvent({
    type: "lead.created", source: "savvy", tenantId: TENANT,
    correlationId: "lead-choreo", idempotencyKey: "lead.created:lead-choreo",
    payload: { leadId: "lead-choreo", customerId: "cust-1", source: "web" },
  });

  const r = await publishDomainEvent(store, e);

  expect(r.published).toBe(true);
  expect(store.audits).toHaveLength(1);
  expect(store.audits[0]).toMatchObject({ agent: "system", outcome: "received" });
  expect(store.audits.some((a) => a.agent !== "system")).toBe(false);
  expect(store.audits.some((a) => a.outcome === "handled")).toBe(false);
  // No lead.first_touch / lead.qualified / lead.assigned child events were
  // inserted — choreography never ran, so nothing downstream was recorded.
  expect(store.audits.some((a) => a.event.type !== "lead.created")).toBe(false);
});
