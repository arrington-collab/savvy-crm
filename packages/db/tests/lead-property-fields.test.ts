import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { adminDb, adminPool } from "../src/admin-client.js";
import { withTenant } from "../src/tenant.js";
import { tenant, customer, property, lead } from "../src/schema/index.js";
import { eq } from "drizzle-orm";

let tenantId: string;

beforeAll(async () => {
  const [t] = await adminDb
    .insert(tenant)
    .values({ name: "T", clerkOrgId: `org_prop_fields_${Date.now()}` })
    .returning();
  tenantId = t!.id;
});

afterAll(async () => {
  // Clean up in FK order: lead -> property -> customer -> tenant
  await adminDb.delete(lead).where(eq(lead.tenantId, tenantId));
  await adminDb.delete(property).where(eq(property.tenantId, tenantId));
  await adminDb.delete(customer).where(eq(customer.tenantId, tenantId));
  await adminDb.delete(tenant).where(eq(tenant.id, tenantId));
  await adminPool.end();
});

describe("property structured fields persist", () => {
  it("stores line1/city/state/zip/county/roofType + yearBuilt/lat/lng on property", async () => {
    const row = await withTenant(tenantId, async (tx) => {
      const [c] = await tx
        .insert(customer)
        .values({ tenantId, name: "Jane" })
        .returning();
      const [p] = await tx
        .insert(property)
        .values({
          tenantId,
          customerId: c!.id,
          address: "1 Main St, Mesa AZ 85201",
          line1: "1 Main St",
          city: "Mesa",
          state: "AZ",
          zip: "85201",
          county: "Maricopa",
          roofType: "tile",
          yearBuilt: 2004,
          lat: 33.4,
          lng: -111.8,
        })
        .returning();
      return p!;
    });

    expect(row.line1).toBe("1 Main St");
    expect(row.city).toBe("Mesa");
    expect(row.state).toBe("AZ");
    expect(row.zip).toBe("85201");
    expect(row.county).toBe("Maricopa");
    expect(row.roofType).toBe("tile");
    expect(row.yearBuilt).toBe(2004);
    expect(row.lat).toBeCloseTo(33.4);
    expect(row.lng).toBeCloseTo(-111.8);
  });
});
