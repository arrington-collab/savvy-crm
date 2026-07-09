import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { evidenceChecks } from "@savvy/core";
import type { EvidenceCtx } from "@savvy/core";
import { adminDb, adminPool } from "../src/admin-client.js";
import { tenant, customer, property, job, jobTask } from "../src/schema/index.js";

// A job ledger must contain ONLY per_job tasks. This suite proves the
// job.scope_integrity invariant flags a job_task that points at a
// non-per_job registry task (a tenant/lead-scoped task wrongly instantiated
// on a job), and stays silent for a clean tenant whose job_task rows are
// all genuinely per_job.

let cleanId: string;
let badId: string;

const WINDOW = { start: new Date(Date.now() - 86_400_000), end: new Date(Date.now() + 86_400_000) };

const run = (checkKey: string, tenantId: string) => {
  const ctx: EvidenceCtx = { tenantId, db: adminPool, params: {}, window: WINDOW };
  return evidenceChecks[checkKey]!(ctx);
};

beforeAll(async () => {
  const [c] = await adminDb.insert(tenant).values({ name: "SI-clean", publicKey: `si-clean-${Date.now()}`, clerkOrgId: `org_si_clean_${Date.now()}` }).returning();
  const [b] = await adminDb.insert(tenant).values({ name: "SI-bad", publicKey: `si-bad-${Date.now()}`, clerkOrgId: `org_si_bad_${Date.now()}` }).returning();
  cleanId = c!.id;
  badId = b!.id;

  const mkJob = async (tid: string) => {
    const [cust] = await adminDb.insert(customer).values({ tenantId: tid, name: "si" }).returning();
    const [p] = await adminDb.insert(property).values({ tenantId: tid, customerId: cust!.id, address: `si-${tid}` }).returning();
    const [j] = await adminDb.insert(job).values({ tenantId: tid, customerId: cust!.id, propertyId: p!.id }).returning();
    return j!.id;
  };

  // CLEAN: job_task references task 60 (Financing application submission,
  // phase 4 -> per_job by the phase heuristic, no override). Legitimate.
  const cleanJobId = await mkJob(cleanId);
  await adminDb.insert(jobTask).values({ tenantId: cleanId, jobId: cleanJobId, taskId: 60, status: "pending" });

  // BAD: job_task references task 14 (SEO content & blog publishing), which
  // Task 1's SCOPE_OVERRIDE re-scopes to per_tenant_recurring. Instantiating
  // it on a job is a scope-integrity violation.
  const badJobId = await mkJob(badId);
  await adminDb.insert(jobTask).values({ tenantId: badId, jobId: badJobId, taskId: 14, status: "pending" });
});

afterAll(async () => {
  for (const tid of [cleanId, badId]) {
    await adminDb.delete(jobTask).where(eq(jobTask.tenantId, tid));
    await adminDb.delete(job).where(eq(job.tenantId, tid));
    await adminDb.delete(property).where(eq(property.tenantId, tid));
    await adminDb.delete(customer).where(eq(customer.tenantId, tid));
    await adminDb.delete(tenant).where(eq(tenant.id, tid));
  }
  await adminPool.end();
});

describe("job.scope_integrity", () => {
  it("passes for a job whose task_ids are all genuinely per_job", async () => {
    const r = await run("job.scope_integrity", cleanId);
    expect(r.status).toBe("pass");
    expect(r.refs).toEqual([]);
  });

  it("flags a per_tenant_recurring task wrongly instantiated on a job", async () => {
    const r = await run("job.scope_integrity", badId);
    expect(r.status).toBe("fail");
    expect(r.refs.length).toBeGreaterThanOrEqual(1);
    expect(r.refs[0]!.type).toBe("job_task");
  });

  it("is tenant-scoped (bad tenant's violation never surfaces for clean)", async () => {
    const r = await run("job.scope_integrity", cleanId);
    expect(r.status).toBe("pass");
  });
});
