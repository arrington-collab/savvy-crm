import { and, eq } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { tenant, user } from "../schema/index";
import { adminDb } from "../admin-client";
import type { UserRole } from "@savvy/core";

// Roles that are assigned in-app and must NOT be clobbered by Clerk role sync.
const APP_STICKY = new Set<UserRole>(["owner", "office", "crew"]);

/** Find-or-create a tenant for a Clerk org. Idempotent + race-safe (clerkOrgId unique). */
export async function ensureTenantForOrg(
  input: { clerkOrgId: string; name: string },
): Promise<{ id: string; publicKey: string; created: boolean }> {
  const [existing] = await adminDb
    .select({ id: tenant.id, publicKey: tenant.publicKey })
    .from(tenant)
    .where(eq(tenant.clerkOrgId, input.clerkOrgId));
  if (existing) return { id: existing.id, publicKey: existing.publicKey ?? "", created: false };
  const publicKey = randomBytes(9).toString("base64url");
  try {
    const [row] = await adminDb
      .insert(tenant)
      .values({ clerkOrgId: input.clerkOrgId, name: input.name, publicKey })
      .returning({ id: tenant.id, publicKey: tenant.publicKey });
    return { id: row!.id, publicKey: row!.publicKey ?? publicKey, created: true };
  } catch {
    const [t] = await adminDb
      .select({ id: tenant.id, publicKey: tenant.publicKey })
      .from(tenant)
      .where(eq(tenant.clerkOrgId, input.clerkOrgId));
    if (!t) throw new Error("ensureTenantForOrg: insert failed and no row found");
    return { id: t.id, publicKey: t.publicKey ?? "", created: false };
  }
}

/** Upsert a Clerk-backed user by (tenantId, clerkUserId). Updates name/email,
 *  reactivates, and syncs role unless the existing role is app-sticky (owner/office/crew). */
export async function ensureUser(input: {
  tenantId: string; clerkUserId: string; name: string; email: string; role: UserRole;
}): Promise<{ id: string; created: boolean }> {
  const [existing] = await adminDb
    .select({ id: user.id, role: user.role })
    .from(user)
    .where(and(eq(user.tenantId, input.tenantId), eq(user.clerkUserId, input.clerkUserId)));
  if (existing) {
    const nextRole = APP_STICKY.has(existing.role as UserRole) ? existing.role as UserRole : input.role;
    await adminDb
      .update(user)
      .set({ name: input.name, email: input.email, role: nextRole, deactivatedAt: null })
      .where(eq(user.id, existing.id));
    return { id: existing.id, created: false };
  }
  try {
    const [row] = await adminDb
      .insert(user)
      .values({ tenantId: input.tenantId, clerkUserId: input.clerkUserId, name: input.name, email: input.email, role: input.role })
      .returning({ id: user.id });
    return { id: row!.id, created: true };
  } catch {
    const [u] = await adminDb
      .select({ id: user.id })
      .from(user)
      .where(and(eq(user.tenantId, input.tenantId), eq(user.clerkUserId, input.clerkUserId)));
    if (!u) throw new Error("ensureUser: insert failed and no row found");
    return { id: u.id, created: false };
  }
}

/** Soft-remove a Clerk-backed user (preserves FK references). */
export async function deactivateUserByClerkId(
  input: { tenantId: string; clerkUserId: string },
): Promise<{ deactivated: boolean }> {
  const res = await adminDb
    .update(user)
    .set({ deactivatedAt: new Date() })
    .where(and(eq(user.tenantId, input.tenantId), eq(user.clerkUserId, input.clerkUserId)))
    .returning({ id: user.id });
  return { deactivated: res.length > 0 };
}
