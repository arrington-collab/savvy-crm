"use server";
import { adminDb, tenant, eq } from "@savvy/db";
import { getTenantId } from "./tenant";
import { revalidatePath } from "next/cache";

// Called by ConnectQuickBooksButton after the Nango frontend SDK returns a
// connectionId via its onSuccess callback. We use adminDb (bypassing RLS) to
// write to the tenant row, which is the RLS isolation root — same pattern as
// settings-actions.ts and the Stripe callback.
export async function saveQuickBooksConnection(
  connectionId: string,
): Promise<{ ok: true } | { error: "missing_connection_id" | "no_active_tenant" | "persist_failed" }> {
  if (!connectionId) return { error: "missing_connection_id" as const };

  let tenantId: string;
  try {
    tenantId = await getTenantId();
  } catch {
    return { error: "no_active_tenant" as const };
  }

  try {
    await adminDb
      .update(tenant)
      .set({ qboConnectionId: connectionId })
      .where(eq(tenant.id, tenantId));
  } catch {
    return { error: "persist_failed" as const };
  }

  revalidatePath("/settings/quickbooks");
  return { ok: true as const };
}
