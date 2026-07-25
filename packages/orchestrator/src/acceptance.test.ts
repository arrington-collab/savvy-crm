import { it, expect } from "vitest";
import { Orchestrator } from "./engine";
import { InMemoryStore } from "./store";
import { makeEvent, type EventType, type PayloadFor } from "./events";

const T = "11111111-1111-1111-1111-111111111111";
function fire<Tp extends EventType>(o: Orchestrator, type: Tp, correlationId: string, idem: string, payload: PayloadFor<Tp>) {
  return o.publish(makeEvent({ type, source: "savvy", tenantId: T, correlationId, idempotencyKey: idem, payload }));
}

it("§8 acceptance: a full job lifecycle chains, escalates, dedupes, and isolates failures", async () => {
  const store = new InMemoryStore();
  const o = new Orchestrator({ store });

  // (1) lead.created → first_touch + qualified + assigned
  await fire(o, "lead.created", "job-1", "lc-1", { leadId: "l1", customerId: "c1" });
  // (2) contract.signed → material.order.created + job.approved
  await fire(o, "contract.signed", "job-1", "cs-1", { jobId: "j1", customerId: "c1" });
  // (3) estimate.approved @ 18% → low-margin escalation
  await fire(o, "estimate.approved", "job-1", "ea-1", { estimateId: "e1", jobId: "j1", marginPct: 18 });
  // (4) job.completed → invoice.created + review.requested
  await fire(o, "job.completed", "job-1", "jc-1", { jobId: "j1" });
  // (5) payment.received → closes silently, no escalation
  await fire(o, "payment.received", "job-1", "pr-1", { invoiceId: "i1", amountCents: 926722 });
  // (6) invoice.past_due @ 92 → collections-90
  await fire(o, "invoice.past_due", "job-2", "pd-1", { invoiceId: "i2", daysPastDue: 92 });
  // (7) re-publish step 1 with the SAME idempotencyKey → no double processing
  const before = store.audits.length;
  await fire(o, "lead.created", "job-1", "lc-1", { leadId: "l1", customerId: "c1" });
  expect(store.audits.length).toBe(before);

  const types = store.audits.map((a) => `${a.event.type}:${a.outcome}`);
  expect(types).toContain("lead.first_touch:handled");
  expect(types).toContain("material.order.created:handled");
  expect(types).toContain("job.approved:handled");
  expect(types).toContain("invoice.created:handled");
  expect(types).toContain("review.requested:handled");

  const queue = await store.listEscalations(T);
  const ruleIds = queue.map((e) => e.ruleId);
  expect(ruleIds).toContain("low-margin");
  expect(ruleIds).toContain("collections-90");
  expect(ruleIds).not.toContain("negative-review"); // no bad review fired

  // (8) a throwing handler dead-letters + raises handler-failure, siblings unaffected
  const failStore = new InMemoryStore();
  const failing = new Orchestrator({
    store: failStore,
    triggers: (t) => (t === "review.posted"
      ? [
          { event: "review.posted", agent: "comms", action: () => { throw new Error("notify failed"); } },
          { event: "review.posted", agent: "orchestrator", action: (_e, ctx) => ctx.emit("review.requested", { jobId: "j9", customerId: "c9" }) },
        ]
      : []),
  });
  await fire(failing, "review.posted", "job-9", "rp-1", { jobId: "j9", stars: 2 });
  expect(failStore.audits.some((a) => a.outcome === "dead_letter" && a.agent === "comms")).toBe(true);
  expect(failStore.audits.some((a) => a.event.type === "review.requested")).toBe(true);
  const fq = await failStore.listEscalations(T);
  expect(fq.map((e) => e.ruleId)).toContain("handler-failure");
  expect(fq.map((e) => e.ruleId)).toContain("negative-review");

  // Human-readable trace dump (the spec asks the acceptance test to print one).
  const trace = await store.traceByCorrelation(T, "job-1");
  console.log("\n=== job-1 trace ===\n" + trace.map((a) => `  ${a.event.type.padEnd(24)} ${a.agent.padEnd(13)} ${a.outcome}${a.emitted.length ? " → " + a.emitted.join(", ") : ""}`).join("\n"));
  console.log("\n=== exception queue ===\n" + queue.map((e) => `  [${e.severity}] ${e.ruleId}: ${e.reason} → ${e.notify.join(", ")}`).join("\n") + "\n");
});
