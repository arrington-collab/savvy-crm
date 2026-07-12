import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { adminDb } from "../src/admin-client";
import { tenant } from "../src/schema/tenancy";
import { ensureTenantForOrg } from "../src/lifecycle/provisioning";
import { isDemoTenant, __clearDemoTenantCache } from "../src/lifecycle/demo-tenant";

describe("isDemoTenant", () => {
  beforeEach(() => {
    __clearDemoTenantCache();
  });

  it("is false for a normal tenant, true after flagging", async () => {
    const t = await ensureTenantForOrg({ clerkOrgId: `org_isdemo_${Date.now()}`, name: "Is Demo" });
    expect(await isDemoTenant(t.id)).toBe(false);
    await adminDb.update(tenant).set({ demo: true }).where(eq(tenant.id, t.id));
    __clearDemoTenantCache(); // flag flipped after the first read cached `false`
    expect(await isDemoTenant(t.id)).toBe(true);
    await adminDb.delete(tenant).where(eq(tenant.id, t.id));
  });

  it("is false for an unknown tenant id", async () => {
    expect(await isDemoTenant("00000000-0000-0000-0000-000000000000")).toBe(false);
  });
});
