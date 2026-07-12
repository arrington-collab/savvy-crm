import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { adminDb } from "../src/admin-client";
import { tenant } from "../src/schema/tenancy";
import { ensureTenantForOrg } from "../src/lifecycle/provisioning";

describe("tenant.demo column", () => {
  it("defaults to false and round-trips true", async () => {
    const t = await ensureTenantForOrg({ clerkOrgId: `org_demo_col_${Date.now()}`, name: "Col Test" });
    const [before] = await adminDb.select({ demo: tenant.demo }).from(tenant).where(eq(tenant.id, t.id));
    expect(before?.demo).toBe(false);
    await adminDb.update(tenant).set({ demo: true }).where(eq(tenant.id, t.id));
    const [after] = await adminDb.select({ demo: tenant.demo }).from(tenant).where(eq(tenant.id, t.id));
    expect(after?.demo).toBe(true);
    await adminDb.delete(tenant).where(eq(tenant.id, t.id));
  });
});
