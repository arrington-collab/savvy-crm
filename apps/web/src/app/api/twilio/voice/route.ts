import { NextResponse } from "next/server";
import { withTenant, communication, setCallDuration } from "@savvy/db";
import { tenantByPhone, createLeadForTenant } from "@/lib/intake";
import { log } from "@/lib/log";

export const runtime = "nodejs";

const xml = (body: string) =>
  new NextResponse(body, { status: 200, headers: { "content-type": "text/xml" } });

// Twilio reports duration as whole seconds in a string field; absent on the
// first <Record> action hit, present on the status callback at call/recording end.
const secs = (v: FormDataEntryValue | null): number | null => {
  const n = v == null ? NaN : parseInt(String(v), 10);
  return Number.isFinite(n) ? n : null;
};

// Phase 3 voice = after-hours capture stub (NO LLM conversation). First hit:
// greet + <Record>. Twilio re-POSTs to ?event=recording with RecordingUrl, then
// (at recording end) to ?event=status with the final duration.
export async function POST(req: Request) {
  const url = new URL(req.url);
  const form = await req.formData();
  const to = String(form.get("To") ?? "");
  const from = String(form.get("From") ?? "");
  const callSid = String(form.get("CallSid") ?? "");
  const t = await tenantByPhone(to);
  if (!t) return xml("<Response/>");
  log.info("twilio voice received", { route: "/api/twilio/voice", event: url.searchParams.get("event") ?? "greeting" });

  if (url.searchParams.get("event") === "recording") {
    const recordingUrl = String(form.get("RecordingUrl") ?? "");
    const transcript = String(form.get("TranscriptionText") ?? "");
    // RecordingDuration is on the <Record> action callback; CallDuration only on a
    // call status callback. Store whichever we have now; ?event=status fills the
    // authoritative value at call-end. twilioSid (CallSid) correlates the two.
    const duration = secs(form.get("RecordingDuration")) ?? secs(form.get("CallDuration"));
    await withTenant(t.id, (tx) =>
      tx.insert(communication).values({
        tenantId: t.id, channel: "call", direction: "inbound", from,
        recordingUrl: recordingUrl || null, transcript: transcript || null, aiHandled: true,
        twilioSid: callSid || null, durationSeconds: duration,
      }),
    );
    await createLeadForTenant(t.id, { name: `Voicemail ${from}`, phone: from, address: "unknown", source: "after-hours-voicemail" });
    return xml("<Response/>");
  }

  // Status callback at call/recording end: fill the final duration onto the row
  // the action callback created (matched by CallSid). UPDATE only — never insert
  // and never create a lead, so action + status callbacks can't duplicate a
  // communication. This is what makes the AI-voice-minutes meter accurate.
  if (url.searchParams.get("event") === "status") {
    const duration = secs(form.get("RecordingDuration")) ?? secs(form.get("CallDuration"));
    if (callSid && duration != null) await setCallDuration(t.id, callSid, duration);
    return xml("<Response/>");
  }

  const origin = url.origin;
  return xml(
    `<Response><Say>Thanks for calling. Please leave a message after the tone and we'll call you back.</Say>` +
    `<Record maxLength="120" action="${origin}/api/twilio/voice?event=recording"` +
    ` recordingStatusCallback="${origin}/api/twilio/voice?event=status" recordingStatusCallbackEvent="completed"/></Response>`,
  );
}
