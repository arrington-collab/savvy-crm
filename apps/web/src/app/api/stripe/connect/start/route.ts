import { NextResponse } from "next/server";
import { signPayloadToken, requireSecret } from "@savvy/core";
import { getTenantId } from "@/lib/tenant";

export const runtime = "nodejs";

export async function GET(): Promise<NextResponse> {
  let tenantId: string;
  try { tenantId = await getTenantId(); } catch { return NextResponse.json({ error: "unauthorized" }, { status: 401 }); }
  const clientId = process.env.STRIPE_CONNECT_CLIENT_ID;
  if (!clientId) return NextResponse.json({ error: "stripe_connect_not_configured" }, { status: 500 });
  const secret = requireSecret("UNSUBSCRIBE_SECRET", { devFallback: "dev-unsubscribe-secret" });
  const state = signPayloadToken({ tenantId }, secret);
  const base = process.env.APP_BASE_URL ?? "http://localhost:3000";
  const url = new URL("https://connect.stripe.com/oauth/authorize");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("scope", "read_write");
  url.searchParams.set("state", state);
  url.searchParams.set("redirect_uri", `${base}/api/stripe/connect/callback`);
  return NextResponse.redirect(url.toString());
}
