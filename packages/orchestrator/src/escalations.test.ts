import { it, expect } from "vitest";
import { evaluateEscalations, makeComplianceBlock } from "./escalations";
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
