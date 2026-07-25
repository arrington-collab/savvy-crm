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
