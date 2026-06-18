import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { adminDb, withTenant, tenant, user, eq } from "@savvy/db";

const { id: tenantId } = JSON.parse(
  readFileSync("/tmp/savvy-e2e-tenant.json", "utf8"),
) as { id: string };

test("clerk webhook: organizationMembership.deleted deactivates the user", async ({ request }) => {
  const clerkOrgId = `org_e2e_${Date.now()}`;
  await adminDb.update(tenant).set({ clerkOrgId }).where(eq(tenant.id, tenantId));
  const clerkUserId = `user_e2e_${Date.now()}`;
  const userId = await withTenant(tenantId, async (tx) => {
    const [u] = await tx
      .insert(user)
      .values({ tenantId, clerkUserId, name: "Webhook Wendy", email: "w@x.com", role: "rep" })
      .returning();
    return u!.id;
  });

  const res = await request.post("/api/clerk/webhook", {
    data: { type: "organizationMembership.deleted", data: { organization: { id: clerkOrgId }, public_user_data: { user_id: clerkUserId } } },
  });
  expect(res.ok()).toBeTruthy();

  const [row] = await withTenant(tenantId, (tx) => tx.select().from(user).where(eq(user.id, userId)));
  expect(row?.deactivatedAt ?? null).not.toBeNull();
});
