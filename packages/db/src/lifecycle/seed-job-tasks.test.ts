import { describe, it, expect } from "vitest";
import { adminDb, withTenant, tenant, customer, property, job, jobChecklistItem, eq } from "..";
import { seedJobTasks } from "./seed-job-tasks";

describe("seedJobTasks scope", () => {
  it("does not seed tenant-recurring marketing tasks onto a job", async () => {
    const [t] = await adminDb
      .insert(tenant)
      .values({ name: "seed", publicKey: `k-${Date.now()}-${Math.random()}`, clerkOrgId: `o-${Date.now()}-${Math.random()}` })
      .returning();
    const tid = t!.id;
    const jid = await withTenant(tid, async (tx) => {
      const [c] = await tx.insert(customer).values({ tenantId: tid, name: "C" }).returning({ id: customer.id });
      const [p] = await tx.insert(property).values({ tenantId: tid, customerId: c!.id, address: "1 St" }).returning({ id: property.id });
      const [j] = await tx.insert(job).values({ tenantId: tid, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "lead" }).returning({ id: job.id });
      await seedJobTasks(tx as never, { id: j!.id, tenantId: tid, type: "retail" });
      return j!.id;
    });
    const rows = await adminDb.select({ title: jobChecklistItem.title }).from(jobChecklistItem).where(eq(jobChecklistItem.jobId, jid));
    const titles = rows.map((r) => r.title);
    for (const marketing of ["SEO content & blog publishing", "Google Business Profile management", "Website form submission capture", "Google/Facebook ad lead capture"]) {
      expect(titles, marketing).not.toContain(marketing);
    }
  });
});
