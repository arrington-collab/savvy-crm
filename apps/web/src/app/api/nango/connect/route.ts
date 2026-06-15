import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { getTenantId } from "@/lib/tenant";

export const runtime = "nodejs";

// POST: create a Nango connect session for google-calendar, bound to the
// authenticated user + tenant. The OAuth callback (a known follow-up) uses that
// binding to persist the connection id onto the right user.gcalConnectionId.
//
// Defense-in-depth: clerkMiddleware already gates /api/*, but we re-check the
// session here so the route stays safe regardless of matcher changes, and we
// bind the Nango session to the caller (end_user/organization) rather than
// minting a generic one. Only the session token is returned — never the
// upstream JSON wholesale.
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
      allowed_integrations: [process.env.NANGO_GCAL_INTEGRATION_ID ?? "google-calendar"],
    }),
  });
  if (!res.ok) return NextResponse.json({ error: "nango_session_failed" }, { status: 502 });

  const body = (await res.json()) as { data?: { token?: string } };
  const token = body?.data?.token;
  if (!token) return NextResponse.json({ error: "nango_session_failed" }, { status: 502 });
  // Return only what the client needs to open the Nango connect flow.
  return NextResponse.json({ token });
}
