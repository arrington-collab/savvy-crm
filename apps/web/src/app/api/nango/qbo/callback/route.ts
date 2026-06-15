import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { adminDb, tenant, eq } from "@savvy/db";
import { getTenantId } from "@/lib/tenant";

export const runtime = "nodejs";

// GET: Nango OAuth callback for QuickBooks Online.
// Nango redirects here with ?connectionId=<id> after the tenant completes OAuth.
// We persist the connectionId onto tenant.qboConnectionId via adminDb (bypasses RLS
// because tenant has no tenant_id column and must be written as the admin role).
//
// Mirrors the Stripe connect callback pattern (adminDb tenant write + redirect).
// Unlike the gcal flow (which only mints a session token), QBO needs tenant-level
// persistence here because the connectionId is shared across all users of the org.
export async function GET(req: Request): Promise<NextResponse> {
  const base = process.env.APP_BASE_URL ?? "http://localhost:3000";
  const { searchParams } = new URL(req.url);
  const connectionId = searchParams.get("connectionId");

  if (!connectionId) {
    return NextResponse.redirect(`${base}/settings/quickbooks?error=missing_connection_id`);
  }

  // Re-verify the session (defense-in-depth — middleware already gates /api/*).
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.redirect(`${base}/settings/quickbooks?error=unauthorized`);
  }

  let tenantId: string;
  try {
    tenantId = await getTenantId();
  } catch {
    return NextResponse.redirect(`${base}/settings/quickbooks?error=no_active_tenant`);
  }

  try {
    // Write connectionId to the tenant row via adminDb (tenant is RLS root — no tenant_id column).
    // This mirrors how the Stripe callback writes stripeAccountId to the same table.
    await adminDb
      .update(tenant)
      .set({ qboConnectionId: connectionId })
      .where(eq(tenant.id, tenantId));
  } catch {
    return NextResponse.redirect(`${base}/settings/quickbooks?error=persist_failed`);
  }

  return NextResponse.redirect(`${base}/settings/quickbooks?connected=1`);
}
