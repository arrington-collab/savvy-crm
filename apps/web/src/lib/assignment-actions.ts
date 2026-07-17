"use server";
import { assignmentConfigSchema } from "@savvy/core";
import { saveAssignmentConfig } from "@savvy/db";
import { getTenantId } from "./tenant";
import { canManageSettingsNow } from "./authz";

export async function saveAssignmentAction(
  raw: unknown,
): Promise<{ ok: true } | { error: string }> {
  if (!(await canManageSettingsNow())) return { error: "Not authorized" };
  const parsed = assignmentConfigSchema.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid config" };
  try {
    const tenantId = await getTenantId();
    await saveAssignmentConfig(tenantId, parsed.data);
    return { ok: true };
  } catch {
    return { error: "Could not save assignment settings" };
  }
}
