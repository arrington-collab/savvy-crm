"use server";
import { adminDb, tenant, eq } from "@savvy/db";
import { getNangoConnection } from "@savvy/integrations";
import { getTenantId } from "./tenant";
import { revalidatePath } from "next/cache";

// Called by ConnectQuickBooksButton after the Nango frontend SDK returns a
// connectionId via its onSuccess callback. We use adminDb (bypassing RLS) to
// write to the tenant row, which is the RLS isolation root — same pattern as
// settings-actions.ts and the Stripe callback.
//
// SECURITY: Before persisting, we verify with Nango (server-to-server) that the
// caller-supplied connectionId is actually bound to THIS tenant's organization.
// We fail closed: if Nango can't confirm the binding, we reject the request.
// This prevents cross-tenant connection hijacking (IDOR via the server action).
export async function saveQuickBooksConnection(
  connectionId: string,
): Promise<{ ok: true } | { error: "missing_connection_id" | "not_verified" }> {
  if (!connectionId) return { error: "missing_connection_id" as const };

  const tenantId = await getTenantId();

  const integrationId = process.env.NANGO_QBO_INTEGRATION_ID ?? "quickbooks";
  const conn = await getNangoConnection({ connectionId, integrationId });

  // Fail closed: only persist if Nango confirms this connection belongs to this tenant's org.
  if (!conn || conn.organizationId !== tenantId) {
    return { error: "not_verified" as const };
  }

  await adminDb
    .update(tenant)
    .set({ qboConnectionId: connectionId })
    .where(eq(tenant.id, tenantId));

  revalidatePath("/settings/quickbooks");
  return { ok: true as const };
}
