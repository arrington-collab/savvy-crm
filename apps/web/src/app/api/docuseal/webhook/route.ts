import { NextResponse } from "next/server";
import { adminDb, estimate, esignRequest, markEsignBySubmission, eq } from "@savvy/db";
import { httpDocuseal } from "@savvy/integrations";
import { inngest } from "@savvy/agents";

export const runtime = "nodejs"; // node:crypto for HMAC signature verification

// Single inbound URL for the Savvy-owned DocuSeal instance. We verify the HMAC
// signature once, parse the event, then route by what the submission belongs to:
//   - an `estimate` (Phase 7)        -> emit estimate/accepted (advances job to approved)
//   - an `esign_request` (Phase 6B)  -> mark completed + emit esign/completed (stores signed PDF)
export async function POST(req: Request): Promise<NextResponse> {
  const raw = await req.text(); // raw body required for signature verification
  const sig = req.headers.get("x-docuseal-signature");
  if (!httpDocuseal.verifyWebhook(raw, sig)) {
    return new NextResponse("bad signature", { status: 401 });
  }

  let payload: unknown = null;
  try {
    payload = JSON.parse(raw);
  } catch {
    return new NextResponse("bad payload", { status: 400 });
  }

  const ev = httpDocuseal.parseEvent(payload);
  if (!ev || ev.status !== "completed") return NextResponse.json({ ok: true });

  // Estimate signing (Phase 7).
  const [est] = await adminDb
    .select()
    .from(estimate)
    .where(eq(estimate.docusealSubmissionId, ev.submissionId));
  if (est) {
    // Replay/forgery defense-in-depth: ignore already-accepted estimates.
    if (est.status === "accepted") return NextResponse.json({ ok: true });
    try {
      await inngest.send({ name: "estimate/accepted", data: { tenantId: est.tenantId, estimateId: est.id } });
    } catch (e) {
      console.error(e);
    }
    return NextResponse.json({ ok: true });
  }

  // Closeout signing (Phase 6B): lien waiver / cert. markEsignBySubmission resolves
  // the tenant (globally-unique submission id) and is idempotent (changed:false on replay).
  try {
    const r = await markEsignBySubmission({ submissionId: ev.submissionId, status: "completed" });
    if (r && r.changed) {
      try {
        await inngest.send({ name: "esign/completed", data: { requestId: r.requestId, tenantId: r.tenantId } });
      } catch (e) {
        console.error(e);
      }
    }
  } catch (e) {
    console.error("docuseal esign webhook", e);
  }
  return NextResponse.json({ ok: true });
}
