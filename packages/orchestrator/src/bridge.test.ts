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
