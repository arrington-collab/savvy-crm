import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { adminDb } from "../admin-client";
import { tenant } from "../schema/tenancy";
import { user, lead } from "../schema/index";

type Tx = Parameters<Parameters<typeof import("../client").db.transaction>[0]>[0];

export type DbAssignmentCandidate = {
  userId: string;
  role: string;
  openLeadCount: number;
  lastAssignedAt: string | null;
};

const SALES_ROLES = ["owner", "admin", "rep"] as const;

export async function getAssignmentCandidates(tx: Tx, tenantId: string): Promise<DbAssignmentCandidate[]> {
  const users = await tx
    .select({ id: user.id, role: user.role })
    .from(user)
    .where(and(eq(user.tenantId, tenantId), isNull(user.deactivatedAt), inArray(user.role, [...SALES_ROLES])));

  const stats = await tx
    .select({
      userId: lead.assignedUserId,
      openCount: sql<number>`count(*) filter (where ${lead.status} not in ('won','lost'))`.mapWith(Number),
      lastAssignedAt: sql<string | null>`max(${lead.createdAt})`,
    })
    .from(lead)
    .where(eq(lead.tenantId, tenantId))
    .groupBy(lead.assignedUserId);

  const statById = new Map(stats.filter((s) => s.userId).map((s) => [s.userId as string, s]));
  return users.map((u) => ({
    userId: u.id,
    role: u.role,
    openLeadCount: statById.get(u.id)?.openCount ?? 0,
    lastAssignedAt: statById.get(u.id)?.lastAssignedAt ?? null,
  }));
}

export async function getAssignmentSettings(tenantId: string): Promise<unknown> {
  const [t] = await adminDb.select({ settings: tenant.settings }).from(tenant).where(eq(tenant.id, tenantId));
  return (t?.settings as { assignment?: unknown } | null)?.assignment ?? null;
}

export async function saveAssignmentConfig(tenantId: string, assignment: unknown): Promise<void> {
  const [t] = await adminDb.select({ settings: tenant.settings }).from(tenant).where(eq(tenant.id, tenantId));
  const settings = (t?.settings ?? {}) as Record<string, unknown>;
  await adminDb.update(tenant).set({ settings: { ...settings, assignment } }).where(eq(tenant.id, tenantId));
}
