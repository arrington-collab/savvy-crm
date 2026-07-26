import { NextResponse } from "next/server";
import { createLeadForTenant, tenantByPhone } from "@/lib/intake";
import { handleInboundSms } from "@/lib/inbound-sms";
import { log } from "@/lib/log";
import { isStopKeyword } from "@savvy/core";
import { suppress } from "@savvy/db";

export const runtime = "nodejs";

const xml = (body: string) =>
  new NextResponse(body, { status: 200, headers: { "content-type": "text/xml" } });

const escapeXml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Whole-body HELP/INFO keyword (case-insensitive) — distinct from STOP. */
function isHelpKeyword(body: string): boolean {
  const trimmed = body.trim().toLowerCase();
  return trimmed === "help" || trimmed === "info";
}

// Twilio posts application/x-www-form-urlencoded. A `Body` field means SMS;
// otherwise it's a voice call. `To` maps to the tenant; `From` is the contact.
export async function POST(req: Request) {
  const form = await req.formData();
  const to = String(form.get("To") ?? "");
  const from = String(form.get("From") ?? "");
  const body = form.get("Body");
  const sid = form.get("MessageSid");
  const t = await tenantByPhone(to);
  if (!t) return xml("<Response/>");
  log.info("twilio inbound received", { route: "/api/twilio/inbound", kind: body !== null ? "sms" : "voice" });

  if (body !== null) {
    const bodyStr = String(body);
    // Existing per-customer opt-out/CANCEL/drip-stop handling (unchanged, additive).
    await handleInboundSms(t.id, { from, body: bodyStr, twilioSid: sid ? String(sid) : undefined });

    // STOP -> GLOBAL suppression (applies across every agent/channel), takes precedence over HELP.
    if (isStopKeyword(bodyStr)) {
      await suppress({ tenantId: t.id, phoneE164: from, channel: "sms", reason: "stop", source: "twilio-inbound" });
      return xml(
        "<Response><Message>You're unsubscribed and won't receive more texts. Reply START to opt back in.</Message></Response>",
      );
    }

    // HELP/INFO -> info reply, no suppression.
    if (isHelpKeyword(bodyStr)) {
      const who = t.name ? `${escapeXml(t.name)}: ` : "";
      return xml(`<Response><Message>${who}Msg &amp; data rates may apply. Reply STOP to opt out.</Message></Response>`);
    }

    return xml("<Response/>");
  }

  // Inbound voice call -> create a lead (unchanged behavior).
  await createLeadForTenant(t.id, { name: `Caller ${from}`, phone: from, address: "unknown", source: "inbound_call" });
  return xml("<Response><Say>Thanks for calling. We'll text you a booking link.</Say></Response>");
}
