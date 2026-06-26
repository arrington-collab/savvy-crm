import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { requireSecret, parseVoiceOutcome, signPayloadToken, parseVapiMessage, toolResult } from "@savvy/core";
import { recordVoiceCallReport, bookLeadSlot } from "@savvy/db";
import { inngest } from "@savvy/agents";
import { sms, smsFrom, type SmsSender } from "@savvy/integrations";
import { getRecommendedSlots } from "@/lib/recommended-slots";
import { tenantByPhone, createLeadForTenant } from "@/lib/intake";

export const runtime = "nodejs"; // node:crypto + DB

// Repo webhook posture (mirrors /api/ringcentral/inbound + lib/svix.ts): no secret
// configured => allow in dev/test, FAIL CLOSED in production. A clean 401, never a 500.
// (Do NOT use requireSecret here — it THROWS in prod when unset, which would 500 every
// webhook call and contradict "inert but deployable".)
function secretOk(provided: string | null): boolean {
  const expected = process.env.VAPI_WEBHOOK_SECRET;
  if (!expected) return process.env.NODE_ENV !== "production";
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(req: Request): Promise<NextResponse> {
  if (!secretOk(req.headers.get("x-vapi-secret"))) {
    return new NextResponse("unauthorized", { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new NextResponse("bad payload", { status: 400 });
  }
  const msg = parseVapiMessage(body);

  // --- Mid-call tool dispatch -------------------------------------------------
  if (msg.type === "tool-calls" || msg.type === "function-call") {
    const leadId = msg.metadata.leadId;
    const tc = msg.toolCalls[0];
    if (!tc) return NextResponse.json(toolResult("", { error: "no tool call" }));
    if (!leadId) return NextResponse.json(toolResult(tc.id, { error: "no lead context" }));

    if (tc.name === "getRecommendedSlots") {
      const r = await getRecommendedSlots(leadId);
      if ("error" in r)
        return NextResponse.json(toolResult(tc.id, { slots: [], message: "No times available right now." }));
      return NextResponse.json(toolResult(tc.id, { slots: r.slots }));
    }
    if (tc.name === "bookSlot") {
      const startsAt = String(tc.args.startsAt ?? "");
      const endsAt = String(tc.args.endsAt ?? "");
      const r = await bookLeadSlot({ leadId, startsAt, endsAt });
      if ("appointmentId" in r) {
        try {
          await inngest.send({
            name: "appointment/booked",
            data: { appointmentId: r.appointmentId, tenantId: r.tenantId },
          });
        } catch (e) {
          console.error(e);
        }
        return NextResponse.json(toolResult(tc.id, { booked: true }));
      }
      const message =
        r.error === "slot_taken"
          ? "That time was just taken — offer another."
          : "Could not book — offer to have a rep follow up.";
      return NextResponse.json(toolResult(tc.id, { booked: false, message }));
    }
    return NextResponse.json(toolResult(tc.id, { error: "unknown tool" }));
  }

  // --- End-of-call report -----------------------------------------------------
  if (msg.type === "end-of-call-report") {
    const outcome = parseVoiceOutcome(msg.outcomeRaw);
    let leadId = msg.metadata.leadId;
    let tenantId = msg.metadata.tenantId;
    const direction: "inbound" | "outbound" = leadId ? "outbound" : "inbound";

    // Inbound: no lead context — resolve tenant by the dialed number, create a lead-from-call.
    if (!leadId && msg.toNumber) {
      const t = await tenantByPhone(msg.toNumber);
      if (t) {
        tenantId = t.id;
        try {
          // Satisfy leadIntakeSchema's phone-or-email refine with the caller's number.
          // address must be min(3) per the schema; use a placeholder for inbound callers.
          if (msg.fromNumber) {
            leadId = await createLeadForTenant(t.id, {
              name: "Inbound caller",
              phone: msg.fromNumber,
              address: "Unknown",
              source: "inbound-call",
            });
          }
        } catch (e) {
          console.error("inbound lead-from-call failed", e);
        }
      }
    }

    if (leadId && tenantId) {
      try {
        await recordVoiceCallReport({
          tenantId,
          leadId,
          direction,
          transcript: msg.transcript,
          recordingUrl: msg.recordingUrl,
          durationSeconds: msg.durationSeconds,
          providerCallId: msg.callId,
          outcome,
        });
      } catch (e) {
        console.error("recordVoiceCallReport failed", e);
      }

      // No-answer fallback: text the self-schedule link (best-effort).
      if (outcome === "no_answer") {
        try {
          const base = process.env.APP_BASE_URL ?? "http://localhost:3000";
          const secret = requireSecret("UNSUBSCRIBE_SECRET", { devFallback: "dev-unsubscribe-secret" });
          const bookingUrl = `${base}/book/${signPayloadToken({ leadId, tenantId, type: "inspection" }, secret)}`;
          // outbound stamps toPhone in metadata; inbound uses caller's number
          const to = msg.metadata.toPhone ?? msg.fromNumber;
          if (to) {
            await (sms as SmsSender).sendSms({
              to,
              from: smsFrom(),
              body: `Sorry we missed you! Book your free roof inspection here: ${bookingUrl}`,
            });
          }
        } catch (e) {
          console.error("no-answer SMS failed", e);
        }
      }
    }
    return NextResponse.json({ ok: true });
  }

  // Status updates etc. — acknowledge, no-op.
  return NextResponse.json({ ok: true });
}
