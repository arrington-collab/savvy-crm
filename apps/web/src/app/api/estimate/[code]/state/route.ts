import { resolveEstimateLink, estimateAcceptanceState, installWeekOptions, createStatusLink, adminDb, bookingLink, withTenant, job, eq, and } from "@savvy/db";
import { signPayloadToken, requireSecret } from "@savvy/core";

export const runtime = "nodejs";

// Public, token-gated: the page polls this while the homeowner signs and pays.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ code: string }> },
): Promise<Response> {
  const { code } = await params;
  const link = await resolveEstimateLink(code);
  if (!link) return new Response("Not found", { status: 404 });

  const state = await estimateAcceptanceState(link.tenantId, link.estimateId);

  let weeks: string[] = [];
  let statusCode: string | null = null;
  let requestedWeek: string | null = null;
  if (state.accepted && state.jobId) {
    weeks = installWeekOptions(new Date()).map((w) => w.toISOString().slice(0, 10));
    const [j] = await withTenant(link.tenantId, (tx) =>
      tx.select({ requestedInstallWeek: job.requestedInstallWeek }).from(job).where(eq(job.id, state.jobId!)),
    );
    requestedWeek = j?.requestedInstallWeek?.toISOString().slice(0, 10) ?? null;

    // Find-or-create the homeowner status link (deterministic signed token).
    const secret = requireSecret("UNSUBSCRIBE_SECRET", { devFallback: "dev-unsubscribe-secret" });
    const token = signPayloadToken({ tenantId: link.tenantId, jobId: state.jobId }, secret);
    const [existing] = await adminDb
      .select({ code: bookingLink.code })
      .from(bookingLink)
      .where(and(eq(bookingLink.tenantId, link.tenantId), eq(bookingLink.kind, "status"), eq(bookingLink.token, token)));
    statusCode = existing?.code ?? (await createStatusLink({ tenantId: link.tenantId, token }));
  }

  return Response.json({ ...state, weeks, requestedWeek, statusToken: statusCode });
}
