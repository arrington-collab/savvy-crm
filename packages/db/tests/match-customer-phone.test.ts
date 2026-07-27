// CI-gated: requires Postgres. If ECONNREFUSED locally, this suite is expected
// to fail — rely on CI.
import { afterAll, describe, it, expect } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { adminDb, adminPool } from "../src/admin-client.js";
import { pool } from "../src/client.js";
import { withTenant } from "../src/tenant.js";
import { customer, tenant } from "../src/schema/index.js";
import { matchCustomerByPhone } from "../src/lifecycle/match-customer-phone.js";

const seededTenantIds: string[] = [];

afterAll(async () => {
  if (seededTenantIds.length > 0) {
    await adminDb.delete(customer).where(inArray(customer.tenantId, seededTenantIds));
    await adminDb.delete(tenant).where(inArray(tenant.id, seededTenantIds));
  }
  await pool.end();
  await adminPool.end();
});

async function seedTenant() {
  const [t] = await adminDb.insert(tenant).values({ name: "MatchPhone", publicKey: `pk-${crypto.randomUUID()}` }).returning();
  seededTenantIds.push(t!.id);
  return t!.id;
}

describe("matchCustomerByPhone", () => {
  it("matches a NON-E.164 stored phone against an E.164 inbound number", async () => {
    const tenantId = await seedTenant();
    const [c] = await adminDb.insert(customer).values({ tenantId, name: "Pat Non-E164", phone: "(602) 555-0100" }).returning();

    const row = await withTenant(tenantId, (tx) => matchCustomerByPhone(tx, "+16025550100"));

    expect(row?.id).toBe(c!.id);
  });

  it("matches an E.164 stored phone against a non-E.164 inbound number (reverse case)", async () => {
    const tenantId = await seedTenant();
    const [c] = await adminDb.insert(customer).values({ tenantId, name: "Pat E164", phone: "+16025550100" }).returning();

    const row = await withTenant(tenantId, (tx) => matchCustomerByPhone(tx, "602-555-0100"));

    expect(row?.id).toBe(c!.id);
  });

  it("returns null when no customer matches the inbound number", async () => {
    const tenantId = await seedTenant();
    await adminDb.insert(customer).values({ tenantId, name: "Pat No Match", phone: "+16025550100" }).returning();

    const row = await withTenant(tenantId, (tx) => matchCustomerByPhone(tx, "+19998887777"));

    expect(row).toBeNull();
  });

  it("matched customer row can then be updated with smsOptOut=true (STOP-path intent)", async () => {
    const tenantId = await seedTenant();
    const [c] = await adminDb.insert(customer).values({ tenantId, name: "Pat Stop", phone: "(602) 555-0100" }).returning();

    const row = await withTenant(tenantId, (tx) => matchCustomerByPhone(tx, "+16025550100"));
    expect(row).not.toBeNull();
    await withTenant(tenantId, (tx) => tx.update(customer).set({ smsOptOut: true }).where(eq(customer.id, row!.id)));

    const [updated] = await adminDb.select().from(customer).where(eq(customer.id, c!.id));
    expect(updated!.smsOptOut).toBe(true);
  });
});
