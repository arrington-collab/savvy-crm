import "server-only";
import { withTenant, user, asc } from "@savvy/db";
import { getTenantId } from "./tenant";

export type TeamMember = {
  id: string; name: string; email: string; role: string;
  isClerkBacked: boolean; deactivated: boolean; hasPin: boolean;
};

export async function listTeam(): Promise<TeamMember[]> {
  const tenantId = await getTenantId();
  const rows = await withTenant(tenantId, (tx) =>
    tx.select({
      id: user.id, name: user.name, email: user.email, role: user.role,
      clerkUserId: user.clerkUserId, deactivatedAt: user.deactivatedAt, pinHash: user.pinHash,
    }).from(user).orderBy(asc(user.name)),
  );
  return rows.map((r) => ({
    id: r.id, name: r.name, email: r.email, role: r.role,
    isClerkBacked: r.clerkUserId !== null,
    deactivated: r.deactivatedAt !== null,
    hasPin: r.pinHash !== null,
  }));
}
