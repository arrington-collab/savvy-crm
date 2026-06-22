"use server";
import { adminDb, tenant, eq } from "@savvy/db";
import { getNangoConnection } from "@savvy/integrations";
import { getTenantId } from "./tenant";
import { isOrgAdmin } from "./authz";
import { revalidatePath } from "next/cache";

// Called by ConnectGmailButton after the Nango frontend SDK returns a
// connectionId via its onSuccess callback. We use adminDb (bypassing RLS) to
// write to the tenant row, which is the RLS isolation root — same pattern as
// quickbooks-actions.ts and settings-actions.ts.
//
// SECURITY: Before persisting, we verify with Nango (server-to-server) that the
// caller-supplied connectionId is actually bound to THIS tenant's organization.
// We also gate on isOrgAdmin() so only admins can change the tenant-level Gmail account.
// This prevents cross-tenant connection hijacking (IDOR via the server action).
export async function saveGmailConnection(
  connectionId: string,
): Promise<{ ok: true } | { error: "missing_connection_id" | "forbidden" | "not_verified" }> {
  if (!connectionId) return { error: "missing_connection_id" as const };
  if (!(await isOrgAdmin())) return { error: "forbidden" as const };

  const tenantId = await getTenantId();
  const integrationId = process.env.NANGO_GMAIL_INTEGRATION_ID ?? "google-mail";
  const conn = await getNangoConnection({ connectionId, integrationId });

  // Fail closed: only persist if Nango confirms this connection belongs to this tenant's org.
  if (!conn || conn.organizationId !== tenantId) {
    return { error: "not_verified" as const };
  }

  // Read-modify-write the settings jsonb to preserve sibling keys (e.g. other email settings).
  const [t] = await adminDb
    .select({ settings: tenant.settings })
    .from(tenant)
    .where(eq(tenant.id, tenantId));
  const settings = (t?.settings as Record<string, unknown>) ?? {};
  const email = { ...((settings.email as object) ?? {}), gmailConnectionId: connectionId };

  await adminDb
    .update(tenant)
    .set({ settings: { ...settings, email } })
    .where(eq(tenant.id, tenantId));

  revalidatePath("/settings/email");
  return { ok: true as const };
}
