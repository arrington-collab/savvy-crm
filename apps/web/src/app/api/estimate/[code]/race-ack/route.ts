import { resolveEstimateLink, recordEstimateEvent, withTenant, estimate, lead, eq } from "@savvy/db";

export const runtime = "nodejs";

// The rep's one-tap link from the race SMS. Recording the tap IS the "rep is
// on it" signal; then bounce them to the lead so they can call from context.
export async function GET(
  req: Request,
  { params }: { params: Promise<{ code: string }> },
): Promise<Response> {
  const { code } = await params;
  const link = await resolveEstimateLink(code);
  if (!link) return new Response("Not found", { status: 404 });

  const sessionId = new URL(req.url).searchParams.get("s");
  await recordEstimateEvent({
    tenantId: link.tenantId,
    estimateId: link.estimateId,
    kind: "race_rep_ack",
    sessionId,
  });

  const [est] = await withTenant(link.tenantId, (tx) =>
    tx.select({ leadId: estimate.leadId, jobId: estimate.jobId }).from(estimate).where(eq(estimate.id, link.estimateId)),
  );
  const target = est?.leadId ? `/leads/${est.leadId}` : est?.jobId ? `/jobs/${est.jobId}` : "/pipeline";
  return Response.redirect(new URL(target, req.url), 302);
}
