import { describe, it, expect, beforeAll } from "vitest";
import { adminDb, withTenant, tenant, user, customer, lead, eq, saveAssignmentConfig } from "@savvy/db";
import { runLeadAssignment } from "./lead-intake";

describe("runLeadAssignment", () => {
  let tenantId: string, repA: string, repB: string, leadId: string;
  beforeAll(async () => {
    const [t] = await adminDb.insert(tenant).values({ name: "T", clerkOrgId: `org_${Date.now()}` }).returning();
    tenantId = t!.id;
    await withTenant(tenantId, async (tx) => {
      const [a] = await tx.insert(user).values({ tenantId, name: "A", email: `a-${Date.now()}@x.com`, role: "rep" }).returning();
      const [b] = await tx.insert(user).values({ tenantId, name: "B", email: `b-${Date.now()}@x.com`, role: "rep" }).returning();
      repA = a!.id; repB = b!.id;
      const [c] = await tx.insert(customer).values({ tenantId, name: "Cust" }).returning();
      await tx.insert(lead).values({ tenantId, customerId: c!.id, status: "new", assignedUserId: a!.id });
      const [l] = await tx.insert(lead).values({ tenantId, customerId: c!.id, status: "contacted", score: 60 }).returning();
      leadId = l!.id;
    });
  });

  it("assigns the unassigned lead to the least-loaded rep", async () => {
    await saveAssignmentConfig(tenantId, { strategy: "least_loaded" });
    const r = await runLeadAssignment(tenantId, leadId, { state: "AZ", city: "Mesa" });
    expect(r.assigned).toBe(repB);
    const [l] = await withTenant(tenantId, (tx) => tx.select({ a: lead.assignedUserId }).from(lead).where(eq(lead.id, leadId)));
    expect(l!.a).toBe(repB);
  });
  it("skips when strategy is off", async () => {
    await saveAssignmentConfig(tenantId, { strategy: "off" });
    const fresh = await withTenant(tenantId, async (tx) => {
      const [c] = await tx.insert(customer).values({ tenantId, name: "C2" }).returning();
      const [l] = await tx.insert(lead).values({ tenantId, customerId: c!.id, status: "new" }).returning();
      return l!.id;
    });
    const r = await runLeadAssignment(tenantId, fresh, { state: "AZ", city: "Mesa" });
    expect(r.assigned).toBeNull();
    expect(r.reason).toBe("off");
  });
  it("never overrides an already-assigned lead", async () => {
    await saveAssignmentConfig(tenantId, { strategy: "least_loaded" });
    const r = await runLeadAssignment(tenantId, leadId, { state: "AZ", city: "Mesa" });
    expect(r.assigned).toBeNull();
    expect(r.reason).toBe("already-assigned");
  });
});
