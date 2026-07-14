import { resolveEstimateLink, setEstimateSelection } from "@savvy/db";

export const runtime = "nodejs";

// Public, token-gated: the code IS the auth (same trust model as /status).
// Selection is validated server-side against the estimate's tier snapshot and
// the tier's palette — the client is never trusted.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ code: string }> },
): Promise<Response> {
  const { code } = await params;
  const link = await resolveEstimateLink(code);
  if (!link) return new Response("Not found", { status: 404 });

  let body: { tier?: string; color?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: "bad_json" }, { status: 400 });
  }
  if (!body.tier || !body.color) return Response.json({ ok: false, error: "missing_fields" }, { status: 400 });

  const res = await setEstimateSelection({
    tenantId: link.tenantId,
    estimateId: link.estimateId,
    tier: body.tier as "good" | "better" | "best",
    color: body.color,
  });
  return Response.json(res, { status: res.ok ? 200 : 400 });
}
