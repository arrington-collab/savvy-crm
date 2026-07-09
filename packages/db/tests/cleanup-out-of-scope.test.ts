import { describe, it, expect } from "vitest";
import { adminDb, withTenant, tenant, customer, property, job, jobTask, eq, and } from "../src";
import { cleanupOutOfScopeTasks } from "../src/scripts/cleanup-out-of-scope-tasks";

describe("cleanupOutOfScopeTasks", () => {
  it("removes a per_tenant_recurring task wrongly on a job, keeps per_job", async () => {
    const [t] = await adminDb.insert(tenant).values({ name: "cl", publicKey: `k-${Date.now()}-${Math.random()}`, clerkOrgId: `o-${Date.now()}-${Math.random()}` }).returning();
    const tid = t!.id;
    const jid = await withTenant(tid, async (tx) => {
      const [c] = await tx.insert(customer).values({ tenantId: tid, name: "C" }).returning({ id: customer.id });
      const [p] = await tx.insert(property).values({ tenantId: tid, customerId: c!.id, address: "1 St" }).returning({ id: property.id });
      const [j] = await tx.insert(job).values({ tenantId: tid, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "lead" }).returning({ id: job.id });
      await tx.insert(jobTask).values({ tenantId: tid, jobId: j!.id, taskId: 14, status: "pending" }); // per_tenant_recurring (bad)
      await tx.insert(jobTask).values({ tenantId: tid, jobId: j!.id, taskId: 60, status: "pending" }); // per_job (keep)
      return j!.id;
    });
    const res = await cleanupOutOfScopeTasks({ dryRun: false });
    expect(res.jobTaskDeleted).toBeGreaterThanOrEqual(1);
    const remaining = await adminDb.select({ taskId: jobTask.taskId }).from(jobTask).where(eq(jobTask.jobId, jid));
    expect(remaining.map((r) => r.taskId).sort()).toEqual([60]);
    // idempotent
    const res2 = await cleanupOutOfScopeTasks({ dryRun: false });
    const after = await adminDb.select({ taskId: jobTask.taskId }).from(jobTask).where(eq(jobTask.jobId, jid));
    expect(after.map((r) => r.taskId)).toEqual([60]);
  });
});
