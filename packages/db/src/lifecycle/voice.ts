import { withTenant } from "../tenant";
import { communication } from "../schema/comms";
import { lead } from "../schema/crm";
import { and, eq } from "drizzle-orm";
import type { VoiceOutcome } from "@savvy/core";

type Tx = Parameters<Parameters<typeof import("../client").db.transaction>[0]>[0];

export async function setLeadVoiceCallId(tx: Tx, args: { tenantId: string; leadId: string; callId: string }): Promise<void> {
  await tx.update(lead).set({ voiceCallId: args.callId }).where(and(eq(lead.tenantId, args.tenantId), eq(lead.id, args.leadId)));
}

export async function getLeadByVoiceCallId(
  tenantId: string,
  callId: string,
): Promise<{ id: string; assignedUserId: string | null; propertyId: string | null } | null> {
  return withTenant(tenantId, async (tx) => {
    const [row] = await tx
      .select({ id: lead.id, assignedUserId: lead.assignedUserId, propertyId: lead.propertyId })
      .from(lead)
      .where(and(eq(lead.tenantId, tenantId), eq(lead.voiceCallId, callId)));
    return row ?? null;
  });
}

/**
 * One tenant-scoped tx: log the call transcript as a communication (channel 'call')
 * and stamp lead.voice_outcome. The customerId is resolved from the lead inside the tx.
 */
export async function recordVoiceCallReport(input: {
  tenantId: string;
  leadId: string;
  direction: "inbound" | "outbound";
  transcript: string | null;
  recordingUrl: string | null;
  durationSeconds: number | null;
  providerCallId: string | null;
  outcome: VoiceOutcome | null;
}): Promise<void> {
  await withTenant(input.tenantId, async (tx) => {
    const [l] = await tx.select({ customerId: lead.customerId }).from(lead).where(eq(lead.id, input.leadId));
    await tx.insert(communication).values({
      tenantId: input.tenantId,
      customerId: l?.customerId ?? null,
      channel: "call",
      direction: input.direction,
      transcript: input.transcript,
      recordingUrl: input.recordingUrl,
      durationSeconds: input.durationSeconds,
      twilioSid: input.providerCallId,
      aiHandled: true,
    });
    if (input.outcome) {
      await tx.update(lead).set({ voiceOutcome: input.outcome }).where(eq(lead.id, input.leadId));
    }
  });
}

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
