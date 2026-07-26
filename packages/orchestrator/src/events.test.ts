import { it, expect } from "vitest";
import { validateEvent, makeEvent } from "./events";

const base = {
  type: "lead.created" as const,
  source: "savvy" as const,
  tenantId: "11111111-1111-1111-1111-111111111111",
  correlationId: "corr-1",
  idempotencyKey: "lead.created:lead-1",
  payload: { leadId: "lead-1", customerId: "cust-1", source: "web" },
};

it("makeEvent fills id/occurredAt/version and preserves fields", () => {
  const e = makeEvent(base);
  expect(e.id).toMatch(/./);
  expect(e.version).toBe(1);
  expect(typeof e.occurredAt).toBe("string");
  expect(e.type).toBe("lead.created");
  expect(e.payload).toEqual({ leadId: "lead-1", customerId: "cust-1", source: "web" });
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
  const e = makeEvent(base) as unknown as Record<string, unknown>;
  delete e.tenantId;
  const r = validateEvent(e);
  expect(r.ok).toBe(false);
});

it("validateEvent rejects a payload that does not match its type", () => {
  const e = makeEvent(base) as unknown as Record<string, unknown>;
  e.payload = { wrong: true };
  const r = validateEvent(e);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.reason).toMatch(/payload/i);
});

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
