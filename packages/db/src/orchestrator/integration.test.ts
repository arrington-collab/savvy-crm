import { it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { Orchestrator, publishContractSigned, publishLeadCreated } from "@savvy/orchestrator";
import { adminDb, tenant } from "../index";
import { orchestratorEvent, orchestratorEscalation } from "../schema/orchestrator";
import { DrizzleOrchestratorStore } from "./store";

let tenantId: string;

beforeAll(async () => {
  tenantId = randomUUID();
  await adminDb.insert(tenant).values({ id: tenantId, name: "Orch-Int Co", publicKey: `oi-${tenantId.slice(0, 8)}` });
});

afterAll(async () => {
  await adminDb.delete(orchestratorEscalation).where(eq(orchestratorEscalation.tenantId, tenantId));
  await adminDb.delete(orchestratorEvent).where(eq(orchestratorEvent.tenantId, tenantId));
  await adminDb.delete(tenant).where(eq(tenant.id, tenantId));
});

it("a published lead persists its whole chain to the Drizzle store", async () => {
  const o = new Orchestrator({ store: new DrizzleOrchestratorStore() });
  await publishLeadCreated(o, { tenantId, leadId: `l-${randomUUID()}`, customerId: "c1", source: "web" });
  const rows = await adminDb.select().from(orchestratorEvent).where(eq(orchestratorEvent.tenantId, tenantId));
  const types = rows.map((r) => r.eventType);
  expect(types).toContain("lead.created");
  expect(types).toContain("lead.qualified");
  expect(types).toContain("lead.assigned");
});

it("a re-published contract with the same key does not double-process", async () => {
  const o = new Orchestrator({ store: new DrizzleOrchestratorStore() });
  const jobId = `j-${randomUUID()}`;
  await publishContractSigned(o, { tenantId, jobId, customerId: "c1", contractValueCents: 2400000 });
  const before = (await adminDb.select().from(orchestratorEvent).where(eq(orchestratorEvent.tenantId, tenantId))).length;
  await publishContractSigned(o, { tenantId, jobId, customerId: "c1", contractValueCents: 2400000 }); // same idem key
  const after = (await adminDb.select().from(orchestratorEvent).where(eq(orchestratorEvent.tenantId, tenantId))).length;
  expect(after).toBe(before);
});
