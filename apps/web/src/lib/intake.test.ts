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

describe("createLeadForTenant — sms_consent_at capture", () => {
  let tenantId: string;

  beforeAll(async () => {
    const [t] = await adminDb
      .insert(tenant)
      .values({ name: "ConsentTest", clerkOrgId: `org_consent_${Date.now()}` })
      .returning();
    tenantId = t!.id;
  });

  it("sets sms_consent_at when a phone is provided", async () => {
    await createLeadForTenant(tenantId, {
      name: "Dave Phone",
      phone: "+16025551111",
      address: "10 Phone St, Phoenix AZ 85001",
      state: "AZ",
      source: "web",
    });

    const customers = await withTenant(tenantId, (tx) =>
      tx.select({ id: customer.id, smsConsentAt: customer.smsConsentAt }).from(customer),
    );
    expect(customers).toHaveLength(1);
    expect(customers[0]!.smsConsentAt).not.toBeNull();
  });

  it("leaves sms_consent_at null for email-only lead", async () => {
    await createLeadForTenant(tenantId, {
      name: "Eve EmailOnly",
      email: "eve@example.com",
      address: "20 Email Ave, Phoenix AZ 85001",
      state: "AZ",
      source: "web",
    });

    // Find Eve's customer (no phone match, email match)
    const allCustomers = await withTenant(tenantId, (tx) =>
      tx.select({ id: customer.id, smsConsentAt: customer.smsConsentAt }).from(customer),
    );
    // Eve is the 2nd customer (Dave is 1st)
    const eve = allCustomers.find((c) => c.smsConsentAt === null);
    expect(eve).toBeDefined();
    expect(eve!.smsConsentAt).toBeNull();
  });

  it("updates sms_consent_at on reused customer who had no consent", async () => {
    // Create a customer via email-only first (no consent)
    await createLeadForTenant(tenantId, {
      name: "Frank Updatable",
      email: "frank@example.com",
      address: "30 Frank Ln, Phoenix AZ 85001",
      state: "AZ",
      source: "web",
    });

    // Now re-submit with same email but add a phone
    await createLeadForTenant(tenantId, {
      name: "Frank Updatable",
      email: "frank@example.com",
      phone: "+16025552222",
      address: "40 New Addr, Phoenix AZ 85001",
      state: "AZ",
      source: "referral",
    });

    // Frank's customer should now have smsConsentAt set
    const allCustomers = await withTenant(tenantId, (tx) =>
      tx.select({ id: customer.id, smsConsentAt: customer.smsConsentAt, email: customer.email }).from(customer),
    );
    const frank = allCustomers.find((c) => c.email === "frank@example.com");
    expect(frank).toBeDefined();
    expect(frank!.smsConsentAt).not.toBeNull();
  });

  it("preserves the earliest sms_consent_at on a reused customer (no overwrite)", async () => {
    // First submit with a phone records consent at T1.
    await createLeadForTenant(tenantId, {
      name: "Gina Consented", phone: "+16025553333", email: "gina@example.com",
      address: "50 Gina Way, Phoenix AZ 85001", state: "AZ", source: "web",
    });
    const after1 = await withTenant(tenantId, (tx) =>
      tx.select({ smsConsentAt: customer.smsConsentAt, email: customer.email }).from(customer),
    );
    const t1 = after1.find((c) => c.email === "gina@example.com")!.smsConsentAt;
    expect(t1).not.toBeNull();

    // Re-submit with the same phone — consent must NOT be reset/overwritten.
    await createLeadForTenant(tenantId, {
      name: "Gina Consented", phone: "+16025553333", email: "gina@example.com",
      address: "60 Gina Way, Phoenix AZ 85001", state: "AZ", source: "referral",
    });
    const after2 = await withTenant(tenantId, (tx) =>
      tx.select({ smsConsentAt: customer.smsConsentAt, email: customer.email }).from(customer),
    );
    const ginas = after2.filter((c) => c.email === "gina@example.com");
    expect(ginas).toHaveLength(1); // deduped to one customer
    expect(ginas[0]!.smsConsentAt!.getTime()).toBe(t1!.getTime()); // unchanged
  });
});
