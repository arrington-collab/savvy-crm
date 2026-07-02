import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { adminDb, adminPool } from "../src/admin-client.js";
import { withTenant } from "../src/tenant.js";
import { instantiateJobTasks, markJobTaskDone, backfillJobTasks, convertLeadToJob } from "../src/index.js";
import {
  tenant, user, customer, property, lead, job, taskRegistry, tenantTaskConfig, jobTask,
} from "../src/schema/index.js";

// Synthetic registry tasks (ids well above the 212 real ones) let us assert
// filtering + blocked_by deterministically without depending on seed state.
const A = 9001; // per_job, all types
const INS = 9002; // per_job, insurance-only
const LEAD = 9003; // per_lead (wrong scope — never instantiated on a job)
const DEP = 9004; // per_job, all types, depends_on [A]
const OFF = 9005; // per_job, all types, but disabled via tenant_task_config
const SYN = [A, INS, LEAD, DEP, OFF];

let tenantId: string;
let jobId: string;
let userId: string;

const base = (id: number) => ({ id, name: `syn-${id}`, phase: 7, defaultOwner: "HUMAN" as const, defaultMode: "full_auto" as const });
const synRows = (jobIdArg: string) =>
  adminDb.select().from(jobTask).where(and(eq(jobTask.jobId, jobIdArg), inArray(jobTask.taskId, SYN)));

beforeAll(async () => {
  const [t] = await adminDb.insert(tenant).values({ name: "JT Co", publicKey: `jt-${Date.now()}`, clerkOrgId: `org_jt_${Date.now()}` }).returning();
  tenantId = t!.id;
  const [u] = await adminDb.insert(user).values({ tenantId, role: "rep", name: "Rep", email: `rep-${Date.now()}@x.com` }).returning();
  userId = u!.id;
  const [c] = await adminDb.insert(customer).values({ tenantId, name: "HO", phone: "+16025551234" }).returning();
  const [p] = await adminDb.insert(property).values({ tenantId, customerId: c!.id, address: "1 Main" }).returning();
  const [j] = await adminDb.insert(job).values({ tenantId, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "lead" }).returning();
  jobId = j!.id;

  await adminDb.insert(taskRegistry).values([
    { ...base(A), slug: `syn.${A}`, scope: "per_job", appliesTo: {} },
    { ...base(INS), slug: `syn.${INS}`, scope: "per_job", appliesTo: { job_types: ["insurance"] } },
    { ...base(LEAD), slug: `syn.${LEAD}`, scope: "per_lead", appliesTo: {} },
    { ...base(DEP), slug: `syn.${DEP}`, scope: "per_job", appliesTo: {}, dependsOn: [A] },
    { ...base(OFF), slug: `syn.${OFF}`, scope: "per_job", appliesTo: {} },
  ]);
  // Disable OFF for this tenant.
  await adminDb.insert(tenantTaskConfig).values({ tenantId, taskId: OFF, enabled: false });
});

afterAll(async () => {
  await adminDb.delete(jobTask).where(inArray(jobTask.taskId, SYN));
  await adminDb.delete(tenantTaskConfig).where(inArray(tenantTaskConfig.taskId, SYN));
  await adminDb.delete(taskRegistry).where(inArray(taskRegistry.id, SYN));
  await adminPool.end();
});

describe("instantiateJobTasks", () => {
  it("instantiates only per_job tasks matching job type + tenant config, with computed blocked_by", async () => {
    await withTenant(tenantId, (tx) => instantiateJobTasks(tx, { tenantId, jobId, jobType: "retail" }));
    const rows = await synRows(jobId);
    const byId = Object.fromEntries(rows.map((r) => [r.taskId, r]));
    expect(Object.keys(byId).map(Number).sort((a, b) => a - b)).toEqual([A, DEP]); // INS (type), LEAD (scope), OFF (disabled) excluded
    expect(byId[A]!.status).toBe("pending");
    expect(byId[A]!.blockedBy).toEqual([]);
    expect(byId[DEP]!.blockedBy).toEqual([A]); // depends_on A, not yet done
  });

  it("is idempotent — re-instantiating does not duplicate", async () => {
    await withTenant(tenantId, (tx) => instantiateJobTasks(tx, { tenantId, jobId, jobType: "retail" }));
    const rows = await synRows(jobId);
    expect(rows).toHaveLength(2); // still just A + DEP
  });
});

describe("markJobTaskDone", () => {
  it("records done + evidence and unblocks dependents", async () => {
    await markJobTaskDone(tenantId, { jobId, taskId: A, owner: "NOVA", evidence: { type: "test", ref: "abc" } });
    const rows = await synRows(jobId);
    const byId = Object.fromEntries(rows.map((r) => [r.taskId, r]));
    expect(byId[A]!.status).toBe("done");
    expect(byId[A]!.owner).toBe("NOVA");
    expect(byId[A]!.evidence).toEqual({ type: "test", ref: "abc" });
    expect(byId[A]!.completedAt).not.toBeNull();
    expect(byId[DEP]!.blockedBy).toEqual([]); // A removed from blocked_by
  });
});

describe("backfillJobTasks", () => {
  it("instantiates for active jobs missing tasks, skipping terminal-stage jobs", async () => {
    const [c] = await adminDb.insert(customer).values({ tenantId, name: "HO2" }).returning();
    const [p] = await adminDb.insert(property).values({ tenantId, customerId: c!.id, address: "2 Main" }).returning();
    const [active] = await adminDb.insert(job).values({ tenantId, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "production" }).returning();
    const [done] = await adminDb.insert(job).values({ tenantId, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "complete" }).returning();

    await backfillJobTasks(tenantId);

    expect((await synRows(active!.id)).map((r) => r.taskId).sort((a, b) => a - b)).toEqual([A, DEP]);
    expect(await synRows(done!.id)).toHaveLength(0); // terminal stage skipped
  });
});

describe("wired into convertLeadToJob", () => {
  it("instantiates the job ledger when a lead converts to a job", async () => {
    const [c] = await adminDb.insert(customer).values({ tenantId, name: "Converter", phone: "+16025559876" }).returning();
    const [p] = await adminDb.insert(property).values({ tenantId, customerId: c!.id, address: "3 Main" }).returning();
    const [l] = await adminDb.insert(lead).values({ tenantId, customerId: c!.id, propertyId: p!.id, status: "new", assignedUserId: userId }).returning();

    const { jobId: convertedJobId } = await convertLeadToJob({ tenantId, leadId: l!.id });

    const rows = await synRows(convertedJobId);
    expect(rows.map((r) => r.taskId).sort((a, b) => a - b)).toEqual([A, DEP]);
  });
});
