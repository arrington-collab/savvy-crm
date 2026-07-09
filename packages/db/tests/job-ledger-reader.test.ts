import { describe, it, expect } from "vitest";
import { adminDb, withTenant, tenant, customer, property, lead, job, jobTask, leadTask, tenantTaskConfig, getJobLedger } from "../src";

describe("getJobLedger", () => {
  it("includes lead_task history (origin=lead) and applies effective mode override", async () => {
    const [t] = await adminDb.insert(tenant).values({ name: "lr", publicKey: `k-${Date.now()}-${Math.random()}`, clerkOrgId: `o-${Date.now()}-${Math.random()}` }).returning();
    const tid = t!.id;
    const { jid } = await withTenant(tid, async (tx) => {
      const [c] = await tx.insert(customer).values({ tenantId: tid, name: "C" }).returning({ id: customer.id });
      const [p] = await tx.insert(property).values({ tenantId: tid, customerId: c!.id, address: "1 St" }).returning({ id: property.id });
      const [l] = await tx.insert(lead).values({ tenantId: tid, customerId: c!.id, propertyId: p!.id, source: "test" }).returning({ id: lead.id });
      const [j] = await tx.insert(job).values({ tenantId: tid, customerId: c!.id, propertyId: p!.id, leadId: l!.id, type: "retail", stage: "inspected" }).returning({ id: job.id });
      // a job task (per_job registry id, e.g. an inspection-phase task) + a lead task
      await tx.insert(jobTask).values({ tenantId: tid, jobId: j!.id, taskId: 60, status: "pending" });
      await tx.insert(leadTask).values({ tenantId: tid, leadId: l!.id, taskId: 18, status: "done" });
      // override task 60 to manual for this tenant
      await tx.insert(tenantTaskConfig).values({ tenantId: tid, taskId: 60, mode: "manual" });
      return { jid: j!.id };
    });
    const rows = await getJobLedger(tid, jid);
    expect(rows.some((r) => r.origin === "lead" && r.taskId === 18)).toBe(true);
    const job60 = rows.find((r) => r.taskId === 60 && r.origin === "job");
    expect(job60?.mode).toBe("manual");
  });
});
