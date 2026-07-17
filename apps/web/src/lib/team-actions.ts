"use server";
import { withTenant, user, eq } from "@savvy/db";
import { auth, clerkClient } from "@clerk/nextjs/server";
import { revalidatePath } from "next/cache";
import { getTenantId } from "./tenant";
import { canManageSettingsNow } from "./authz";
import { normalizePhone } from "@savvy/core";
import type { UserRole } from "@savvy/core";

/** Returns the Clerk orgId, or null in TEST_MODE (no Clerk session). */
async function getOrgId(): Promise<string | null> {
  if (process.env.TEST_MODE === "1") return null;
  const { orgId } = await auth();
  return orgId ?? null;
}

const CLERK_ROLE = (r: UserRole): "org:admin" | "org:member" =>
  r === "owner" || r === "admin" ? "org:admin" : "org:member";

export async function inviteMember(email: string, role: UserRole): Promise<{ ok: true } | { error: string }> {
  if (!(await canManageSettingsNow())) return { error: "forbidden" };
  const orgId = await getOrgId();
  if (!orgId) return { error: "no organization" };
  try {
    const cc = await clerkClient();
    await cc.organizations.createOrganizationInvitation({ organizationId: orgId, emailAddress: email, role: CLERK_ROLE(role) });
    return { ok: true };
  } catch {
    return { error: "could not send invite" };
  }
}

export async function changeUserRole(userId: string, role: UserRole): Promise<{ ok: true } | { error: string }> {
  if (!(await canManageSettingsNow())) return { error: "forbidden" };
  const tenantId = await getTenantId();
  const orgId = await getOrgId();
  const target = await withTenant(tenantId, async (tx) => {
    const [u] = await tx.select({ id: user.id, clerkUserId: user.clerkUserId }).from(user).where(eq(user.id, userId));
    return u ?? null;
  });
  if (!target) return { error: "not found" };
  try {
    if (target.clerkUserId && orgId) {
      const cc = await clerkClient();
      await cc.organizations.updateOrganizationMembership({ organizationId: orgId, userId: target.clerkUserId, role: CLERK_ROLE(role) });
    }
    await withTenant(tenantId, (tx) => tx.update(user).set({ role }).where(eq(user.id, userId)));
    revalidatePath("/settings/team");
    return { ok: true };
  } catch {
    return { error: "could not change role" };
  }
}

export async function removeMember(userId: string): Promise<{ ok: true } | { error: string }> {
  if (!(await canManageSettingsNow())) return { error: "forbidden" };
  const tenantId = await getTenantId();
  const orgId = await getOrgId();
  const target = await withTenant(tenantId, async (tx) => {
    const [u] = await tx.select({ id: user.id, clerkUserId: user.clerkUserId }).from(user).where(eq(user.id, userId));
    return u ?? null;
  });
  if (!target) return { error: "not found" };
  try {
    if (target.clerkUserId && orgId) {
      const cc = await clerkClient();
      await cc.organizations.deleteOrganizationMembership({ organizationId: orgId, userId: target.clerkUserId });
    }
    await withTenant(tenantId, (tx) => tx.update(user).set({ deactivatedAt: new Date() }).where(eq(user.id, userId)));
    revalidatePath("/settings/team");
    return { ok: true };
  } catch {
    return { error: "could not remove member" };
  }
}

/** Admin-set a member's mobile number (used for rep speed-to-lead alerts).
 *  Empty input clears the number; non-empty input that can't be normalized errors. */
export async function setMemberPhone(userId: string, phone: string): Promise<{ ok: true } | { error: string }> {
  if (!(await canManageSettingsNow())) return { error: "forbidden" };
  const trimmed = phone.trim();
  const normalized = trimmed ? normalizePhone(trimmed) : null;
  if (trimmed && !normalized) return { error: "invalid phone number" };
  const tenantId = await getTenantId();
  await withTenant(tenantId, (tx) => tx.update(user).set({ phone: normalized }).where(eq(user.id, userId)));
  revalidatePath("/settings/team");
  return { ok: true };
}

export async function addCrewMember(name: string): Promise<{ ok: true; id: string } | { error: string }> {
  if (!(await canManageSettingsNow())) return { error: "forbidden" };
  if (!name.trim()) return { error: "name required" };
  const tenantId = await getTenantId();
  const id = await withTenant(tenantId, async (tx) => {
    const [u] = await tx.insert(user).values({
      tenantId, name: name.trim(), email: "", role: "crew", clerkUserId: null,
    }).returning({ id: user.id });
    return u!.id;
  });
  revalidatePath("/settings/team");
  return { ok: true, id };
}
