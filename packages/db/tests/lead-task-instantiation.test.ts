import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { adminDb, adminPool } from "../src/admin-client.js";
import { withTenant } from "../src/tenant.js";
import { instantiateLeadTasks, markLeadTaskDone, backfillLeadTasks } from "../src/index.js";
import { tenant, customer, property, lead, taskRegistry, tenantTaskConfig, leadTask } from "../src/schema/index.js";

// Synthetic per_lead registry tasks (ids well above the 212 real ones).
const A = 9101; // per_lead, all
const JOB = 9102; // per_job (wrong scope — never on a lead)
const DEP = 9103; // per_lead, depends_on [A]
const OFF = 9104; // per_lead, disabled via tenant_task_config
const TYPED = 9105; // per_lead but job-type-restricted — leads have no type, so still applies
const SYN = [A, JOB, DEP, OFF, TYPED];

let tenantId: string;
let leadId: string;

const base = (id: number) => ({ id, name: `synl-${id}`, phase: 2, defaultOwner: "HUMAN" as const, defaultMode: "full_auto" as const });
const synRows = (lid: string) => adminDb.select().from(leadTask).where(and(eq(leadTask.leadId, lid), inArray(leadTask.taskId, SYN)));
const mkLead = async (status: "new" | "lost") => {
  const [c] = await adminDb.insert(customer).values({ tenantId, name: `HO-${status}-${Date.now()}` }).returning();
  const [p] = await adminDb.insert(property).values({ tenantId, customerId: c!.id, address: `addr-${Date.now()}` }).returning();
  const [l] = await adminDb.insert(lead).values({ tenantId, customerId: c!.id, propertyId: p!.id, status }).returning();
  return l!.id;
};

beforeAll(async () => {
  const [t] = await adminDb.insert(tenant).values({ name: "LT Co", publicKey: `lt-${Date.now()}`, clerkOrgId: `org_lt_${Date.now()}` }).returning();
  tenantId = t!.id;
  leadId = await mkLead("new");

  await adminDb.insert(taskRegistry).values([
    { ...base(A), slug: `synl.${A}`, scope: "per_lead", appliesTo: {} },
    { ...base(JOB), slug: `synl.${JOB}`, scope: "per_job", appliesTo: {} },
    { ...base(DEP), slug: `synl.${DEP}`, scope: "per_lead", appliesTo: {}, dependsOn: [A] },
    { ...base(OFF), slug: `synl.${OFF}`, scope: "per_lead", appliesTo: {} },
    { ...base(TYPED), slug: `synl.${TYPED}`, scope: "per_lead", appliesTo: { job_types: ["insurance"] } },
  ]);
  await adminDb.insert(tenantTaskConfig).values({ tenantId, taskId: OFF, enabled: false });
});

afterAll(async () => {
  await adminDb.delete(leadTask).where(inArray(leadTask.taskId, SYN));
  await adminDb.delete(tenantTaskConfig).where(inArray(tenantTaskConfig.taskId, SYN));
  await adminDb.delete(taskRegistry).where(inArray(taskRegistry.id, SYN));
  await adminPool.end();
});

describe("instantiateLeadTasks", () => {
  it("instantiates enabled per_lead tasks (ignoring job-type), with computed blocked_by", async () => {
    await withTenant(tenantId, (tx) => instantiateLeadTasks(tx, { tenantId, leadId }));
    const rows = await synRows(leadId);
    const byId = Object.fromEntries(rows.map((r) => [r.taskId, r]));
    expect(Object.keys(byId).map(Number).sort((a, b) => a - b)).toEqual([A, DEP, TYPED]); // JOB (scope), OFF (disabled) excluded
    expect(byId[A]!.blockedBy).toEqual([]);
    expect(byId[DEP]!.blockedBy).toEqual([A]);
  });

  it("is idempotent", async () => {
    await withTenant(tenantId, (tx) => instantiateLeadTasks(tx, { tenantId, leadId }));
    expect(await synRows(leadId)).toHaveLength(3);
  });
});

describe("markLeadTaskDone", () => {
  it("records done + evidence and unblocks dependents", async () => {
    await markLeadTaskDone(tenantId, { leadId, taskId: A, owner: "NOVA", evidence: { type: "test", ref: "xyz" } });
    const byId = Object.fromEntries((await synRows(leadId)).map((r) => [r.taskId, r]));
    expect(byId[A]!.status).toBe("done");
    expect(byId[A]!.evidence).toEqual({ type: "test", ref: "xyz" });
    expect(byId[A]!.completedAt).not.toBeNull();
    expect(byId[DEP]!.blockedBy).toEqual([]);
  });
});

describe("backfillLeadTasks", () => {
  it("instantiates for active leads, skipping terminal (won/lost) ones", async () => {
    const activeLead = await mkLead("new");
    const lostLead = await mkLead("lost");
    await backfillLeadTasks(tenantId);
    expect((await synRows(activeLead)).map((r) => r.taskId).sort((a, b) => a - b)).toEqual([A, DEP, TYPED]);
    expect(await synRows(lostLead)).toHaveLength(0);
  });
});
