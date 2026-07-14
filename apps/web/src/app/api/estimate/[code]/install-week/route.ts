import { resolveEstimateLink, setRequestedInstallWeek } from "@savvy/db";

export const runtime = "nodejs";

// Public, token-gated: the homeowner's install-week pick. A SOFT hold on the
// job — the office confirms by actually scheduling the crew.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ code: string }> },
): Promise<Response> {
  const { code } = await params;
  const link = await resolveEstimateLink(code);
  if (!link) return new Response("Not found", { status: 404 });

  let body: { weekStart?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: "bad_json" }, { status: 400 });
  }
  if (!body.weekStart) return Response.json({ ok: false, error: "missing_fields" }, { status: 400 });

  const res = await setRequestedInstallWeek({
    tenantId: link.tenantId,
    estimateId: link.estimateId,
    weekStart: new Date(`${body.weekStart}T00:00:00Z`),
  });
  return Response.json(res, { status: res.ok ? 200 : 400 });
}
