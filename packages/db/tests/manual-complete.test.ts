import { describe, it, expect } from "vitest";
import { adminDb, withTenant, tenant, user, customer, property, job, jobTask, auditLog, eq, and } from "../src";
import { completeJobTaskManually } from "../src/lifecycle/job-tasks";

describe("completeJobTaskManually", () => {
  it("ticks a manual task to done with owner + audit", async () => {
    const [t] = await adminDb.insert(tenant).values({ name: "mc", publicKey: `k-${Date.now()}-${Math.random()}`, clerkOrgId: `o-${Date.now()}-${Math.random()}` }).returning();
    const tid = t!.id;
    const [u] = await adminDb.insert(user).values({ tenantId: tid, name: "Doer", email: `doer-${Date.now()}@x.co` }).returning({ id: user.id });
    const uid = u!.id;
    const { jid } = await withTenant(tid, async (tx) => {
      const [c] = await tx.insert(customer).values({ tenantId: tid, name: "C" }).returning({ id: customer.id });
      const [p] = await tx.insert(property).values({ tenantId: tid, customerId: c!.id, address: "1 St" }).returning({ id: property.id });
      const [j] = await tx.insert(job).values({ tenantId: tid, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "production" }).returning({ id: job.id });
      // task 43 is Manual (Homeowner inspection walkthrough); default_mode manual
      await tx.insert(jobTask).values({ tenantId: tid, jobId: j!.id, taskId: 43, status: "pending" });
      await completeJobTaskManually(tx, { tenantId: tid, jobId: j!.id, taskId: 43, userId: uid, done: true });
      return { jid: j!.id };
    });
    const [row] = await adminDb.select({ status: jobTask.status, owner: jobTask.owner }).from(jobTask).where(and(eq(jobTask.jobId, jid), eq(jobTask.taskId, 43)));
    expect(row).toMatchObject({ status: "done", owner: uid });
    const audits = await adminDb.select({ action: auditLog.action, userId: auditLog.userId }).from(auditLog).where(eq(auditLog.entityId, jid));
    const completed = audits.find((a) => a.action === "task_completed");
    expect(completed).toBeDefined();
    expect(completed!.userId).toBe(uid);
  });
  it("rejects a non-manual task", async () => {
    const [t] = await adminDb.insert(tenant).values({ name: "mc2", publicKey: `k-${Date.now()}-${Math.random()}`, clerkOrgId: `o-${Date.now()}-${Math.random()}` }).returning();
    const tid = t!.id;
    await expect(withTenant(tid, async (tx) => {
      const [c] = await tx.insert(customer).values({ tenantId: tid, name: "C" }).returning({ id: customer.id });
      const [p] = await tx.insert(property).values({ tenantId: tid, customerId: c!.id, address: "1 St" }).returning({ id: property.id });
      const [j] = await tx.insert(job).values({ tenantId: tid, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "production" }).returning({ id: job.id });
      await tx.insert(jobTask).values({ tenantId: tid, jobId: j!.id, taskId: 141, status: "pending" }); // full_auto
      await completeJobTaskManually(tx, { tenantId: tid, jobId: j!.id, taskId: 141, userId: "u", done: true });
    })).rejects.toThrow("not_manual");
  });
});
