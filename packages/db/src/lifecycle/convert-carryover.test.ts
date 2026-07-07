import { describe, it, expect } from "vitest";
import { withTenant } from "../tenant.js";
import { adminDb, tenant, customer, property, lead, job, user, document, eq } from "../index.js";
import { convertLeadToJob } from "./appointments.js";

async function seedLead() {
  const [t] = await adminDb
    .insert(tenant)
    .values({ name: "carry", publicKey: `k-${Date.now()}-${Math.random()}`, clerkOrgId: `o-${Date.now()}-${Math.random()}` })
    .returning();
  const tid = t!.id;
  const [u] = await adminDb
    .insert(user)
    .values({ tenantId: tid, name: "Rep", email: `rep-${crypto.randomUUID()}@t.ex`, role: "rep" })
    .returning();
  const ids = await withTenant(tid, async (tx) => {
    const [c] = await tx.insert(customer).values({ tenantId: tid, name: "C" }).returning({ id: customer.id });
    const [p] = await tx.insert(property).values({ tenantId: tid, customerId: c!.id, address: "1 St" }).returning({ id: property.id });
    const [l] = await tx
      .insert(lead)
      .values({ tenantId: tid, customerId: c!.id, propertyId: p!.id, status: "new", assignedUserId: u!.id, lane: "storm" })
      .returning({ id: lead.id });
    const [d] = await tx.insert(document).values({ tenantId: tid, customerId: c!.id, kind: "photo", filename: "roof.jpg" }).returning({ id: document.id });
    return { customerId: c!.id, leadId: l!.id, photoId: d!.id };
  });
  return { tid, userId: u!.id, ...ids };
}

describe("convertLeadToJob — carryover", () => {
  it("carries the lead owner (assignedUserId) onto the job", async () => {
    const { tid, userId, leadId } = await seedLead();
    const { jobId } = await convertLeadToJob({ tenantId: tid, leadId, manualJob: true });
    const [j] = await adminDb.select({ assignedUserId: job.assignedUserId }).from(job).where(eq(job.id, jobId));
    expect(j!.assignedUserId).toBe(userId);
  });

  it("re-parents lead-stage photos onto the job", async () => {
    const { tid, leadId, photoId } = await seedLead();
    const { jobId } = await convertLeadToJob({ tenantId: tid, leadId, manualJob: true });
    const [d] = await adminDb.select({ jobId: document.jobId }).from(document).where(eq(document.id, photoId));
    expect(d!.jobId).toBe(jobId);
  });
});
