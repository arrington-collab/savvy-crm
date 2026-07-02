import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { adminDb, adminPool } from "../src/admin-client.js";
import { getJobLedger } from "../src/index.js";
import { tenant, customer, property, job, taskRegistry, jobTask, taskHealth } from "../src/schema/index.js";

// L1 is phase 2 (earlier), L2 is phase 9 (later) — asserts phase ordering.
const L1 = 9701, L2 = 9702;
const SYN = [L1, L2];
let tenantId: string;
let jobA: string; // has a ledger
let jobB: string; // empty

const reg = (id: number, phase: number, name: string) => ({ id, slug: `jl.${id}`, name, phase, defaultOwner: "HUMAN" as const, defaultMode: "full_auto" as const, scope: "per_job" as const });

beforeAll(async () => {
  const [t] = await adminDb.insert(tenant).values({ name: "JL Co", publicKey: `jl-${Date.now()}`, clerkOrgId: `org_jl_${Date.now()}` }).returning();
  tenantId = t!.id;
  const [c] = await adminDb.insert(customer).values({ tenantId, name: "HO" }).returning();
  const [p] = await adminDb.insert(property).values({ tenantId, customerId: c!.id, address: "1 Main" }).returning();
  const [ja] = await adminDb.insert(job).values({ tenantId, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "billing" }).returning();
  const [jb] = await adminDb.insert(job).values({ tenantId, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "lead" }).returning();
  jobA = ja!.id; jobB = jb!.id;

  await adminDb.insert(taskRegistry).values([reg(L1, 2, "Booking"), reg(L2, 9, "Invoice generation")]);
  await adminDb.insert(jobTask).values([
    { tenantId, jobId: jobA, taskId: L2, status: "verified", owner: "finance", evidence: { type: "invoice", ref: "inv-1" }, verifiedAt: new Date(), blockedBy: [] },
    { tenantId, jobId: jobA, taskId: L1, status: "done", owner: "scheduling", evidence: { type: "communication", ref: "comm-1" }, blockedBy: [9700] },
  ]);
  // L2 has health; L1 has none -> healthStatus null.
  await adminDb.insert(taskHealth).values({ tenantId, taskId: L2, status: "green", effectiveMode: "full_auto" });
});

afterAll(async () => {
  await adminDb.delete(jobTask).where(eq(jobTask.tenantId, tenantId));
  await adminDb.delete(taskHealth).where(eq(taskHealth.tenantId, tenantId));
  await adminDb.delete(taskRegistry).where(inArray(taskRegistry.id, SYN));
  await adminDb.delete(job).where(eq(job.tenantId, tenantId));
  await adminDb.delete(property).where(eq(property.tenantId, tenantId));
  await adminDb.delete(customer).where(eq(customer.tenantId, tenantId));
  await adminDb.delete(tenant).where(eq(tenant.id, tenantId));
  await adminPool.end();
});

describe("getJobLedger", () => {
  it("returns the job's ledger rows joined to registry + health, ordered by phase then id", async () => {
    const rows = await getJobLedger(tenantId, jobA);
    expect(rows.map((r) => r.taskId)).toEqual([L1, L2]); // phase 2 before phase 9

    const l1 = rows[0]!;
    expect(l1.name).toBe("Booking");
    expect(l1.phase).toBe(2);
    expect(l1.status).toBe("done");
    expect(l1.owner).toBe("scheduling");
    expect(l1.evidence).toEqual({ type: "communication", ref: "comm-1" });
    expect(l1.blockedBy).toEqual([9700]);
    expect(l1.healthStatus).toBeNull(); // no task_health row

    const l2 = rows[1]!;
    expect(l2.name).toBe("Invoice generation");
    expect(l2.status).toBe("verified");
    expect(l2.evidence).toEqual({ type: "invoice", ref: "inv-1" });
    expect(l2.healthStatus).toBe("green");
    expect(l2.verifiedAt).not.toBeNull();
  });

  it("returns an empty array for a job with no ledger rows", async () => {
    expect(await getJobLedger(tenantId, jobB)).toEqual([]);
  });
});
