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
