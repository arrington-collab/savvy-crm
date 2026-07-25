import { it, expect } from "vitest";
import { InMemoryStore } from "./store";
import { makeEvent } from "./events";

const T = "11111111-1111-1111-1111-111111111111";
const ev = makeEvent({ type: "lead.created", source: "savvy", tenantId: T, correlationId: "corr-1", idempotencyKey: "idem-1", payload: { leadId: "l1", customerId: "c1", source: "web" } });

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
