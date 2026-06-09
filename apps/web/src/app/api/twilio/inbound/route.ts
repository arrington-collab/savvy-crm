import { NextResponse } from "next/server";
import { createLeadForTenant, tenantByPhone } from "@/lib/intake";

export const runtime = "nodejs";

// Twilio posts application/x-www-form-urlencoded. The number called (To) maps
// to a tenant; the caller (From) becomes the lead.
export async function POST(req: Request) {
  const form = await req.formData();
  const to = String(form.get("To") ?? "");
  const from = String(form.get("From") ?? "");
  const t = await tenantByPhone(to);
  if (!t) {
    return new NextResponse("<Response/>", { status: 200, headers: { "content-type": "text/xml" } });
  }
  await createLeadForTenant(t.id, { name: `Caller ${from}`, phone: from, address: "unknown", source: "inbound-call" });
  return new NextResponse(
    "<Response><Say>Thanks for calling. We'll text you a booking link.</Say></Response>",
    { status: 200, headers: { "content-type": "text/xml" } },
  );
}
