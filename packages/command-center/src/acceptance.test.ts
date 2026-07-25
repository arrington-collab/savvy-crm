import { it, expect } from "vitest";
import {
  Orchestrator,
  InMemoryStore,
  makeEvent,
  evaluateEscalations,
  type DomainEvent,
  type EscalationRecord,
} from "@savvy/orchestrator";
import { projectDay } from "./projection";
import { ExceptionQueue } from "./exception-queue";
import { renderFlashHeadline, renderFlashHtml } from "./flash";
import { compareMetrics } from "./comparison";

const T = "11111111-1111-1111-1111-111111111111";
const D = "2026-07-01";
const at = (h: number, min = 0) => new Date(Date.UTC(2026, 6, 1, 6 + h, min)).toISOString();

// Publish helper that stamps occurredAt so events land on the Denver business day D.
async function fire(o: Orchestrator, type: DomainEvent["type"], payload: unknown, occurredAt: string, idem: string) {
  await o.publish(makeEvent({ type, source: "savvy", tenantId: T, correlationId: "job", idempotencyKey: idem, occurredAt, payload } as never));
}
// The event log Day-2 reads = the store's `received`-outcome audit rows.
function logFrom(store: InMemoryStore): DomainEvent[] {
  return store.audits.filter((a) => a.outcome === "received").map((a) => a.event);
}

it("§8 acceptance: a business day projects to a correct Flash + workable exception queue", async () => {
  const store = new InMemoryStore();
  const o = new Orchestrator({ store });

  // (1) counts
  await fire(o, "lead.created", { leadId: "l1", customerId: "c1", source: "canvass" }, at(1), "lc1");
  await fire(o, "lead.created", { leadId: "l2", customerId: "c2", source: "canvass" }, at(1), "lc2");
  await fire(o, "lead.created", { leadId: "l3", customerId: "c3", source: "web" }, at(1), "lc3");
  await fire(o, "lead.created", { leadId: "l4", customerId: "c4", source: "web" }, at(1), "lc4");
  await fire(o, "lead.created", { leadId: "l5", customerId: "c5", source: "web" }, at(1), "lc5");
  await fire(o, "lead.first_touch", { leadId: "l1", channel: "sms" }, at(1, 3), "ft1"); // 3m
  await fire(o, "lead.first_touch", { leadId: "l2", channel: "sms" }, at(1, 9), "ft2"); // 9m
  await fire(o, "appointment.set", { appointmentId: "a1", scheduledAt: at(2) }, at(2), "as1");
  await fire(o, "appointment.set", { appointmentId: "a2", scheduledAt: at(2) }, at(2), "as2");
  await fire(o, "appointment.set", { appointmentId: "a3", scheduledAt: at(2) }, at(2), "as3");
  await fire(o, "appointment.no_show", { appointmentId: "a4" }, at(3), "an1");
  await fire(o, "contract.signed", { jobId: "j1", customerId: "c1", contractValueCents: 2400000 }, at(4), "cs1");
  await fire(o, "contract.signed", { jobId: "j2", customerId: "c2", contractValueCents: 1800000 }, at(4), "cs2");
  await fire(o, "job.completed", { jobId: "j1" }, at(5), "jc1");
  // (2) money
  await fire(o, "invoice.created", { invoiceId: "i1", jobId: "j1", amountCents: 2400000 }, at(6), "ic1");
  await fire(o, "payment.received", { invoiceId: "i1", amountCents: 2400000 }, at(7), "pr1");
  // (4) escalation sources
  await fire(o, "estimate.approved", { estimateId: "e1", jobId: "j1", marginPct: 18 }, at(4, 30), "ea1"); // low-margin
  await fire(o, "invoice.past_due", { invoiceId: "i9", daysPastDue: 92 }, at(8), "pd1"); // collections-90
  await fire(o, "review.posted", { jobId: "j1", stars: 2 }, at(9), "rp1"); // negative-review
  await fire(o, "handler.failed", { ofType: "estimate.approved", agent: "finance", error: "boom" }, at(10), "hf1"); // handler-failure

  const log = logFrom(store);
  const metrics = projectDay(log, D);

  // (1)
  expect(metrics.topLine.leadsTotal).toBe(5);
  expect(metrics.topLine.leadsBySource).toEqual({ canvass: 2, web: 3 });
  expect(metrics.topLine.appointmentsSet).toBe(3);
  expect(metrics.topLine.appointmentsNoShow).toBe(1);
  expect(metrics.topLine.contractsSigned).toBe(2);
  expect(metrics.topLine.contractValueCents).toBe(4200000);
  expect(metrics.topLine.jobsCompleted).toBe(1);
  // (2)
  expect(metrics.money.invoicedCents).toBe(2400000);
  expect(metrics.money.cashCollectedCents).toBe(2400000);
  // (3)
  expect(metrics.speed.medianSpeedToLeadMs).toBe(6 * 60000);
  expect(metrics.speed.pctLeadsUnder5Min).toBeCloseTo(1 / 5);

  // (4) exception queue from Day-1 escalations
  const queue = new ExceptionQueue();
  for (const e of log) {
    for (const hit of evaluateEscalations(e)) {
      const rec: EscalationRecord = { ...hit, tenantId: e.tenantId, correlationId: e.correlationId, eventId: e.id, eventType: e.type };
      queue.intake(rec, e.occurredAt);
    }
  }
  const now = new Date(at(18));
  const ruleIds = queue.all().map((i) => i.ruleId);
  // Exactly the 4 Day-1 escalations — not a subset check. arrayContaining would
  // silently accept 3-of-4 as "the four escalations appear"; assert the exact set.
  expect([...new Set(ruleIds)].sort()).toEqual(["collections-90", "handler-failure", "low-margin", "negative-review"]);
  expect(queue.all().find((i) => i.ruleId === "low-margin")?.severity).toBe("high");
  expect(queue.all().find((i) => i.ruleId === "handler-failure")?.severity).toBe("high");
  const mine = queue.needsYou("arrington", now); // low-margin + collections-90 notify arrington
  expect(mine.map((i) => i.ruleId).sort()).toEqual(["collections-90", "low-margin"]);

  // print — right after check 4, before the lifecycle mutations below consume
  // arrington's items, so the printed demo honestly shows his 2 open items.
  console.log("\n" + renderFlashHeadline(metrics, mine));
  console.log(renderFlashHtml(metrics, mine, compareMetrics(metrics, null, [])).slice(0, 200) + "…");

  // (5) lifecycle
  const ackTarget = mine[0]!;
  queue.acknowledge(ackTarget.key, "arrington", at(18, 5));
  expect(queue.needsYou("arrington", now).map((i) => i.key)).not.toContain(ackTarget.key);
  const snoozeTarget = queue.needsYou("arrington", now)[0]!;
  queue.snooze(snoozeTarget.key, at(30)); // tomorrow
  expect(queue.needsYou("arrington", now).map((i) => i.key)).not.toContain(snoozeTarget.key);
  expect(queue.all().length).toBe(ruleIds.length); // nothing deleted

  // (6) idempotency: re-project + re-intake same log → identical
  const metrics2 = projectDay(log, D);
  expect(metrics2).toEqual(metrics);
  const before = queue.all().length;
  for (const e of log) {
    for (const hit of evaluateEscalations(e)) {
      const rec: EscalationRecord = { ...hit, tenantId: e.tenantId, correlationId: e.correlationId, eventId: e.id, eventType: e.type };
      queue.intake(rec, e.occurredAt);
    }
  }
  expect(queue.all().length).toBe(before); // no dupes

  // (7) replay
  expect(projectDay(logFrom(store), D)).toEqual(metrics);
});

it("§8(8) quiet day: an empty log yields a valid quiet-day flash, no crash, zero exceptions", () => {
  const metrics = projectDay([], D);
  const queue = new ExceptionQueue();
  expect(queue.openCount(new Date(at(18))).total).toBe(0);
  const headline = renderFlashHeadline(metrics, []);
  expect(headline.toLowerCase()).toContain("quiet");
  expect(() => renderFlashHtml(metrics, [], { leadsTotalVsYesterday: null, contractValueVsTrailing7: null, cashCollectedVsTrailing7: null })).not.toThrow();
});
