import { it, expect } from "vitest";
import { projectDay } from "./projection";
import {
  projectDayByRep,
  projectDayBySource,
  projectDayByLocation,
  UNASSIGNED_REP,
  UNKNOWN_SOURCE,
  UNKNOWN_LOCATION,
} from "./dimensional";
import { makeEvent, type DomainEvent } from "@savvy/orchestrator";

const T = "11111111-1111-1111-1111-111111111111";
const D = "2026-07-01";
const at = (h: number, min = 0) => new Date(Date.UTC(2026, 6, 1, 6 + h, min)).toISOString(); // 6:00Z = 00:00 MDT
function ev<Tp extends Parameters<typeof makeEvent>[0]["type"]>(type: Tp, payload: unknown, occurredAt: string): DomainEvent {
  return makeEvent({ type, source: "savvy", tenantId: T, correlationId: "c", idempotencyKey: `${type}:${Math.random()}`, occurredAt, payload } as never);
}

function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}

// ---------- projectDayByRep ----------

it("attributes leads/first-touch/median speed to each lead's assigned rep", () => {
  const events: DomainEvent[] = [
    ev("lead.assigned", { leadId: "l1", userId: "u1", repId: "rep-a", locationId: "loc-1" }, at(0, 30)),
    ev("lead.created", { leadId: "l1", customerId: "c1", source: "web" }, at(1, 0)),
    ev("lead.first_touch", { leadId: "l1", channel: "sms", slaLatencySeconds: 60 }, at(1, 1)),

    ev("lead.assigned", { leadId: "l2", userId: "u2", repId: "rep-b", locationId: "loc-1" }, at(0, 30)),
    ev("lead.created", { leadId: "l2", customerId: "c2", source: "web" }, at(2, 0)),
    ev("lead.first_touch", { leadId: "l2", channel: "sms", slaLatencySeconds: 300 }, at(2, 1)),

    ev("lead.assigned", { leadId: "l3", userId: "u1", repId: "rep-a", locationId: "loc-1" }, at(0, 30)),
    ev("lead.created", { leadId: "l3", customerId: "c3", source: "web" }, at(3, 0)),
    ev("lead.first_touch", { leadId: "l3", channel: "sms", slaLatencySeconds: 120 }, at(3, 1)),
  ];
  const rows = projectDayByRep(events, D);
  const repA = rows.find((r) => r.repId === "rep-a")!;
  const repB = rows.find((r) => r.repId === "rep-b")!;
  expect(repA.leads).toBe(2);
  expect(repA.firstTouches).toBe(2);
  expect(repA.medianSpeedSeconds).toBe(90); // median(60, 120)
  expect(repA.locationId).toBe("loc-1");
  expect(repB.leads).toBe(1);
  expect(repB.medianSpeedSeconds).toBe(300);
});

it("a lead with no lead.assigned event lands in the sentinel unassigned-rep bucket (not dropped)", () => {
  const events: DomainEvent[] = [
    ev("lead.created", { leadId: "l1", customerId: "c1", source: "web" }, at(1, 0)),
  ];
  const rows = projectDayByRep(events, D);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.repId).toBe(UNASSIGNED_REP);
  expect(rows[0]!.leads).toBe(1);
});

it("contract.signed carries no leadId in the current event schema, so it lands in the unassigned-rep bucket (documented limitation)", () => {
  const events: DomainEvent[] = [
    ev("lead.assigned", { leadId: "l1", userId: "u1", repId: "rep-a" }, at(0, 30)),
    ev("lead.created", { leadId: "l1", customerId: "c1", source: "web" }, at(1, 0)),
    ev("contract.signed", { jobId: "j1", customerId: "c1", contractValueCents: 100_000 }, at(4)),
  ];
  const rows = projectDayByRep(events, D);
  const repA = rows.find((r) => r.repId === "rep-a")!;
  const unassigned = rows.find((r) => r.repId === UNASSIGNED_REP)!;
  expect(repA.contracts).toBe(0);
  expect(unassigned.contracts).toBe(1);
  expect(unassigned.contractValueCents).toBe(100_000);
});

// ---------- projectDayBySource ----------

it("groups by lead.created source and folds appts/contracts; sums back to the flat lead.created count", () => {
  const events: DomainEvent[] = [
    ev("lead.created", { leadId: "l1", customerId: "c1", source: "canvass" }, at(1)),
    ev("lead.created", { leadId: "l2", customerId: "c2", source: "web" }, at(1)),
    ev("lead.created", { leadId: "l3", customerId: "c3", source: "web" }, at(1)),
    ev("appointment.set", { appointmentId: "a1", leadId: "l2", scheduledAt: at(2) }, at(2)),
  ];
  const rows = projectDayBySource(events, D);
  const bySource = Object.fromEntries(rows.map((r) => [r.source, r]));
  expect(bySource.canvass!.leads).toBe(1);
  expect(bySource.web!.leads).toBe(2);
  expect(bySource.web!.apptsSet).toBe(1);
  expect(sum(rows.map((r) => r.leads))).toBe(projectDay(events, D).topLine.leadsTotal);
  expect(rows.every((r) => r.costCents === undefined)).toBe(true);
});

it("an appointment.set with no leadId cannot be traced to a source and lands in the unknown-source bucket", () => {
  const events: DomainEvent[] = [
    ev("lead.created", { leadId: "l1", customerId: "c1", source: "web" }, at(1)),
    ev("appointment.set", { appointmentId: "a1", jobId: "j1", scheduledAt: at(2) }, at(2)),
  ];
  const rows = projectDayBySource(events, D);
  const unknown = rows.find((r) => r.source === UNKNOWN_SOURCE)!;
  expect(unknown.apptsSet).toBe(1);
});

// ---------- projectDayByLocation ----------

it("groups events by their own locationId field and runs projectDay per bucket; events without one go to the null-location bucket", () => {
  const events: DomainEvent[] = [
    ev("lead.first_touch", { leadId: "l1", channel: "sms", locationId: "loc-1", latencySeconds: 30 }, at(1)),
    ev("lead.first_touch", { leadId: "l2", channel: "sms", locationId: "loc-2", latencySeconds: 90 }, at(1)),
    // no locationId field at all — this event type never carries one
    ev("lead.created", { leadId: "l3", customerId: "c3", source: "web" }, at(1)),
  ];
  const rows = projectDayByLocation(events, D);
  const byLoc = Object.fromEntries(rows.map((r) => [r.locationId, r]));
  expect(byLoc["loc-1"]!.metrics.speed.medianSpeedToLeadMs).toBe(30_000);
  expect(byLoc["loc-2"]!.metrics.speed.medianSpeedToLeadMs).toBe(90_000);
  expect(byLoc[UNKNOWN_LOCATION]!.metrics.topLine.leadsTotal).toBe(1);
});

// ---------- §8.2 invariant ----------

it("§8.2 invariant: dimensional splits sum back to the company projectDay totals for the same window — no double-count, no drop", () => {
  const events: DomainEvent[] = [
    ev("lead.assigned", { leadId: "l1", userId: "u1", repId: "rep-a", locationId: "loc-1" }, at(0, 30)),
    ev("lead.created", { leadId: "l1", customerId: "c1", source: "canvass" }, at(1)),
    ev("lead.first_touch", { leadId: "l1", channel: "sms", slaLatencySeconds: 60 }, at(1, 1)),
    ev("appointment.set", { appointmentId: "a1", leadId: "l1", scheduledAt: at(2) }, at(2)),

    ev("lead.assigned", { leadId: "l2", userId: "u2", repId: "rep-b", locationId: "loc-2" }, at(0, 30)),
    ev("lead.created", { leadId: "l2", customerId: "c2", source: "web" }, at(1)),

    // never assigned — unassigned bucket
    ev("lead.created", { leadId: "l3", customerId: "c3", source: "web" }, at(1)),

    // no leadId at all on any of these — unassigned/unknown bucket
    ev("appointment.no_show", { appointmentId: "a2", jobId: "j9" }, at(3)),
    ev("contract.signed", { jobId: "j1", customerId: "c1", contractValueCents: 500_000 }, at(4)),
    ev("contract.signed", { jobId: "j2", customerId: "c2", contractValueCents: 300_000 }, at(4)),
  ];

  const company = projectDay(events, D);
  const byRep = projectDayByRep(events, D);
  const bySource = projectDayBySource(events, D);
  const byLocation = projectDayByLocation(events, D);

  expect(sum(byRep.map((r) => r.leads))).toBe(company.topLine.leadsTotal);
  expect(sum(byRep.map((r) => r.apptsSet))).toBe(company.topLine.appointmentsSet);
  expect(sum(byRep.map((r) => r.noShows))).toBe(company.topLine.appointmentsNoShow);
  expect(sum(byRep.map((r) => r.contracts))).toBe(company.topLine.contractsSigned);
  expect(sum(byRep.map((r) => r.contractValueCents))).toBe(company.topLine.contractValueCents);

  expect(sum(bySource.map((r) => r.leads))).toBe(company.topLine.leadsTotal);
  expect(sum(bySource.map((r) => r.contracts))).toBe(company.topLine.contractsSigned);
  expect(sum(bySource.map((r) => r.contractValueCents))).toBe(company.topLine.contractValueCents);

  expect(sum(byLocation.map((r) => r.metrics.topLine.leadsTotal))).toBe(company.topLine.leadsTotal);
  expect(sum(byLocation.map((r) => r.metrics.topLine.contractsSigned))).toBe(company.topLine.contractsSigned);
  expect(sum(byLocation.map((r) => r.metrics.topLine.contractValueCents))).toBe(company.topLine.contractValueCents);
  expect(sum(byLocation.map((r) => r.metrics.topLine.appointmentsNoShow))).toBe(company.topLine.appointmentsNoShow);
});

it("ignores events from other days, same as projectDay", () => {
  const other = new Date(Date.UTC(2026, 6, 3, 12)).toISOString();
  const rows = projectDayByRep([ev("lead.created", { leadId: "x", customerId: "c", source: "web" }, other)], D);
  expect(rows).toHaveLength(0);
});
