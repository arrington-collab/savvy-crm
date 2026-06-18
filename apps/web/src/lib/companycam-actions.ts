"use server";
import { adminDb, withTenant, tenant, job, eq } from "@savvy/db";
import { getNangoConnection } from "@savvy/integrations";
import { revalidatePath } from "next/cache";
import { getTenantId } from "./tenant";
import { isOrgAdmin } from "./authz";

// Mirrors saveQuickBooksConnection: adminDb write to the tenant row, IDOR-checked.
export async function saveCompanyCamConnection(
  connectionId: string,
): Promise<{ ok: true } | { error: "missing_connection_id" | "not_verified" | "forbidden" }> {
  if (!(await isOrgAdmin())) return { error: "forbidden" };
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
  const tenantId = await getTenantId();
  const res = await withTenant(tenantId, async (tx) => {
    const [j] = await tx.select({ id: job.id }).from(job).where(eq(job.id, jobId));
    if (!j) return null;
    await tx.update(job).set({ companycamProjectId: projectId.trim() || null }).where(eq(job.id, jobId));
    return j;
  });
  if (!res) return { error: "not_found" };
  revalidatePath(`/jobs/${jobId}`);
  return { ok: true };
}
