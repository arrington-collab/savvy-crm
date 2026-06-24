import "server-only";
import { withTenant, user, eq, and, isNull, inArray, getAssignmentSettings } from "@savvy/db";
import { parseAssignmentConfig, type AssignmentConfig } from "@savvy/core";

export type RepOption = { id: string; name: string };

export async function getSalesReps(tenantId: string): Promise<RepOption[]> {
  return withTenant(tenantId, (tx) =>
    tx.select({ id: user.id, name: user.name })
      .from(user)
      .where(and(eq(user.tenantId, tenantId), isNull(user.deactivatedAt), inArray(user.role, ["owner", "admin", "rep"]))),
  );
}

export async function getAssignmentConfig(tenantId: string): Promise<AssignmentConfig> {
  return parseAssignmentConfig(await getAssignmentSettings(tenantId));
}
