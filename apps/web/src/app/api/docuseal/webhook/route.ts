import { NextResponse } from "next/server";
import { adminDb, estimate, markEsignBySubmission, markChangeOrderBySubmission, eq , recordEstimateSigned } from "@savvy/db";
import { httpDocuseal } from "@savvy/integrations";
import { inngest } from "@savvy/agents";
import { log } from "@/lib/log";

export const runtime = "nodejs"; // node:crypto for HMAC signature verification

// Single inbound URL for the Savvy-owned DocuSeal instance. We verify the HMAC
// signature once, parse the event, then route by what the submission belongs to:
//   - an `estimate` (Phase 7)        -> emit estimate/accepted (advances job to approved)
//   - an `esign_request` (Phase 6B)  -> mark completed + emit esign/completed (stores signed PDF)
//   - a `change_order` (Phase 6C)    -> mark approved + emit change_order/accepted (valueFinal + draft invoice)
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
  log.info("docuseal webhook received", { route: "/api/docuseal/webhook", submissionId: ev.submissionId });

  // Estimate signing (Phase 7).
  const [est] = await adminDb
    .select()
    .from(estimate)
    .where(eq(estimate.docusealSubmissionId, ev.submissionId));
  if (est) {
    // Replay/forgery defense-in-depth: ignore already-accepted estimates.
    if (est.status === "accepted") return NextResponse.json({ ok: true });
    try {
      // Slice 3 gate: signing alone no longer accepts — the deposit (when one
      // is required) must settle first. Whichever webhook completes the pair
      // fires the UNCHANGED estimate/accepted chain.
      const { nowReady } = await recordEstimateSigned(est.tenantId, est.id);
      if (nowReady) {
        await inngest.send({ name: "estimate/accepted", data: { tenantId: est.tenantId, estimateId: est.id } });
      }
    } catch (e) {
      log.error("estimate signed handling failed", { route: "/api/docuseal/webhook", tenantId: est.tenantId, msg: String(e) });
    }
    return NextResponse.json({ ok: true });
  }

  // Closeout signing (Phase 6B): lien waiver / cert. markEsignBySubmission resolves
  // the tenant (globally-unique submission id) and is idempotent (changed:false on replay).
  const esign = await markEsignBySubmission({ submissionId: ev.submissionId, status: "completed" });
  if (esign) {
    if (esign.changed) {
      try {
        await inngest.send({ name: "esign/completed", data: { requestId: esign.requestId, tenantId: esign.tenantId } });
      } catch (e) {
        log.error("esign/completed emit failed", { route: "/api/docuseal/webhook", tenantId: esign.tenantId, msg: String(e) });
      }
    }
    return NextResponse.json({ ok: true });
  }

  // Change-order signing (Phase 6C): markChangeOrderBySubmission resolves the tenant
  // (globally-unique submission id) and is idempotent (changed:false on replay).
  const co = await markChangeOrderBySubmission({ submissionId: ev.submissionId });
  if (co && co.changed) {
    try {
      await inngest.send({ name: "change_order/accepted", data: { changeOrderId: co.changeOrderId, tenantId: co.tenantId } });
    } catch (e) {
      log.error("change_order/accepted emit failed", { route: "/api/docuseal/webhook", tenantId: co.tenantId, msg: String(e) });
    }
  }
  return NextResponse.json({ ok: true });
}
