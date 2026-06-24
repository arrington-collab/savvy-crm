import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { adminDb, adminPool } from "../src/admin-client.js";
import { withTenant } from "../src/tenant.js";
import { tenant, user, customer, lead } from "../src/schema/index.js";
import { eq } from "drizzle-orm";
import { getAssignmentCandidates, getAssignmentSettings, saveAssignmentConfig } from "../src/lifecycle/assignment.js";

describe("assignment db", () => {
  let tenantId: string, repA: string, repB: string;
  beforeAll(async () => {
    const [t] = await adminDb.insert(tenant).values({ name: "T", clerkOrgId: `org_${Date.now()}`, settings: { onboarding: { done: true } } }).returning();
    tenantId = t!.id;
    await withTenant(tenantId, async (tx) => {
      const [a] = await tx.insert(user).values({ tenantId, name: "A", email: `a-${Date.now()}@x.com`, role: "rep" }).returning();
      const [b] = await tx.insert(user).values({ tenantId, name: "B", email: `b-${Date.now()}@x.com`, role: "rep" }).returning();
      const [office] = await tx.insert(user).values({ tenantId, name: "O", email: `o-${Date.now()}@x.com`, role: "office" }).returning();
      const [deact] = await tx.insert(user).values({ tenantId, name: "D", email: `d-${Date.now()}@x.com`, role: "rep", deactivatedAt: new Date() }).returning();
      repA = a!.id; repB = b!.id;
      const [c] = await tx.insert(customer).values({ tenantId, name: "Cust" }).returning();
      await tx.insert(lead).values({ tenantId, customerId: c!.id, status: "new", assignedUserId: a!.id });
      await tx.insert(lead).values({ tenantId, customerId: c!.id, status: "contacted", assignedUserId: a!.id });
      await tx.insert(lead).values({ tenantId, customerId: c!.id, status: "won", assignedUserId: a!.id });
      void office; void deact;
    });
  });

  afterAll(async () => {
    await adminDb.delete(lead).where(eq(lead.tenantId, tenantId));
    await adminDb.delete(customer).where(eq(customer.tenantId, tenantId));
    await adminDb.delete(user).where(eq(user.tenantId, tenantId));
    await adminDb.delete(tenant).where(eq(tenant.id, tenantId));
    await adminPool.end();
  });

  it("returns active sales reps with open counts; excludes office + deactivated", async () => {
    const cands = await withTenant(tenantId, (tx) => getAssignmentCandidates(tx, tenantId));
    const ids = cands.map((c) => c.userId);
    expect(ids).toContain(repA);
    expect(ids).toContain(repB);
    expect(cands.length).toBe(2);
    expect(cands.find((c) => c.userId === repA)!.openLeadCount).toBe(2);
    expect(cands.find((c) => c.userId === repB)!.openLeadCount).toBe(0);
  });

  it("saves + reads assignment config, preserving siblings", async () => {
    await saveAssignmentConfig(tenantId, { strategy: "least_loaded" });
    expect(await getAssignmentSettings(tenantId)).toEqual({ strategy: "least_loaded" });
    const [t] = await adminDb.select({ settings: tenant.settings }).from(tenant).where(eq(tenant.id, tenantId));
    expect((t!.settings as any).onboarding.done).toBe(true);
  });
});
