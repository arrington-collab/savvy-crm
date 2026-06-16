import { NextResponse } from "next/server";
import { adminDb, estimate, eq } from "@savvy/db";
import { httpDocuseal } from "@savvy/integrations";
import { inngest } from "@savvy/agents";

export const runtime = "nodejs"; // node:crypto for HMAC signature verification

// DocuSeal posts submission lifecycle events here. We verify the HMAC signature
// (enforced when DOCUSEAL_WEBHOOK_SECRET is set), then on `form.completed`
// resolve the tenant from the estimate matched by submissionId (adminDb — RLS
// root) and emit estimate/accepted, which advances the job to approved.
export async function POST(req: Request) {
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

  const [est] = await adminDb
    .select()
    .from(estimate)
    .where(eq(estimate.docusealSubmissionId, ev.submissionId));
  // Replay/forgery defense-in-depth: ignore unknown ids and already-accepted estimates.
  if (!est || est.status === "accepted") return NextResponse.json({ ok: true });

  try {
    await inngest.send({ name: "estimate/accepted", data: { tenantId: est.tenantId, estimateId: est.id } });
  } catch (e) {
    console.error(e);
  }
  return NextResponse.json({ ok: true });
}
