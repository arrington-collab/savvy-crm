import { NextResponse } from "next/server";
import { verifyPayloadToken } from "@savvy/core";
import { stripeGateway } from "@savvy/integrations";
import { adminDb, tenant, eq } from "@savvy/db";
import { getTenantId } from "@/lib/tenant";

export const runtime = "nodejs";

export async function GET(req: Request): Promise<NextResponse> {
  const base = process.env.APP_BASE_URL ?? "http://localhost:3000";
  const { searchParams } = new URL(req.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const secret = process.env.UNSUBSCRIBE_SECRET ?? "dev-unsubscribe-secret";
  const payload = state ? verifyPayloadToken<{ tenantId: string }>(state, secret) : null;
  if (!code || !payload) return NextResponse.redirect(`${base}/settings/payments?error=invalid`);

  let tenantId: string;
  try { tenantId = await getTenantId(); } catch { return NextResponse.redirect(`${base}/settings/payments?error=unauthorized`); }
  if (tenantId !== payload.tenantId) return NextResponse.redirect(`${base}/settings/payments?error=mismatch`);

  try {
    const { stripeUserId } = await stripeGateway.oauthToken(code);
    await adminDb.update(tenant).set({ stripeAccountId: stripeUserId }).where(eq(tenant.id, tenantId));
  } catch {
    return NextResponse.redirect(`${base}/settings/payments?error=exchange_failed`);
  }
  return NextResponse.redirect(`${base}/settings/payments?connected=1`);
}
