import { NextRequest, NextResponse } from "next/server";
import { applyDeliveryReceipt } from "@savvy/db";

export const runtime = "nodejs";

// Twilio posts application/x-www-form-urlencoded delivery receipts (StatusCallback).
// This handler is fail-soft: it never returns 5xx so Twilio won't retry unnecessarily.
// No signature validation — matches the convention of /api/twilio/inbound/route.ts.
export async function POST(req: NextRequest) {
  const form = await req.formData();
  const sid = String(form.get("MessageSid") ?? form.get("SmsSid") ?? "");
  const status = String(form.get("MessageStatus") ?? form.get("SmsStatus") ?? "");
  const errorCode = form.get("ErrorCode") ? String(form.get("ErrorCode")) : null;
  if (sid && status) {
    try {
      await applyDeliveryReceipt({ twilioSid: sid, status, errorCode });
    } catch {
      /* fail-soft: never 500 a delivery receipt — Twilio would retry endlessly */
    }
  }
  return new NextResponse("", { status: 200 });
}
