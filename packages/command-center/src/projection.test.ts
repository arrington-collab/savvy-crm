import { it, expect } from "vitest";
import { projectDay } from "./projection";
import { makeEvent, type DomainEvent } from "@savvy/orchestrator";

const T = "11111111-1111-1111-1111-111111111111";
const D = "2026-07-01";
const at = (h: number, min = 0) => new Date(Date.UTC(2026, 6, 1, 6 + h, min)).toISOString(); // 6:00Z = 00:00 MDT
function ev<Tp extends Parameters<typeof makeEvent>[0]["type"]>(type: Tp, payload: unknown, occurredAt: string): DomainEvent {
  return makeEvent({ type, source: "savvy", tenantId: T, correlationId: "c", idempotencyKey: `${type}:${Math.random()}`, occurredAt, payload } as never);
}

it("folds top-line counts and money for the day", () => {
  const events: DomainEvent[] = [
    ev("lead.created", { leadId: "l1", customerId: "c1", source: "canvass" }, at(1)),
    ev("lead.created", { leadId: "l2", customerId: "c2", source: "web" }, at(1)),
    ev("lead.created", { leadId: "l3", customerId: "c3", source: "web" }, at(1)),
    ev("appointment.set", { appointmentId: "a1", scheduledAt: at(2) }, at(2)),
    ev("appointment.no_show", { appointmentId: "a2" }, at(3)),
    ev("contract.signed", { jobId: "j1", customerId: "c1", contractValueCents: 2400000 }, at(4)),
    ev("contract.signed", { jobId: "j2", customerId: "c2", contractValueCents: 1800000 }, at(4)),
    ev("job.completed", { jobId: "j1" }, at(5)),
    ev("invoice.created", { invoiceId: "i1", jobId: "j1", amountCents: 2400000 }, at(6)),
    ev("payment.received", { invoiceId: "i1", amountCents: 2400000 }, at(7)),
  ];
  const m = projectDay(events, D);
  expect(m.topLine.leadsTotal).toBe(3);
  expect(m.topLine.leadsBySource).toEqual({ canvass: 1, web: 2 });
  expect(m.topLine.appointmentsSet).toBe(1);
  expect(m.topLine.appointmentsNoShow).toBe(1);
  expect(m.topLine.contractsSigned).toBe(2);
  expect(m.topLine.contractValueCents).toBe(4200000);
  expect(m.topLine.jobsCompleted).toBe(1);
  expect(m.money.invoicedCents).toBe(2400000);
  expect(m.money.cashCollectedCents).toBe(2400000);
});

it("computes median speed-to-lead and % under 5 min; a lead with no first touch is excluded from median but counted in the SLA %", () => {
  const events: DomainEvent[] = [
    ev("lead.created", { leadId: "l1", customerId: "c1", source: "web" }, at(1, 0)),
    ev("lead.first_touch", { leadId: "l1", channel: "sms" }, at(1, 3)), // 3 min → under 5
    ev("lead.created", { leadId: "l2", customerId: "c2", source: "web" }, at(2, 0)),
    ev("lead.first_touch", { leadId: "l2", channel: "sms" }, at(2, 9)), // 9 min → over 5
    ev("lead.created", { leadId: "l3", customerId: "c3", source: "web" }, at(3, 0)), // never touched
  ];
  const m = projectDay(events, D);
  expect(m.speed.medianSpeedToLeadMs).toBe(6 * 60_000); // median of [3min, 9min] = 6min
  expect(m.speed.pctLeadsUnder5Min).toBeCloseTo(1 / 3); // 1 of 3 leads
});

it("a quiet day yields zeroed metrics, no crash", () => {
  const m = projectDay([], D);
  expect(m.businessDate).toBe(D);
  expect(m.topLine.leadsTotal).toBe(0);
  expect(m.speed.medianSpeedToLeadMs).toBeNull();
  expect(m.quality.avgStars).toBeNull();
});

it("ignores events from other days", () => {
  const other = new Date(Date.UTC(2026, 6, 3, 12)).toISOString();
  const m = projectDay([ev("lead.created", { leadId: "x", customerId: "c", source: "web" }, other)], D);
  expect(m.topLine.leadsTotal).toBe(0);
});

it("AR buckets use the latest-by-time daysPastDue reading, not the last-in-array one", () => {
  const events: DomainEvent[] = [
    // later-occurredAt reading (should win) appears FIRST in the array
    ev("invoice.past_due", { invoiceId: "i1", daysPastDue: 92 }, at(5)),
    // earlier-occurredAt reading appears LAST in the array — must NOT overwrite the later one
    ev("invoice.past_due", { invoiceId: "i1", daysPastDue: 10 }, at(2)),
  ];
  const m = projectDay(events, D);
  expect(m.money.arPastDue.d90).toBe(1);
  expect(m.money.arPastDue.d60).toBe(0);
  expect(m.money.arPastDue.d30).toBe(0);
});

it("AR buckets 30/60/90 are mutually exclusive at boundaries", () => {
  const events: DomainEvent[] = [
    ev("invoice.past_due", { invoiceId: "i29", daysPastDue: 29 }, at(1)),
    ev("invoice.past_due", { invoiceId: "i30", daysPastDue: 30 }, at(1)),
    ev("invoice.past_due", { invoiceId: "i59", daysPastDue: 59 }, at(1)),
    ev("invoice.past_due", { invoiceId: "i60", daysPastDue: 60 }, at(1)),
    ev("invoice.past_due", { invoiceId: "i89", daysPastDue: 89 }, at(1)),
    ev("invoice.past_due", { invoiceId: "i90", daysPastDue: 90 }, at(1)),
    ev("invoice.past_due", { invoiceId: "i92", daysPastDue: 92 }, at(1)),
  ];
  const m = projectDay(events, D);
  expect(m.money.arPastDue.d30).toBe(2); // i30, i59
  expect(m.money.arPastDue.d60).toBe(2); // i60, i89
  expect(m.money.arPastDue.d90).toBe(2); // i90, i92
});

it("sums supplement.approved amounts in cents", () => {
  const events: DomainEvent[] = [
    ev("supplement.approved", { supplementId: "s1", amountCents: 50000 }, at(1)),
    ev("supplement.approved", { supplementId: "s2", amountCents: 25000 }, at(2)),
  ];
  const m = projectDay(events, D);
  expect(m.money.supplementsApprovedCents).toBe(75000);
});

it("averages review stars", () => {
  const events: DomainEvent[] = [
    ev("review.posted", { jobId: "j1", stars: 4 }, at(1)),
    ev("review.posted", { jobId: "j2", stars: 2 }, at(2)),
  ];
  const m = projectDay(events, D);
  expect(m.quality.reviewsPosted).toBe(2);
  expect(m.quality.avgStars).toBe(3);
});

it("averages estimate margin and counts material orders", () => {
  const events: DomainEvent[] = [
    ev("estimate.approved", { estimateId: "e1", jobId: "j1", marginPct: 20 }, at(1)),
    ev("estimate.approved", { estimateId: "e2", jobId: "j2", marginPct: 30 }, at(2)),
    ev("material.order.created", { jobId: "j1" }, at(3)),
  ];
  const m = projectDay(events, D);
  expect(m.production.estimatesApproved).toBe(2);
  expect(m.production.avgMarginPct).toBe(25);
  expect(m.production.materialOrders).toBe(1);
});
