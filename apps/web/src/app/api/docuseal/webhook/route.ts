import { NextResponse } from "next/server";
import { docusealGateway } from "@savvy/integrations";
import { markEsignBySubmission } from "@savvy/db";
import { inngest } from "@savvy/agents";

export const runtime = "nodejs";

export async function POST(req: Request): Promise<NextResponse> {
  const raw = await req.text(); // raw body required for signature verification
  const sig = req.headers.get("x-docuseal-signature");
  const evt = docusealGateway.verifyWebhook(raw, sig);
  if (!evt) return new NextResponse("bad signature", { status: 400 });

  try {
    const r = await markEsignBySubmission({ submissionId: evt.submissionId, status: evt.status });
    // Only emit when we actually transitioned a request into completed (idempotent).
    if (r && r.changed && evt.status === "completed") {
      try {
        await inngest.send({ name: "esign/completed", data: { requestId: r.requestId, tenantId: r.tenantId } });
      } catch (e) {
        console.error(e);
      }
    }
  } catch (e) {
    // Unknown/duplicate handled inside markEsignBySubmission; log other errors but still 200
    // so DocuSeal doesn't hammer retries on a poison event.
    console.error("docuseal webhook", e);
  }
  return NextResponse.json({ received: true });
}
