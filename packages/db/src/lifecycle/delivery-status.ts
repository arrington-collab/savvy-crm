import { eq } from "drizzle-orm";
import { adminDb } from "../admin-client";
import { communication } from "../schema/index";

/** Apply a Twilio delivery receipt to the communication row(s) with this SID.
 *  The status webhook has no tenant session, so this is admin-scoped and keyed
 *  ONLY on the globally-unique twilio_sid. Returns rows updated (0 = unknown SID). */
export async function applyDeliveryReceipt(input: {
  twilioSid: string; status: string; errorCode?: string | null;
}): Promise<{ updated: number }> {
  const rows = await adminDb
    .update(communication)
    .set({ deliveryStatus: input.status, deliveryErrorCode: input.errorCode ?? null })
    .where(eq(communication.twilioSid, input.twilioSid))
    .returning({ id: communication.id });
  return { updated: rows.length };
}
