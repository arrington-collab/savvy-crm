import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { getTenantId } from "@/lib/tenant";

export const runtime = "nodejs";

// POST: create a Nango connect session for Gmail (google-mail integration), bound
// to the authenticated tenant. Returns a session token for ConnectGmailButton.
//
// Mirrors /api/nango/qbo/start but scoped to the Gmail integration and the
// tenant-level gmailConnectionId (stored in tenant.settings.email.gmailConnectionId).
export async function POST(): Promise<NextResponse> {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let tenantId: string;
  try {
    tenantId = await getTenantId();
  } catch {
    return NextResponse.json({ error: "no_active_tenant" }, { status: 401 });
  }

  const host = process.env.NANGO_HOST ?? "https://api.nango.dev";
  const res = await fetch(`${host}/connect/sessions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.NANGO_SECRET_KEY ?? ""}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      end_user: { id: userId },
      organization: { id: tenantId },
      allowed_integrations: [process.env.NANGO_GMAIL_INTEGRATION_ID ?? "google-mail"],
    }),
  });
  if (!res.ok) return NextResponse.json({ error: "nango_session_failed" }, { status: 502 });

  const body = (await res.json()) as { data?: { token?: string } };
  const token = body?.data?.token;
  if (!token) return NextResponse.json({ error: "nango_session_failed" }, { status: 502 });

  // Return only the session token — the frontend SDK uses it to open the Nango connect flow.
  return NextResponse.json({ token });
}
