import { resolveEstimateLink } from "@savvy/db";
import { answerEstimateQuestion } from "@savvy/agents";

export const runtime = "nodejs";

// Public, token-gated Q&A: grounded in THIS estimate only; below-confidence
// answers escalate to the rep. Rate-limited per session server-side.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ code: string }> },
): Promise<Response> {
  const { code } = await params;
  const link = await resolveEstimateLink(code);
  if (!link) return new Response("Not found", { status: 404 });

  let body: { question?: string; sessionId?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false }, { status: 400 });
  }
  const question = (body.question ?? "").trim();
  const sessionId = (body.sessionId ?? "").slice(0, 64);
  if (question.length < 3 || !sessionId) return Response.json({ ok: false, error: "missing_fields" }, { status: 400 });

  const res = await answerEstimateQuestion({
    tenantId: link.tenantId,
    estimateId: link.estimateId,
    sessionId,
    question,
  });
  return Response.json({ ok: true, ...res });
}
