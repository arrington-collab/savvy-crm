import { it, expect } from "vitest";
import { Orchestrator } from "./engine";
import { InMemoryStore } from "./store";
import { publishLeadCreated, publishContractSigned, publishPaymentReceived } from "./publishers";

const T = "11111111-1111-1111-1111-111111111111";

it("publishLeadCreated fires the lead.created chain", async () => {
  const store = new InMemoryStore();
  const o = new Orchestrator({ store });
  await publishLeadCreated(o, { tenantId: T, leadId: "l1", customerId: "c1" });
  expect(store.audits.some((a) => a.event.type === "lead.qualified")).toBe(true);
});

it("publishContractSigned fires job.approved", async () => {
  const store = new InMemoryStore();
  const o = new Orchestrator({ store });
  await publishContractSigned(o, { tenantId: T, jobId: "j1", customerId: "c1" });
  expect(store.audits.some((a) => a.event.type === "job.approved")).toBe(true);
});

it("publishPaymentReceived records a received audit and no escalation", async () => {
  const store = new InMemoryStore();
  const o = new Orchestrator({ store });
  await publishPaymentReceived(o, { tenantId: T, invoiceId: "i1", amountCents: 100 });
  expect(store.audits.some((a) => a.event.type === "payment.received")).toBe(true);
  expect(await store.listEscalations(T)).toEqual([]);
});
