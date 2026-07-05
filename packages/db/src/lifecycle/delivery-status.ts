import { and, eq, like } from "drizzle-orm";
import { adminDb } from "../admin-client";
import { communication } from "../schema/index";

/** Apply a Twilio delivery receipt to the communication row(s) with this SID.
 *  The status webhook has no tenant session, so this is admin-scoped and keyed
 *  ONLY on the globally-unique twilio_sid. Returns rows updated (0 = unknown SID).
 *
 *  Guard: real Twilio SIDs start with "SM". Anything else (e.g. "mock") is a
 *  no-op so dev/test sentinel values never corrupt real data. */
export async function applyDeliveryReceipt(input: {
  twilioSid: string; status: string; errorCode?: string | null;
}): Promise<{ updated: number }> {
  // Fast-path: reject non-SM SIDs immediately (defense-in-depth against mock sentinels)
  if (!input.twilioSid.startsWith("SM")) return { updated: 0 };

  const rows = await adminDb
    .update(communication)
    .set({ deliveryStatus: input.status, deliveryErrorCode: input.errorCode ?? null })
    .where(and(eq(communication.twilioSid, input.twilioSid), like(communication.twilioSid, "SM%")))
    .returning({ id: communication.id });
  return { updated: rows.length };
}
