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
