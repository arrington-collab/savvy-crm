import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import {
  requireSecret,
  parseVoiceOutcome,
  signPayloadToken,
  parseVapiMessage,
  toolResult,
  isValidZip,
  buildInboundAssistant,
  parseFinanceConfig,
} from "@savvy/core";
import {
  recordVoiceCallReport,
  bookLeadSlot,
  createBookingLink,
  recommendAssignee,
  setLeadOwner,
  markLeadContacted,
  withTenant,
  getLeadByVoiceCallId,
  setLeadVoiceCallId,
} from "@savvy/db";
import { inngest } from "@savvy/agents";
import { sms, smsFrom, type SmsSender } from "@savvy/integrations";
import { getRecommendedSlots, slotsForRep } from "@/lib/recommended-slots";
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

  // --- Inbound assistant-request: hand Vapi a tenant-branded, live-booking Riley.
  // The Vapi phone number is in Server-URL mode (no static assistant), so Vapi asks
  // us per call which assistant to use. We resolve the tenant by the dialed number
  // and return the inbound persona (collect details -> setCallDetails -> bookSlot).
  if (msg.type === "assistant-request") {
    const t = msg.toNumber ? await tenantByPhone(msg.toNumber) : null;
    if (!t) return NextResponse.json({ error: "No assistant is configured for this number." });
    const tz = parseFinanceConfig((t.settings as { finance?: unknown } | null)?.finance).timezone;
    const assistantOverrides = buildInboundAssistant({ tenantName: t.name, tenantId: t.id, tz });
    // assistantId is undefined when Vapi isn't fully configured (dev/test) -> JSON omits it.
    return NextResponse.json({ assistantId: process.env.VAPI_ASSISTANT_ID, assistantOverrides });
  }

  // --- Mid-call tool dispatch -------------------------------------------------
  if (msg.type === "tool-calls" || msg.type === "function-call") {
    const tc = msg.toolCalls[0];
    if (!tc) return NextResponse.json(toolResult("", { error: "no tool call" }));

    try {
      // Outbound injects tenantId+leadId in metadata; inbound resolves tenant by the dialed number.
      const tenantId =
        msg.metadata.tenantId ?? (msg.toNumber ? ((await tenantByPhone(msg.toNumber))?.id ?? null) : null);

      // --- setCallDetails: capture address+zip, create/find the call's lead, assign rep, offer slots
      if (tc.name === "setCallDetails") {
        if (!tenantId)
          return NextResponse.json(
            toolResult(tc.id, { saved: false, message: "I'll have a specialist call you right back." }),
          );
        const zip = String(tc.args.zip ?? "").trim();
        if (!isValidZip(zip))
          return NextResponse.json(
            toolResult(tc.id, { needZip: true, message: "Please ask the caller to confirm their 5-digit ZIP code." }),
          );
        const name = String(tc.args.name ?? "Inbound caller");
        const address = String(tc.args.address ?? "").trim();
        const city = String(tc.args.city ?? "").trim();
        try {
          const existing = msg.callId ? await getLeadByVoiceCallId(tenantId, msg.callId) : null;
          let leadId = existing?.id;
          if (!leadId) {
            leadId = await createLeadForTenant(tenantId, {
              name,
              phone: msg.fromNumber ?? undefined,
              address: address.length >= 3 ? address : "Unknown",
              source: "inbound-call",
              city: city || undefined,
              zip,
            });
            if (msg.callId)
              await withTenant(tenantId, (tx) =>
                setLeadVoiceCallId(tx, { tenantId, leadId: leadId!, callId: msg.callId! }),
              );
          }
          const repId = await recommendAssignee(tenantId, { zip, city: city || null, state: null });
          if (!repId)
            return NextResponse.json(
              toolResult(tc.id, { saved: true, slots: [], message: "I'll have a specialist call you right back." }),
            );
          await withTenant(tenantId, (tx) => setLeadOwner(tx, { tenantId, leadId: leadId!, userId: repId }));
          const { slots } = await slotsForRep({ tenantId, repId, todayFirst: true, limit: 2 });
          return NextResponse.json(toolResult(tc.id, { saved: true, slots }));
        } catch (e) {
          console.error("setCallDetails failed", e);
          return NextResponse.json(
            toolResult(tc.id, { saved: false, message: "I'll have a specialist call you right back." }),
          );
        }
      }

      // --- getRecommendedSlots / bookSlot: resolve leadId (outbound metadata, else by call.id)
      const leadId =
        msg.metadata.leadId ??
        (tenantId && msg.callId ? ((await getLeadByVoiceCallId(tenantId, msg.callId))?.id ?? null) : null);
      if (!leadId)
        return NextResponse.json(
          toolResult(tc.id, { error: "no lead context", message: "Let's get your address and ZIP first." }),
        );

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
            await withTenant(r.tenantId, (tx) => markLeadContacted(tx, { tenantId: r.tenantId, leadId }));
          } catch (e) {
            console.error(e);
          }
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
    } catch (e) {
      console.error("voice tool-call failed", e);
      return NextResponse.json(toolResult(tc.id, { error: "temporary issue", message: "I'll have a specialist call you right back." }));
    }
  }

  // --- End-of-call report -----------------------------------------------------
  if (msg.type === "end-of-call-report") {
    const outcome = parseVoiceOutcome(msg.outcomeRaw);
    let leadId = msg.metadata.leadId;
    let tenantId = msg.metadata.tenantId;
    const direction: "inbound" | "outbound" = leadId ? "outbound" : "inbound";

    // Inbound: no lead context — resolve tenant by the dialed number. The tool calls
    // may have already created+correlated the lead by call.id; find that before creating.
    if (!leadId && msg.toNumber) {
      try {
        const t = await tenantByPhone(msg.toNumber);
        if (t) {
          tenantId = t.id;
          const existing = msg.callId ? await getLeadByVoiceCallId(t.id, msg.callId) : null;
          if (existing) {
            leadId = existing.id;
          } else if (msg.fromNumber) {
            // Satisfy leadIntakeSchema's phone-or-email refine with the caller's number.
            // address must be min(3) per the schema; use a placeholder for inbound callers.
            leadId = await createLeadForTenant(t.id, {
              name: "Inbound caller",
              phone: msg.fromNumber,
              address: "Unknown",
              source: "inbound-call",
            });
          }
        }
      } catch (e) {
        console.error("inbound lead-from-call failed", e);
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
          const token = signPayloadToken({ leadId, tenantId, type: "inspection" }, secret);
          const code = await createBookingLink({ tenantId, token, expiresAt: new Date(Date.now() + 14 * 86400000) });
          const bookingUrl = `${base}/b/${code}`;
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
