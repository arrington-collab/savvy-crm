import { it, expect } from "vitest";
import { Orchestrator } from "./engine";
import { InMemoryStore, type OrchestratorStore } from "./store";
import { makeEvent, type EventType } from "./events";
import type { Subscription } from "./triggers";

const T = "11111111-1111-1111-1111-111111111111";
const lead = () => makeEvent({ type: "lead.created", source: "savvy", tenantId: T, correlationId: "corr-1", idempotencyKey: "idem-1", payload: { leadId: "l1", customerId: "c1", source: "web" } });

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

it("a store-write failure while dead-lettering does not throw out of publish()", async () => {
  // The Drizzle store's withTenant does a uuid cast, so a garbage tenantId (the
  // very thing that failed envelope validation) throws inside appendAudit. That
  // must not surface as a rejected publish() — the event is unprocessable, drop it.
  const throwingStore: OrchestratorStore = {
    insertEventIfNew: async () => true,
    appendAudit: async () => { throw new Error("invalid input syntax for type uuid"); },
    recordEscalation: async () => {},
    traceByCorrelation: async () => [],
    listEscalations: async () => [],
  };
  const o = new Orchestrator({ store: throwingStore });
  const badTenant = { ...lead(), tenantId: "not-a-uuid" } as never;
  await expect(o.publish(badTenant)).resolves.toBeUndefined();
});

it("an escalation rule records to the exception queue", async () => {
  const store = new InMemoryStore();
  const o = new Orchestrator({ store });
  await o.publish(makeEvent({ type: "estimate.approved", source: "savvy", tenantId: T, correlationId: "corr-2", idempotencyKey: "idem-est", payload: { estimateId: "e1", jobId: "j1", marginPct: 18 } }));
  const q = await store.listEscalations(T);
  expect(q.map((e) => e.ruleId)).toContain("low-margin");
});

it("two same-type sibling emits from one parent are both processed (no silent dedupe drop)", async () => {
  const store = new InMemoryStore();
  const emitTwice: Subscription = { event: "lead.created", agent: "orchestrator", action: (_e, ctx) => {
    ctx.emit("lead.assigned", { leadId: "l1", userId: "rep1" });
    ctx.emit("lead.assigned", { leadId: "l1", userId: "rep2" });
  }};
  const o = new Orchestrator({ store, triggers: (t) => (t === "lead.created" ? [emitTwice] : []) });
  await o.publish(lead());
  const assigned = store.audits.filter((a) => a.event.type === "lead.assigned" && a.outcome === "received");
  expect(assigned).toHaveLength(2); // both siblings processed, neither dropped
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
