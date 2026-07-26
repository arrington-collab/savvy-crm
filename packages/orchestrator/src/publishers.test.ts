import { it, expect } from "vitest";
import { Orchestrator } from "./engine";
import { InMemoryStore } from "./store";
import {
  publishLeadCreated, publishContractSigned, publishPaymentReceived,
  publishFirstTouch, publishLeadAssigned, publishReminderSent, publishDripStepSent,
  publishMessageInbound, publishContactOptedOut, publishCallMissed,
} from "./publishers";

const T = "11111111-1111-1111-1111-111111111111";

it("publishLeadCreated fires the lead.created chain", async () => {
  const store = new InMemoryStore();
  const o = new Orchestrator({ store });
  await publishLeadCreated(o, { tenantId: T, leadId: "l1", customerId: "c1", source: "web" });
  expect(store.audits.some((a) => a.event.type === "lead.qualified")).toBe(true);
});

it("publishContractSigned fires job.approved", async () => {
  const store = new InMemoryStore();
  const o = new Orchestrator({ store });
  await publishContractSigned(o, { tenantId: T, jobId: "j1", customerId: "c1", contractValueCents: 2400000 });
  expect(store.audits.some((a) => a.event.type === "job.approved")).toBe(true);
});

it("publishPaymentReceived records a received audit and no escalation", async () => {
  const store = new InMemoryStore();
  const o = new Orchestrator({ store });
  await publishPaymentReceived(o, { tenantId: T, invoiceId: "i1", amountCents: 100 });
  expect(store.audits.some((a) => a.event.type === "payment.received")).toBe(true);
  expect(await store.listEscalations(T)).toEqual([]);
});

it("publishFirstTouch records exactly one received event and is idempotent", async () => {
  const store = new InMemoryStore();
  const o = new Orchestrator({ store });
  await publishFirstTouch(o, { tenantId: T, leadId: "lead-1", channel: "sms", latencySeconds: 10 });
  expect(store.audits.filter((a) => a.event.type === "lead.first_touch" && a.outcome === "received").length).toBe(1);
  await publishFirstTouch(o, { tenantId: T, leadId: "lead-1", channel: "sms", latencySeconds: 10 });
  expect(store.audits.filter((a) => a.event.type === "lead.first_touch" && a.outcome === "received").length).toBe(1);
});

it("publishLeadAssigned records exactly one received event and is idempotent", async () => {
  const store = new InMemoryStore();
  const o = new Orchestrator({ store });
  await publishLeadAssigned(o, { tenantId: T, leadId: "lead-2", userId: "u1", repId: "rep-1", territory: "east" });
  expect(store.audits.filter((a) => a.event.type === "lead.assigned" && a.outcome === "received").length).toBe(1);
  await publishLeadAssigned(o, { tenantId: T, leadId: "lead-2", userId: "u1", repId: "rep-1", territory: "east" });
  expect(store.audits.filter((a) => a.event.type === "lead.assigned" && a.outcome === "received").length).toBe(1);
});

it("publishReminderSent records exactly one received event and is idempotent", async () => {
  const store = new InMemoryStore();
  const o = new Orchestrator({ store });
  await publishReminderSent(o, { tenantId: T, leadId: "lead-3", appointmentId: "appt-1", offset: "24h", channel: "sms" });
  expect(store.audits.filter((a) => a.event.type === "reminder.sent" && a.outcome === "received").length).toBe(1);
  await publishReminderSent(o, { tenantId: T, leadId: "lead-3", appointmentId: "appt-1", offset: "24h", channel: "sms" });
  expect(store.audits.filter((a) => a.event.type === "reminder.sent" && a.outcome === "received").length).toBe(1);
});

it("publishDripStepSent records exactly one received event and is idempotent", async () => {
  const store = new InMemoryStore();
  const o = new Orchestrator({ store });
  await publishDripStepSent(o, { tenantId: T, customerId: "cust-1", step: 2, channel: "sms" });
  expect(store.audits.filter((a) => a.event.type === "drip.step.sent" && a.outcome === "received").length).toBe(1);
  await publishDripStepSent(o, { tenantId: T, customerId: "cust-1", step: 2, channel: "sms" });
  expect(store.audits.filter((a) => a.event.type === "drip.step.sent" && a.outcome === "received").length).toBe(1);
});

it("publishMessageInbound records exactly one received event and is idempotent", async () => {
  const store = new InMemoryStore();
  const o = new Orchestrator({ store });
  await publishMessageInbound(o, { tenantId: T, messageSid: "SM1", customerId: "cust-1", channel: "sms", isOptOut: false });
  expect(store.audits.filter((a) => a.event.type === "message.inbound" && a.outcome === "received").length).toBe(1);
  await publishMessageInbound(o, { tenantId: T, messageSid: "SM1", customerId: "cust-1", channel: "sms", isOptOut: false });
  expect(store.audits.filter((a) => a.event.type === "message.inbound" && a.outcome === "received").length).toBe(1);
});

it("publishContactOptedOut records exactly one received event and is idempotent", async () => {
  const store = new InMemoryStore();
  const o = new Orchestrator({ store });
  await publishContactOptedOut(o, { tenantId: T, channel: "sms", phoneOrContactId: "+15551234567", reason: "stop" });
  expect(store.audits.filter((a) => a.event.type === "contact.opted_out" && a.outcome === "received").length).toBe(1);
  await publishContactOptedOut(o, { tenantId: T, channel: "sms", phoneOrContactId: "+15551234567", reason: "stop" });
  expect(store.audits.filter((a) => a.event.type === "contact.opted_out" && a.outcome === "received").length).toBe(1);
});

it("publishCallMissed records exactly one received event and is idempotent", async () => {
  const store = new InMemoryStore();
  const o = new Orchestrator({ store });
  const occurredAt = "2026-07-26T10:00:00.000Z";
  await publishCallMissed(o, { tenantId: T, fromNumber: "+1a", toNumber: "+1b", occurredAt });
  expect(store.audits.filter((a) => a.event.type === "call.missed" && a.outcome === "received").length).toBe(1);
  await publishCallMissed(o, { tenantId: T, fromNumber: "+1a", toNumber: "+1b", occurredAt });
  expect(store.audits.filter((a) => a.event.type === "call.missed" && a.outcome === "received").length).toBe(1);
});
