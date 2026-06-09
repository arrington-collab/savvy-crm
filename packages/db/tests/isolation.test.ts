import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { adminDb, adminPool } from "../src/admin-client.js";
import { db, pool } from "../src/client.js";
import { withTenant } from "../src/tenant.js";
import { tenant, customer } from "../src/schema/index.js";

let tenantAId: string;
let tenantBId: string;
let custBId: string;

beforeAll(async () => {
  // Seed two isolated tenants directly via the admin (RLS-bypassing) connection.
  const [a] = await adminDb.insert(tenant).values({ name: "ISO-A", publicKey: "iso-a", clerkOrgId: "org_iso_a" }).returning();
  const [b] = await adminDb.insert(tenant).values({ name: "ISO-B", publicKey: "iso-b", clerkOrgId: "org_iso_b" }).returning();
  tenantAId = a!.id; tenantBId = b!.id;
  await adminDb.insert(customer).values({ tenantId: a!.id, name: "A-cust" });
  const [cb] = await adminDb.insert(customer).values({ tenantId: b!.id, name: "B-cust" }).returning();
  custBId = cb!.id;
});

afterAll(async () => {
  await adminDb.delete(customer).where(eq(customer.tenantId, tenantAId));
  await adminDb.delete(customer).where(eq(customer.tenantId, tenantBId));
  await adminDb.delete(tenant).where(eq(tenant.id, tenantAId));
  await adminDb.delete(tenant).where(eq(tenant.id, tenantBId));
  await pool.end();
  await adminPool.end();
});

describe("RLS tenant isolation (connected as savvy_app)", () => {
  it("SELECT sees only own tenant's rows", async () => {
    const rows = await withTenant(tenantAId, (tx) => tx.select().from(customer));
    expect(rows.length).toBe(1);
    expect(rows[0]!.name).toBe("A-cust");
    expect(rows.some((r) => r.tenantId === tenantBId)).toBe(false);
  });

  it("UPDATE cannot touch another tenant's row", async () => {
    const res = await withTenant(tenantAId, (tx) =>
      tx.update(customer).set({ name: "HACKED" }).where(eq(customer.id, custBId)).returning(),
    );
    expect(res.length).toBe(0); // policy hides B's row from A
    const [bRow] = await adminDb.select().from(customer).where(eq(customer.id, custBId));
    expect(bRow!.name).toBe("B-cust");
  });

  it("DELETE cannot remove another tenant's row", async () => {
    const res = await withTenant(tenantAId, (tx) =>
      tx.delete(customer).where(eq(customer.id, custBId)).returning(),
    );
    expect(res.length).toBe(0);
    const [bRow] = await adminDb.select().from(customer).where(eq(customer.id, custBId));
    expect(bRow).toBeTruthy();
  });

  it("INSERT with mismatched tenant_id is rejected by WITH CHECK", async () => {
    await expect(
      withTenant(tenantAId, (tx) =>
        tx.insert(customer).values({ tenantId: tenantBId, name: "smuggled" }),
      ),
    ).rejects.toThrow();
  });
});
