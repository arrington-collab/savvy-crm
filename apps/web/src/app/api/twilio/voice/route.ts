import { NextResponse } from "next/server";
import { withTenant, communication } from "@savvy/db";
import { tenantByPhone, createLeadForTenant } from "@/lib/intake";

export const runtime = "nodejs";

const xml = (body: string) =>
  new NextResponse(body, { status: 200, headers: { "content-type": "text/xml" } });

// Phase 3 voice = after-hours capture stub (NO LLM conversation). First hit:
// greet + <Record>. Twilio re-POSTs to ?event=recording with RecordingUrl.
export async function POST(req: Request) {
  const url = new URL(req.url);
  const form = await req.formData();
  const to = String(form.get("To") ?? "");
  const from = String(form.get("From") ?? "");
  const t = await tenantByPhone(to);
  if (!t) return xml("<Response/>");

  if (url.searchParams.get("event") === "recording") {
    const recordingUrl = String(form.get("RecordingUrl") ?? "");
    const transcript = String(form.get("TranscriptionText") ?? "");
    await withTenant(t.id, (tx) =>
      tx.insert(communication).values({
        tenantId: t.id, channel: "call", direction: "inbound", from,
        recordingUrl: recordingUrl || null, transcript: transcript || null, aiHandled: true,
      }),
    );
    await createLeadForTenant(t.id, { name: `Voicemail ${from}`, phone: from, address: "unknown", source: "after-hours-voicemail" });
    return xml("<Response/>");
  }

  const action = `${url.origin}/api/twilio/voice?event=recording`;
  // Only `action` (not recordingStatusCallback) — using both fires the callback
  // twice and would log a duplicate communication + lead per voicemail.
  return xml(
    `<Response><Say>Thanks for calling. Please leave a message after the tone and we'll call you back.</Say>` +
    `<Record maxLength="120" action="${action}"/></Response>`,
  );
}
