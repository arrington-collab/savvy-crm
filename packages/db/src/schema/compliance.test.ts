import { afterAll, describe, it, expect } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { adminDb, adminPool } from "../admin-client.js";
import { pool } from "../client.js";
import { withTenant } from "../tenant.js";
import { tenant } from "../schema/index.js";
import { license } from "../schema/compliance.js";

const tenantIds: string[] = [];

async function seedTenant(label: string) {
  const [t] = await adminDb
    .insert(tenant)
    .values({
      name: `LicenseTest-${label}`,
      publicKey: `pk-lic-${label}-${crypto.randomUUID()}`,
      clerkOrgId: `org-lic-${label}-${crypto.randomUUID()}`,
    })
    .returning();
  tenantIds.push(t!.id);
  return t!.id;
}

afterAll(async () => {
  if (tenantIds.length) {
    await adminDb.delete(license).where(inArray(license.tenantId, tenantIds));
    await adminDb.delete(tenant).where(inArray(tenant.id, tenantIds));
  }
  await pool.end();
  await adminPool.end();
});

describe("license table", () => {
  it("round-trips a state-level license row under tenant scope", async () => {
    const tenantId = await seedTenant("A");

    await withTenant(tenantId, async (tx) => {
      await tx.insert(license).values({
        tenantId,
        state: "AZ",
        city: null,
        authority: "AZ ROC",
        licenseNumber: "ROC-123456",
        status: "active",
      });
      const rows = await tx.select().from(license).where(eq(license.tenantId, tenantId));
      expect(rows.length).toBeGreaterThan(0);
      const row = rows.find((r) => r.state === "AZ" && r.city === null);
      expect(row).toBeDefined();
      expect(row!.licenseNumber).toBe("ROC-123456");
      expect(row!.authority).toBe("AZ ROC");
      expect(row!.status).toBe("active");
    });
  });

  it("round-trips a city-level license row", async () => {
    const tenantId = await seedTenant("B");

    await withTenant(tenantId, async (tx) => {
      await tx.insert(license).values({
        tenantId,
        state: "CO",
        city: "Denver",
        authority: "Denver Licensing",
        licenseNumber: "DEN-789",
        status: "pending",
      });
      const rows = await tx.select().from(license).where(eq(license.tenantId, tenantId));
      const row = rows.find((r) => r.city === "Denver");
      expect(row).toBeDefined();
      expect(row!.state).toBe("CO");
      expect(row!.status).toBe("pending");
    });
  });

  it("RLS hides another tenant's licenses", async () => {
    const tenantA = await seedTenant("C");
    const tenantB = await seedTenant("D");

    // Seed a row for tenantA using adminDb so RLS doesn't block the insert
    await adminDb.insert(license).values({
      tenantId: tenantA,
      state: "TX",
      city: null,
      authority: "TX DL",
      licenseNumber: "TX-999",
      status: "active",
    });

    // tenantB should NOT see tenantA's rows
    await withTenant(tenantB, async (tx) => {
      const rows = await tx.select().from(license).where(eq(license.state, "TX"));
      const leaked = rows.find((r) => r.tenantId === tenantA);
      expect(leaked).toBeUndefined();
    });
  });
});
