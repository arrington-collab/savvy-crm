import type { AssistantOverrides } from "@savvy/core";

export interface VoiceGateway {
  /** Places an outbound call. Returns the provider call id, or null on no-key/error (fail-open). */
  placeOutboundCall(o: {
    toPhone: string;
    assistantOverrides: AssistantOverrides;
    metadata: Record<string, string>;
  }): Promise<{ callId: string } | null>;
}

const VAPI_BASE = "https://api.vapi.ai";

export const httpVapi: VoiceGateway = {
  async placeOutboundCall({ toPhone, assistantOverrides, metadata }) {
    const key = process.env.VAPI_API_KEY;
    const assistantId = process.env.VAPI_ASSISTANT_ID;
    const phoneNumberId = process.env.VAPI_PHONE_NUMBER_ID;
    if (!key || !assistantId || !phoneNumberId) return null; // fail-open: not fully configured
    try {
      const res = await fetch(`${VAPI_BASE}/call`, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({
          assistantId,
          phoneNumberId,
          assistantOverrides,
          customer: { number: toPhone },
          metadata,
        }),
      });
      if (!res.ok) return null;
      const d = (await res.json()) as { id?: string };
      return d.id ? { callId: d.id } : null;
    } catch {
      return null;
    }
  },
};

export function makeFakeVoice(): VoiceGateway & { calls: { toPhone: string; metadata: Record<string, string> }[] } {
  const calls: { toPhone: string; metadata: Record<string, string> }[] = [];
  let n = 0;
  return {
    calls,
    async placeOutboundCall({ toPhone, metadata }) {
      n += 1;
      calls.push({ toPhone, metadata });
      return { callId: `fake-call-${n}` };
    },
  };
}

export const voice: VoiceGateway = process.env.VAPI_API_KEY ? httpVapi : makeFakeVoice();
