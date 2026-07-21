import { cache } from "react";
import { auth, clerkClient } from "@clerk/nextjs/server";
import { adminDb, tenant, ensureTenantForOrg, eq } from "@savvy/db";

/**
 * Resolves the active tenant. TEST_MODE → TEST_TENANT_ID (e2e). Otherwise the
 * Clerk active org → tenant; if no tenant row yet, lazily provision it.
 *
 * Wrapped in React.cache: dozens of query helpers call this per request, each
 * otherwise re-running auth() + a tenant SELECT. cache() memoizes it to a single
 * resolution per request (RSC render), removing ~10-15 redundant round-trips
 * from every page.
 */
export const getTenantId = cache(async (): Promise<string> => {
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
});
