import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { adminDb } from "../admin-client.js";
import { withTenant } from "../tenant.js";
import { lead, customer, property, user, tenant } from "../schema/index.js";
import { setLeadOwner, setLeadLost } from "./leads.js";

async function seedTenantWithLead() {
  const [t] = await adminDb.insert(tenant).values({
    name: "Leads",
    publicKey: `pk-${crypto.randomUUID()}`,
    clerkOrgId: `org-${crypto.randomUUID()}`,
  }).returning();
  const out = await withTenant(t!.id, async (tx) => {
    const [c] = await tx.insert(customer).values({ tenantId: t!.id, name: "Lead Lou" }).returning();
    const [p] = await tx.insert(property).values({ tenantId: t!.id, customerId: c!.id, address: "1 Lead Ln" }).returning();
    const [l] = await tx.insert(lead).values({ tenantId: t!.id, customerId: c!.id, propertyId: p!.id, status: "new" }).returning();
    const [u] = await tx.insert(user).values({ tenantId: t!.id, name: "Rep Rae", email: `rae-${crypto.randomUUID()}@x.com` }).returning();
    return { leadId: l!.id, userId: u!.id };
  });
  return { tenantId: t!.id, ...out };
}

describe("setLeadOwner / setLeadLost", () => {
  it("assigns then clears an owner", async () => {
    const { tenantId, leadId, userId } = await seedTenantWithLead();
    await withTenant(tenantId, (tx) => setLeadOwner(tx, { tenantId, leadId, userId }));
    let [row] = await withTenant(tenantId, (tx) => tx.select().from(lead).where(eq(lead.id, leadId)));
    expect(row!.assignedUserId).toBe(userId);
    await withTenant(tenantId, (tx) => setLeadOwner(tx, { tenantId, leadId, userId: null }));
    [row] = await withTenant(tenantId, (tx) => tx.select().from(lead).where(eq(lead.id, leadId)));
    expect(row!.assignedUserId).toBeNull();
  });

  it("rejects a cross-tenant user", async () => {
    const a = await seedTenantWithLead();
    const b = await seedTenantWithLead();
    await expect(
      withTenant(a.tenantId, (tx) => setLeadOwner(tx, { tenantId: a.tenantId, leadId: a.leadId, userId: b.userId })),
    ).rejects.toThrow();
  });

  it("marks a lead lost, idempotently", async () => {
    const { tenantId, leadId } = await seedTenantWithLead();
    await withTenant(tenantId, (tx) => setLeadLost(tx, { tenantId, leadId }));
    let [row] = await withTenant(tenantId, (tx) => tx.select().from(lead).where(eq(lead.id, leadId)));
    expect(row!.status).toBe("lost");
    await withTenant(tenantId, (tx) => setLeadLost(tx, { tenantId, leadId }));
    [row] = await withTenant(tenantId, (tx) => tx.select().from(lead).where(eq(lead.id, leadId)));
    expect(row!.status).toBe("lost");
  });
});
