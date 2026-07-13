import { NextResponse } from "next/server";
import { tenantByKey } from "@/lib/intake";
import { canvassCors } from "@/lib/canvass-cors";

export const runtime = "nodejs";

// GET /api/canvass/company?key=<publicKey> — resolves a company code to its
// display name (+ optional canvass logo from tenant settings) so the field app
// can brand itself at onboarding, BEFORE any rep logs in. Public + read-only,
// same model as GET /reps: the publicKey is not a secret (it ships in the app),
// and this returns only a name — publicKeys are 40-char random, not guessable.
export function OPTIONS(req: Request): NextResponse {
  return new NextResponse(null, { status: 204, headers: canvassCors(req, "GET, OPTIONS") });
}

export async function GET(req: Request): Promise<NextResponse> {
  const headers = canvassCors(req, "GET, OPTIONS");
  const key = new URL(req.url).searchParams.get("key") || "";
  if (!key) return NextResponse.json({ error: "missing key" }, { status: 400, headers });
  const t = await tenantByKey(key);
  if (!t) return NextResponse.json({ error: "unknown company code" }, { status: 404, headers });
  const settings = (t.settings ?? {}) as { canvassLogo?: string };
  return NextResponse.json(
    { name: t.name, logo: typeof settings.canvassLogo === "string" ? settings.canvassLogo : null },
    { status: 200, headers },
  );
}
