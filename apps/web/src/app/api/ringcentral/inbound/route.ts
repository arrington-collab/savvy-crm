import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { parseRingCentralInboundSms } from "@savvy/integrations";
import { tenantByPhone } from "@/lib/intake";
import { handleInboundSms } from "@/lib/inbound-sms";
import { log } from "@/lib/log";

export const runtime = "nodejs";

function tokenOk(provided: string | null): boolean {
  const expected = process.env.RINGCENTRAL_WEBHOOK_TOKEN;
  // Match the repo's webhook posture (lib/svix.ts): no secret configured =>
  // allow only in dev/test, fail closed in production.
  if (!expected) return process.env.NODE_ENV !== "production";
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// RingCentral webhook.
//  1) Subscription creation/renewal handshake: RC sends a `Validation-Token` header
//     that MUST be echoed back verbatim (200, empty body). This precedes auth.
//  2) Otherwise verify the `Verification-Token` (fail-closed in prod).
export async function POST(req: Request) {
  const validation = req.headers.get("Validation-Token");
  if (validation) {
    return new NextResponse(null, { status: 200, headers: { "Validation-Token": validation } });
  }
  if (!tokenOk(req.headers.get("Verification-Token"))) {
    return new NextResponse("unauthorized", { status: 401 });
  }

  const payload = await req.json().catch(() => null);
  const items = parseRingCentralInboundSms(payload);
  log.info("ringcentral inbound received", { route: "/api/ringcentral/inbound", items: items.length });
  for (const it of items) {
    const t = await tenantByPhone(it.to);
    if (!t) continue;
    // twilioSid column reused for the RC messageId (provider-neutral rename deferred).
    await handleInboundSms(t.id, { from: it.from, body: it.body, twilioSid: it.messageId });
  }
  return NextResponse.json({ ok: true });
}
