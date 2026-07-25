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
