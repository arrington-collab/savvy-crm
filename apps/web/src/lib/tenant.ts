import { auth } from "@clerk/nextjs/server";
import { adminDb, tenant, eq } from "@savvy/db";

/**
 * Resolves the active tenant for the current request.
 * - TEST_MODE=1: returns TEST_TENANT_ID (Playwright e2e bypass; no Clerk).
 * - otherwise: Clerk active org -> tenant.clerk_org_id lookup.
 * Throws if no tenant resolves (caller should treat as 401/redirect).
 */
export async function getTenantId(): Promise<string> {
  if (process.env.TEST_MODE === "1") {
    const id = process.env.TEST_TENANT_ID;
    if (!id) throw new Error("TEST_MODE set but TEST_TENANT_ID missing");
    return id;
  }
  const { orgId } = await auth();
  if (!orgId) throw new Error("no active organization");
  const [t] = await adminDb
    .select()
    .from(tenant)
    .where(eq(tenant.clerkOrgId, orgId));
  if (!t) throw new Error(`no tenant for org ${orgId}`);
  return t.id;
}
