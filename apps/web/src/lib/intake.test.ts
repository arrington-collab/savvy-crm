// CI-gated: requires Postgres. If ECONNREFUSED locally, this suite is expected
// to fail — rely on CI. Dedupe logic is exercised here with real DB round-trips.
import { describe, it, expect, beforeAll } from "vitest";
import { adminDb, withTenant, tenant, customer, lead, property } from "@savvy/db";
import { createLeadForTenant } from "./intake";

describe("createLeadForTenant — non-destructive dedupe", () => {
  let tenantId: string;

  beforeAll(async () => {
    const [t] = await adminDb
      .insert(tenant)
      .values({ name: "DedupeTest", clerkOrgId: `org_dedup_${Date.now()}` })
      .returning();
    tenantId = t!.id;
  });

  it("re-submits on the same phone reuse the existing customer, create new property + lead", async () => {
    const phone = `+14805551234`;

    // First submission
    await createLeadForTenant(tenantId, {
      name: "Alice Smith",
      phone,
      address: "100 Oak St, Phoenix AZ 85001",
      state: "AZ",
      source: "web",
    });

    // Second submission — same phone, different address
    await createLeadForTenant(tenantId, {
      name: "Alice Smith",
      phone,
      address: "200 Elm St, Scottsdale AZ 85250",
      state: "AZ",
      source: "referral",
    });

    const customers = await withTenant(tenantId, (tx) =>
      tx.select({ id: customer.id }).from(customer),
    );
    const properties = await withTenant(tenantId, (tx) =>
      tx.select({ id: property.id }).from(property),
    );
    const leads = await withTenant(tenantId, (tx) =>
      tx.select({ id: lead.id }).from(lead),
    );

    expect(customers).toHaveLength(1); // ONE customer reused
    expect(properties).toHaveLength(2); // TWO distinct properties
    expect(leads).toHaveLength(2);     // TWO leads
  });

  it("same phone + exact same address reuses both customer AND property, still creates new lead", async () => {
    const phone = `+14805559999`;

    await createLeadForTenant(tenantId, {
      name: "Bob Jones",
      phone,
      address: "300 Pine Ave, Mesa AZ 85201",
      state: "AZ",
      source: "web",
    });

    await createLeadForTenant(tenantId, {
      name: "Bob Jones",
      phone,
      address: "300 Pine Ave, Mesa AZ 85201", // exact same address
      state: "AZ",
      source: "web",
    });

    // Bob is 1 new customer; total customers now = 2 (Alice + Bob)
    const allCustomers = await withTenant(tenantId, (tx) =>
      tx.select({ id: customer.id }).from(customer),
    );
    // Bob has only 1 property (same address reused)
    const bobCust = allCustomers.find((_, i) => i === allCustomers.length - 1);
    // We can't trivially select by name here without a where, so just assert totals:
    // Prior test: 1 customer, 2 properties, 2 leads.
    // This test adds: 1 customer, 1 property (reused), 2 leads.
    // Totals: 2 customers, 3 properties, 4 leads.
    expect(allCustomers).toHaveLength(2);
    const allProperties = await withTenant(tenantId, (tx) =>
      tx.select({ id: property.id }).from(property),
    );
    expect(allProperties).toHaveLength(3);
    const allLeads = await withTenant(tenantId, (tx) =>
      tx.select({ id: lead.id }).from(lead),
    );
    expect(allLeads).toHaveLength(4);
    void bobCust; // suppress unused warning
  });

  it("brand-new phone+email creates a fresh customer", async () => {
    await createLeadForTenant(tenantId, {
      name: "Carol Davis",
      phone: "+16025550001",
      email: "carol@example.com",
      address: "500 Desert Rd, Tucson AZ 85701",
      state: "AZ",
      source: "web",
    });

    const allCustomers = await withTenant(tenantId, (tx) =>
      tx.select({ id: customer.id }).from(customer),
    );
    // 3rd distinct customer
    expect(allCustomers).toHaveLength(3);
  });
});
