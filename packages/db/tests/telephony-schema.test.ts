import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { adminDb, adminPool } from "../src/admin-client.js";
import { pool } from "../src/client.js";
import { withTenant } from "../src/tenant.js";
import { tenant, integrationConnection } from "../src/schema/index.js";

let tenantAId: string;
let tenantBId: string;

beforeAll(async () => {
  const [a] = await adminDb.insert(tenant).values({ name: "TEL-A", publicKey: "tel-a", clerkOrgId: "org_tel_a" }).returning();
  const [b] = await adminDb.insert(tenant).values({ name: "TEL-B", publicKey: "tel-b", clerkOrgId: "org_tel_b" }).returning();
  tenantAId = a!.id;
  tenantBId = b!.id;
  for (const tid of [tenantAId, tenantBId]) {
    await adminDb.insert(integrationConnection).values({
      tenantId: tid, provider: "twilio",
      secretCiphertext: "ct", secretIv: "iv", secretTag: "tag", metadata: {},
    });
  }
});

afterAll(async () => {
  await adminDb.delete(integrationConnection).where(eq(integrationConnection.tenantId, tenantAId));
  await adminDb.delete(integrationConnection).where(eq(integrationConnection.tenantId, tenantBId));
  await adminDb.delete(tenant).where(eq(tenant.id, tenantAId));
  await adminDb.delete(tenant).where(eq(tenant.id, tenantBId));
  await pool.end();
  await adminPool.end();
});

describe("integration_connection RLS", () => {
  it("tenant A sees only its own connection", async () => {
    const rows = await withTenant(tenantAId, (tx) => tx.select().from(integrationConnection));
    expect(rows.length).toBe(1);
    expect(rows[0]!.tenantId).toBe(tenantAId);
    expect(rows.some((r) => r.tenantId === tenantBId)).toBe(false);
  });

  it("new tenants default to platform telephony mode", async () => {
    const [t] = await adminDb.select().from(tenant).where(eq(tenant.id, tenantAId));
    expect(t!.telephonyMode).toBe("platform");
  });
});
