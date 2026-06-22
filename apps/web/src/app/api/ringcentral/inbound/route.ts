import { NextResponse } from "next/server";
import { parseRingCentralInboundSms } from "@savvy/integrations";
import { tenantByPhone } from "@/lib/intake";
import { handleInboundSms } from "@/lib/inbound-sms";
import { log } from "@/lib/log";

export const runtime = "nodejs";

// RingCentral webhook. Two non-event cases first:
//  1) Subscription creation/renewal handshake: RC sends a `Validation-Token` header
//     that MUST be echoed back verbatim (200, empty body).
//  2) Per-delivery auth: RC echoes the `verificationToken` we set at subscribe time
//     in the `Verification-Token` header; reject mismatches when we have one configured.
export async function POST(req: Request) {
  const validation = req.headers.get("Validation-Token");
  if (validation) {
    return new NextResponse(null, { status: 200, headers: { "Validation-Token": validation } });
  }
  const expected = process.env.RINGCENTRAL_WEBHOOK_TOKEN;
  if (expected && req.headers.get("Verification-Token") !== expected) {
    return new NextResponse("unauthorized", { status: 401 });
  }

  const payload = await req.json().catch(() => null);
  const items = parseRingCentralInboundSms(payload);
  log.info("ringcentral inbound received", { route: "/api/ringcentral/inbound", items: items.length });
  for (const it of items) {
    const t = await tenantByPhone(it.to);
    if (!t) continue;
    await handleInboundSms(t.id, { from: it.from, body: it.body, twilioSid: it.messageId });
  }
  return NextResponse.json({ ok: true });
}
