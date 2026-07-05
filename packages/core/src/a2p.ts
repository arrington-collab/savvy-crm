/** Per-tenant A2P 10DLC registration state (Cell 6). Stored on the Twilio
 *  integration_connection.metadata.a2p; empty until the owner registers. */
export interface A2pState {
  brandStatus: string | null;
  campaignStatus: string | null;
  messagingServiceSid: string | null;
}

export const A2P_REGISTERED_STATUSES = ["verified", "registered", "active"] as const;

/** True only when the connection is active, a Messaging Service exists, and the
 *  campaign is in a registered status — i.e. SMS can flow through A2P. */
export function isA2pRegistered(state: A2pState | null, connectionActive: boolean): boolean {
  if (!state || !connectionActive) return false;
  if (!state.messagingServiceSid) return false;
  const s = (state.campaignStatus ?? "").toLowerCase();
  return (A2P_REGISTERED_STATUSES as readonly string[]).includes(s);
}
