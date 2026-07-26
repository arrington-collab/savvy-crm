import { NextResponse } from "next/server";
import { tenantByPhone } from "@/lib/intake";
import { createLeadForTenant, DrizzleOrchestratorStore } from "@savvy/db";
import { inngest } from "@savvy/agents";
import { publishDomainEvent, makeEvent } from "@savvy/orchestrator";
import { log } from "@/lib/log";

export const runtime = "nodejs";

const xml = (body: string) =>
  new NextResponse(body, { status: 200, headers: { "content-type": "text/xml" } });

const MISSED_STATUSES = new Set(["no-answer", "busy", "failed"]);

// Twilio call-status callback (voice-status). Fires for BOTH the call resource
// (CallStatus) and a <Dial> action (DialCallStatus) — read both, since which
// field carries the terminal status depends on how the call was routed.
// Acts ONLY on a missed call: creates the lead (via the @savvy/db-level
// createLeadForTenant, NOT the web wrapper — that wrapper emits lead/created,
// which would fire lead-intake's own ack SMS and double-text the caller
// alongside C3's missed-call text-back), fires call/missed for C3 to consume,
// and fail-soft bridge-publishes call.missed onto the domain-event bus.
export async function POST(req: Request) {
  const form = await req.formData();
  const to = String(form.get("To") ?? "");
  const from = String(form.get("From") ?? "");
  const callSid = String(form.get("CallSid") ?? "");
  const dialCallStatus = String(form.get("DialCallStatus") ?? "");
  const callStatus = String(form.get("CallStatus") ?? "");

  const missed = MISSED_STATUSES.has(dialCallStatus) || MISSED_STATUSES.has(callStatus);
  if (!missed) return xml("<Response/>");

  const t = await tenantByPhone(to);
  if (!t) return xml("<Response/>");
  log.info("twilio voice-status missed call", { route: "/api/twilio/voice-status", status: dialCallStatus || callStatus });

  const leadId = await createLeadForTenant(t.id, {
    name: `Missed call ${from}`,
    phone: from,
    address: "unknown",
    source: "missed_call",
  });

  try {
    await inngest.send({ name: "call/missed", data: { tenantId: t.id, leadId, fromNumber: from, toNumber: to } });
  } catch (err) {
    // Lead is already persisted; a missing Inngest engine must not fail the webhook.
    console.error("call/missed send failed (lead still created):", err);
  }

  // Fail-soft bridge-publish: the domain-event bus is a read-model projection,
  // never a blocker for the webhook response. CallSid makes the idempotency
  // key unique per call so retries/re-POSTs don't double-publish.
  try {
    const store = new DrizzleOrchestratorStore();
    await publishDomainEvent(store, makeEvent({
      type: "call.missed", source: "savvy", tenantId: t.id,
      correlationId: from, idempotencyKey: `call.missed:${from}:${to}:${callSid}`,
      payload: { leadId, fromNumber: from, toNumber: to },
    }));
  } catch (e) { console.error("bridge-call-missed: failed to publish call.missed", e); }

  return xml("<Response/>");
}
