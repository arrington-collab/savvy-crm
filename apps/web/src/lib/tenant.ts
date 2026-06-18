import { auth, clerkClient } from "@clerk/nextjs/server";
import { adminDb, tenant, ensureTenantForOrg, eq } from "@savvy/db";

/**
 * Resolves the active tenant. TEST_MODE → TEST_TENANT_ID (e2e). Otherwise the
 * Clerk active org → tenant; if no tenant row yet, lazily provision it.
 */
export async function getTenantId(): Promise<string> {
  if (process.env.TEST_MODE === "1") {
    const id = process.env.TEST_TENANT_ID;
    if (!id) throw new Error("TEST_MODE set but TEST_TENANT_ID missing");
    return id;
  }
  const { orgId } = await auth();
  if (!orgId) throw new Error("no active organization");
  const [t] = await adminDb.select({ id: tenant.id }).from(tenant).where(eq(tenant.clerkOrgId, orgId));
  if (t) return t.id;
  // Lazy provision (org exists in Clerk but no tenant row yet).
  const cc = await clerkClient();
  const org = await cc.organizations.getOrganization({ organizationId: orgId });
  const { id } = await ensureTenantForOrg({ clerkOrgId: orgId, name: org.name });
  return id;
}
