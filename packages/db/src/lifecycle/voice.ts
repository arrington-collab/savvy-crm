import { withTenant } from "../tenant";
import { communication } from "../schema/comms";
import { eq } from "drizzle-orm";

/**
 * Fills in the final call duration on the communication row created by the
 * <Record> action callback, correlated by Twilio's CallSid (communication.twilioSid).
 *
 * Called from the voice status callback at call-end. Idempotent: re-delivery of
 * the same callback just rewrites the same value, and it never inserts — so the
 * action callback (which owns the row + lead) and the status callback can't
 * produce a duplicate communication. This is what feeds the AI-voice-minutes
 * meter (sum of durationSeconds where channel='call').
 */
export async function setCallDuration(tenantId: string, twilioSid: string, durationSeconds: number) {
  return withTenant(tenantId, (tx) =>
    tx
      .update(communication)
      .set({ durationSeconds })
      .where(eq(communication.twilioSid, twilioSid)),
  );
}
