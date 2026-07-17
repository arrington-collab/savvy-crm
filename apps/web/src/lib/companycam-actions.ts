"use server";
import { adminDb, withTenant, tenant, job, eq } from "@savvy/db";
import { getNangoConnection } from "@savvy/integrations";
import { revalidatePath } from "next/cache";
import { getTenantId } from "./tenant";
import { canManageSettingsNow } from "./authz";

// Mirrors saveQuickBooksConnection: adminDb write to the tenant row, IDOR-checked.
export async function saveCompanyCamConnection(
  connectionId: string,
): Promise<{ ok: true } | { error: "missing_connection_id" | "not_verified" | "forbidden" }> {
  if (!(await canManageSettingsNow())) return { error: "forbidden" };
  if (!connectionId) return { error: "missing_connection_id" };
  const tenantId = await getTenantId();
  const integrationId = process.env.NANGO_COMPANYCAM_INTEGRATION_ID ?? "companycam";
  const conn = await getNangoConnection({ connectionId, integrationId });
  if (!conn || conn.organizationId !== tenantId) return { error: "not_verified" };
  await adminDb.update(tenant).set({ companycamConnectionId: connectionId }).where(eq(tenant.id, tenantId));
  revalidatePath("/settings");
  return { ok: true };
}

export async function linkCompanyCamProject(
  jobId: string, projectId: string,
): Promise<{ ok: true } | { error: string }> {
  if (!(await canManageSettingsNow())) return { error: "forbidden" };
  const tenantId = await getTenantId();
  const pid = projectId.trim();
  if (pid) {
    // Reject claiming a CompanyCam project already linked to another tenant's job
    // (webhook routing is by projectId globally; cross-tenant collisions = data leak).
    const claimed = await adminDb.select({ tenantId: job.tenantId }).from(job).where(eq(job.companycamProjectId, pid));
    if (claimed.some((c) => c.tenantId !== tenantId)) return { error: "project already linked to another workspace" };
  }
  const res = await withTenant(tenantId, async (tx) => {
    const [j] = await tx.select({ id: job.id }).from(job).where(eq(job.id, jobId));
    if (!j) return null;
    await tx.update(job).set({ companycamProjectId: pid || null }).where(eq(job.id, jobId));
    return j;
  });
  if (!res) return { error: "not_found" };
  revalidatePath(`/jobs/${jobId}`);
  return { ok: true };
}
