import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { adminDb } from "../src/admin-client";
import { tenant, user } from "../src/schema/tenancy";
import { provisionDemoTenant, DEMO_CLERK_ORG_ID, DEMO_TENANT_NAME } from "../src/lifecycle/demo-seed/config";

// Unique per run so the isolation assertions don't depend on shared-DB history.
const SUFFIX = `provision-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

describe("provisionDemoTenant", () => {
  it("creates an isolated demo tenant with acct_demo stripe + 5 users, idempotently", async () => {
    const { tenantId } = await provisionDemoTenant({ keySuffix: SUFFIX });
    const again = await provisionDemoTenant({ keySuffix: SUFFIX });
    expect(again.tenantId).toBe(tenantId); // idempotent (same suffix → same tenant)

    const [t] = await adminDb.select().from(tenant).where(eq(tenant.id, tenantId));
    expect(t?.demo).toBe(true);
    expect(t?.stripeAccountId).toBe("acct_demo");
    expect(t?.timezone).toBe("America/Phoenix");
    // Isolated tenant carries a suffixed, non-colliding clerk org id + name.
    expect(t?.clerkOrgId).toBe(`${DEMO_CLERK_ORG_ID}_${SUFFIX}`);
    expect(t?.name).toBe(`${DEMO_TENANT_NAME} [${SUFFIX}]`);

    const users = await adminDb.select().from(user).where(eq(user.tenantId, tenantId));
    // owner + office + 2 reps + crew = 5
    expect(users.length).toBeGreaterThanOrEqual(5);
    expect(users.filter((u) => u.role === "rep")).toHaveLength(2);
    expect(users.some((u) => u.role === "office")).toBe(true);
    expect(users.some((u) => u.role === "crew")).toBe(true);
  });

  it("with NO options provisions the real singleton demo tenant (unchanged deliverable)", async () => {
    // The production seeder calls provisionDemoTenant() with no args — it must resolve the
    // ONE fixed singleton (idempotent) with its exact name + clerk org id.
    const { tenantId } = await provisionDemoTenant();
    const again = await provisionDemoTenant();
    expect(again.tenantId).toBe(tenantId);

    const [t] = await adminDb.select().from(tenant).where(eq(tenant.id, tenantId));
    expect(t?.name).toBe("Demo Roofing (Savvy)");
    expect(t?.clerkOrgId).toBe(DEMO_CLERK_ORG_ID);
    expect(t?.demo).toBe(true);
    expect(t?.stripeAccountId).toBe("acct_demo");
  });
});
