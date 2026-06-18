import "server-only";
import { auth, clerkClient } from "@clerk/nextjs/server";
import { adminDb, user, ensureUser, eq, and } from "@savvy/db";
import { mapClerkRole } from "@savvy/core";
import { getTenantId } from "./tenant";

export type CurrentUser = { tenantId: string; userId: string; role: string; clerkUserId: string | null };

/** Resolves + lazily provisions the calling user's row. Called from (app)/layout
 *  (non-TEST_MODE) so every logged-in Clerk user gets a row on first request. */
export async function getCurrentUser(): Promise<CurrentUser> {
  if (process.env.TEST_MODE === "1") {
    const tenantId = process.env.TEST_TENANT_ID;
    if (!tenantId) throw new Error("TEST_MODE set but TEST_TENANT_ID missing");
    return { tenantId, userId: "test-user", role: "owner", clerkUserId: null };
  }
  const { userId: clerkUserId, orgId, orgRole } = await auth();
  if (!clerkUserId || !orgId) throw new Error("not authenticated");
  const tenantId = await getTenantId();
  const [existing] = await adminDb
    .select({ id: user.id, role: user.role })
    .from(user)
    .where(and(eq(user.tenantId, tenantId), eq(user.clerkUserId, clerkUserId)));
  if (existing) return { tenantId, userId: existing.id, role: existing.role, clerkUserId };

  const cc = await clerkClient();
  const [org, cu] = await Promise.all([
    cc.organizations.getOrganization({ organizationId: orgId }),
    cc.users.getUser(clerkUserId),
  ]);
  const primary = cu.emailAddresses.find((e) => e.id === cu.primaryEmailAddressId) ?? cu.emailAddresses[0];
  const name = [cu.firstName, cu.lastName].filter(Boolean).join(" ") || cu.username || primary?.emailAddress || "User";
  const email = primary?.emailAddress ?? "";
  const role = mapClerkRole(orgRole, org.createdBy === clerkUserId);
  const { id } = await ensureUser({ tenantId, clerkUserId, name, email, role });
  return { tenantId, userId: id, role, clerkUserId };
}
