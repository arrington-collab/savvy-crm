import { NextResponse } from "next/server";
export const runtime = "nodejs";

// POST: create a Nango connect session for google-calendar scoped to this user.
// Persisting the resulting connection id onto user.gcalConnectionId after the OAuth
// callback is a known follow-up — only the session creation is implemented here.
export async function POST(): Promise<NextResponse> {
  const host = process.env.NANGO_HOST ?? "https://api.nango.dev";
  const res = await fetch(`${host}/connect/sessions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.NANGO_SECRET_KEY ?? ""}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      allowed_integrations: [process.env.NANGO_GCAL_INTEGRATION_ID ?? "google-calendar"],
    }),
  });
  if (!res.ok) return NextResponse.json({ error: "nango_session_failed" }, { status: 502 });
  return NextResponse.json(await res.json());
}
