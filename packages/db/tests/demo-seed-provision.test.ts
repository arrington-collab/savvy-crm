import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { adminDb } from "../src/admin-client";
import { tenant, user } from "../src/schema/tenancy";
import { provisionDemoTenant } from "../src/lifecycle/demo-seed/config";

describe("provisionDemoTenant", () => {
  it("creates a demo tenant with acct_demo stripe + 5 users, idempotently", async () => {
    const { tenantId } = await provisionDemoTenant();
    const again = await provisionDemoTenant();
    expect(again.tenantId).toBe(tenantId); // idempotent

    const [t] = await adminDb.select().from(tenant).where(eq(tenant.id, tenantId));
    expect(t?.demo).toBe(true);
    expect(t?.stripeAccountId).toBe("acct_demo");
    expect(t?.timezone).toBe("America/Phoenix");
    expect(t?.name).toBe("Demo Roofing (Savvy)");

    const users = await adminDb.select().from(user).where(eq(user.tenantId, tenantId));
    // owner + office + 2 reps + crew = 5
    expect(users.length).toBeGreaterThanOrEqual(5);
    expect(users.filter((u) => u.role === "rep")).toHaveLength(2);
    expect(users.some((u) => u.role === "office")).toBe(true);
    expect(users.some((u) => u.role === "crew")).toBe(true);
  });
});
