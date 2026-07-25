import { it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { makeEvent } from "@savvy/orchestrator";
import { adminDb, tenant } from "../index";
import { orchestratorEvent, orchestratorEscalation } from "../schema/orchestrator";
import { DrizzleOrchestratorStore } from "./store";

let tenantId: string;

beforeAll(async () => {
  tenantId = randomUUID();
  await adminDb.insert(tenant).values({ id: tenantId, name: "Orch-Test Co", publicKey: `orch-${tenantId.slice(0, 8)}` });
});

afterAll(async () => {
  await adminDb.delete(orchestratorEscalation).where(eq(orchestratorEscalation.tenantId, tenantId));
  await adminDb.delete(orchestratorEvent).where(eq(orchestratorEvent.tenantId, tenantId));
  await adminDb.delete(tenant).where(eq(tenant.id, tenantId));
});

const ev = () => makeEvent({ type: "lead.created", source: "savvy", tenantId, correlationId: "corr-1", idempotencyKey: `idem-${randomUUID()}`, payload: { leadId: "l1", customerId: "c1" } });

it("insertEventIfNew is true then false for the same idempotencyKey", async () => {
  const store = new DrizzleOrchestratorStore();
  const e = ev();
  expect(await store.insertEventIfNew(e)).toBe(true);
  expect(await store.insertEventIfNew(e)).toBe(false);
});

it("appendAudit + traceByCorrelation round-trips", async () => {
  const store = new DrizzleOrchestratorStore();
  const e = ev();
  await store.insertEventIfNew(e);
  await store.appendAudit({ event: e, agent: "comms", outcome: "handled", emitted: ["lead.first_touch"] });
  const trace = await store.traceByCorrelation(tenantId, "corr-1");
  expect(trace.some((a) => a.agent === "comms" && a.emitted.includes("lead.first_touch"))).toBe(true);
});

it("recordEscalation + listEscalations round-trips", async () => {
  const e = ev();
  const store = new DrizzleOrchestratorStore();
  await store.recordEscalation({ tenantId, correlationId: "corr-1", eventId: e.id, eventType: "estimate.approved", ruleId: "low-margin", severity: "high", reason: "18%", notify: ["arrington"] });
  const list = await store.listEscalations(tenantId);
  expect(list.some((x) => x.ruleId === "low-margin")).toBe(true);
});

it("traceByCorrelation returns rows ordered by createdAt (insertion order shuffled)", async () => {
  const store = new DrizzleOrchestratorStore();
  const corr = `corr-order-${randomUUID()}`;
  const base = new Date("2026-01-01T00:00:00.000Z").getTime();
  // Insert out of chronological order: newest first, oldest second, middle last.
  await adminDb.insert(orchestratorEvent).values([
    { tenantId, eventId: "e3", eventType: "lead.created", source: "savvy", correlationId: corr, idempotencyKey: `k-${randomUUID()}`, agent: "third", outcome: "handled", emitted: [], payload: {}, createdAt: new Date(base + 2000) },
    { tenantId, eventId: "e1", eventType: "lead.created", source: "savvy", correlationId: corr, idempotencyKey: `k-${randomUUID()}`, agent: "first", outcome: "handled", emitted: [], payload: {}, createdAt: new Date(base + 0) },
    { tenantId, eventId: "e2", eventType: "lead.created", source: "savvy", correlationId: corr, idempotencyKey: `k-${randomUUID()}`, agent: "second", outcome: "handled", emitted: [], payload: {}, createdAt: new Date(base + 1000) },
  ]);
  const trace = await store.traceByCorrelation(tenantId, corr);
  expect(trace.map((a) => a.agent)).toEqual(["first", "second", "third"]);
});

it("listEscalations returns rows ordered by createdAt (insertion order shuffled)", async () => {
  const store = new DrizzleOrchestratorStore();
  const corr = `esc-order-${randomUUID()}`;
  const base = new Date("2026-02-01T00:00:00.000Z").getTime();
  await adminDb.insert(orchestratorEscalation).values([
    { tenantId, ruleId: "third", severity: "high", reason: "r", notify: [], eventId: "e3", eventType: "review.posted", correlationId: corr, createdAt: new Date(base + 2000) },
    { tenantId, ruleId: "first", severity: "high", reason: "r", notify: [], eventId: "e1", eventType: "review.posted", correlationId: corr, createdAt: new Date(base + 0) },
    { tenantId, ruleId: "second", severity: "high", reason: "r", notify: [], eventId: "e2", eventType: "review.posted", correlationId: corr, createdAt: new Date(base + 1000) },
  ]);
  const list = (await store.listEscalations(tenantId)).filter((x) => x.correlationId === corr);
  expect(list.map((x) => x.ruleId)).toEqual(["first", "second", "third"]);
});
