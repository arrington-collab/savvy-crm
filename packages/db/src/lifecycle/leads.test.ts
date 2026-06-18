import { afterAll, describe, it, expect } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { adminDb, adminPool } from "../admin-client.js";
import { pool } from "../client.js";
import { withTenant } from "../tenant.js";
import { lead, customer, property, user, tenant } from "../schema/index.js";
import { setLeadOwner, setLeadLost } from "./leads.js";

const seededTenantIds: string[] = [];

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
  seededTenantIds.push(t!.id);
  return { tenantId: t!.id, ...out };
}

afterAll(async () => {
  if (seededTenantIds.length > 0) {
    await adminDb.delete(lead).where(inArray(lead.tenantId, seededTenantIds));
    await adminDb.delete(user).where(inArray(user.tenantId, seededTenantIds));
    await adminDb.delete(property).where(inArray(property.tenantId, seededTenantIds));
    await adminDb.delete(customer).where(inArray(customer.tenantId, seededTenantIds));
    await adminDb.delete(tenant).where(inArray(tenant.id, seededTenantIds));
  }
  await pool.end();
  await adminPool.end();
});

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
