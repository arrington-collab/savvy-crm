// CI-gated: requires Postgres. If ECONNREFUSED locally, this suite is expected
// to fail — rely on CI.
import { afterAll, describe, it, expect } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { adminDb, adminPool } from "../admin-client.js";
import { pool } from "../client.js";
import { withTenant } from "../tenant.js";
import { lead, customer, property, tenant } from "../schema/index.js";
import { markLeadContacted, markCustomerLeadsContacted } from "./contact.js";

const seededTenantIds: string[] = [];

async function seedTenantWithCustomerAndLeads(numLeads = 1) {
  const [t] = await adminDb.insert(tenant).values({
    name: "ContactTest",
    publicKey: `pk-${crypto.randomUUID()}`,
    clerkOrgId: `org-${crypto.randomUUID()}`,
  }).returning();
  const out = await withTenant(t!.id, async (tx) => {
    const [c] = await tx.insert(customer).values({ tenantId: t!.id, name: "Contact Carl" }).returning();
    const [p] = await tx.insert(property).values({ tenantId: t!.id, customerId: c!.id, address: "1 Contact Ct" }).returning();
    const leadIds: string[] = [];
    for (let i = 0; i < numLeads; i++) {
      const [l] = await tx.insert(lead).values({
        tenantId: t!.id, customerId: c!.id, propertyId: p!.id, status: "new",
      }).returning();
      leadIds.push(l!.id);
    }
    return { customerId: c!.id, leadIds };
  });
  seededTenantIds.push(t!.id);
  return { tenantId: t!.id, ...out };
}

afterAll(async () => {
  if (seededTenantIds.length > 0) {
    await adminDb.delete(lead).where(inArray(lead.tenantId, seededTenantIds));
    await adminDb.delete(property).where(inArray(property.tenantId, seededTenantIds));
    await adminDb.delete(customer).where(inArray(customer.tenantId, seededTenantIds));
    await adminDb.delete(tenant).where(inArray(tenant.id, seededTenantIds));
  }
  await pool.end();
  await adminPool.end();
});

describe("markLeadContacted", () => {
  it("returns true on first call and sets firstRepContactAt; returns false on second call", async () => {
    const { tenantId, leadIds } = await seedTenantWithCustomerAndLeads(1);
    const leadId = leadIds[0]!;

    // First call — should set the timestamp
    const first = await withTenant(tenantId, (tx) => markLeadContacted(tx, { tenantId, leadId }));
    expect(first).toBe(true);

    // Verify timestamp is set
    const [row] = await withTenant(tenantId, (tx) => tx.select().from(lead).where(eq(lead.id, leadId)));
    expect(row!.firstRepContactAt).not.toBeNull();

    // Second call — should be idempotent (no-op)
    const second = await withTenant(tenantId, (tx) => markLeadContacted(tx, { tenantId, leadId }));
    expect(second).toBe(false);

    // Timestamp must not have changed (still same row)
    const [row2] = await withTenant(tenantId, (tx) => tx.select().from(lead).where(eq(lead.id, leadId)));
    expect(row2!.firstRepContactAt).toEqual(row!.firstRepContactAt);
  });

  it("respects tenant isolation — cannot contact a lead from another tenant", async () => {
    const a = await seedTenantWithCustomerAndLeads(1);
    const b = await seedTenantWithCustomerAndLeads(1);

    // Try to mark tenant A's lead from tenant B's context — should not update
    const result = await withTenant(b.tenantId, (tx) =>
      markLeadContacted(tx, { tenantId: b.tenantId, leadId: a.leadIds[0]! })
    );
    expect(result).toBe(false);

    // Tenant A lead should still be null
    const [row] = await withTenant(a.tenantId, (tx) => tx.select().from(lead).where(eq(lead.id, a.leadIds[0]!)));
    expect(row!.firstRepContactAt).toBeNull();
  });
});

describe("markCustomerLeadsContacted", () => {
  it("marks all open uncontacted leads for a customer and returns their ids", async () => {
    const { tenantId, customerId, leadIds } = await seedTenantWithCustomerAndLeads(3);

    const markedIds = await withTenant(tenantId, (tx) =>
      markCustomerLeadsContacted(tx, { tenantId, customerId })
    );

    expect(markedIds.sort()).toEqual(leadIds.sort());

    // Verify all are now set
    const rows = await withTenant(tenantId, (tx) =>
      tx.select().from(lead).where(inArray(lead.id, leadIds))
    );
    for (const row of rows) {
      expect(row.firstRepContactAt).not.toBeNull();
    }
  });

  it("does not re-mark already-contacted leads", async () => {
    const { tenantId, customerId, leadIds } = await seedTenantWithCustomerAndLeads(2);

    // First pass — marks both
    const first = await withTenant(tenantId, (tx) =>
      markCustomerLeadsContacted(tx, { tenantId, customerId })
    );
    expect(first).toHaveLength(2);

    // Second pass — nothing to mark
    const second = await withTenant(tenantId, (tx) =>
      markCustomerLeadsContacted(tx, { tenantId, customerId })
    );
    expect(second).toHaveLength(0);
  });

  it("skips leads that are already in a terminal status (lost)", async () => {
    const [t] = await adminDb.insert(tenant).values({
      name: "ContactTerminal",
      publicKey: `pk-${crypto.randomUUID()}`,
      clerkOrgId: `org-${crypto.randomUUID()}`,
    }).returning();
    seededTenantIds.push(t!.id);

    const { customerId, leadIds } = await withTenant(t!.id, async (tx) => {
      const [c] = await tx.insert(customer).values({ tenantId: t!.id, name: "Terminal Ted" }).returning();
      const [p] = await tx.insert(property).values({ tenantId: t!.id, customerId: c!.id, address: "2 Terminal Rd" }).returning();
      // one open lead, one lost lead
      const [open] = await tx.insert(lead).values({ tenantId: t!.id, customerId: c!.id, propertyId: p!.id, status: "new" }).returning();
      const [lost] = await tx.insert(lead).values({ tenantId: t!.id, customerId: c!.id, propertyId: p!.id, status: "lost" }).returning();
      return { customerId: c!.id, leadIds: { open: open!.id, lost: lost!.id } };
    });

    const marked = await withTenant(t!.id, (tx) =>
      markCustomerLeadsContacted(tx, { tenantId: t!.id, customerId })
    );

    // Only the open lead should be marked
    expect(marked).toHaveLength(1);
    expect(marked[0]).toBe(leadIds.open);

    // The lost lead should remain null
    const [lostRow] = await withTenant(t!.id, (tx) =>
      tx.select().from(lead).where(eq(lead.id, leadIds.lost))
    );
    expect(lostRow!.firstRepContactAt).toBeNull();
  });
});
