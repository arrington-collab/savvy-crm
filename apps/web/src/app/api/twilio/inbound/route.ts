import { NextResponse } from "next/server";
import { createLeadForTenant, tenantByPhone } from "@/lib/intake";
import { handleInboundSms } from "@/lib/inbound-sms";

export const runtime = "nodejs";

const xml = (body: string) =>
  new NextResponse(body, { status: 200, headers: { "content-type": "text/xml" } });

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

  if (body !== null) {
    // Inbound SMS: log + stop/opt-out. (Lead creation from SMS stays out of scope here.)
    await handleInboundSms(t.id, { from, body: String(body), twilioSid: sid ? String(sid) : undefined });
    return xml("<Response/>");
  }

  // Inbound voice call -> create a lead (unchanged behavior).
  await createLeadForTenant(t.id, { name: `Caller ${from}`, phone: from, address: "unknown", source: "inbound-call" });
  return xml("<Response><Say>Thanks for calling. We'll text you a booking link.</Say></Response>");
}
