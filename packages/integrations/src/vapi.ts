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

export interface VapiApiCreds {
  apiKey: string;
  assistantId: string;
  phoneNumberId: string;
}

/** Build a VoiceGateway from explicit creds (per-tenant BYO or platform env). */
export function makeHttpVapi(creds: VapiApiCreds, fetchImpl: typeof fetch = fetch): VoiceGateway {
  return {
    async placeOutboundCall({ toPhone, assistantOverrides, metadata }) {
      if (!creds.apiKey || !creds.assistantId || !creds.phoneNumberId) return null;
      try {
        const res = await fetchImpl(`${VAPI_BASE}/call`, {
          method: "POST",
          headers: { authorization: `Bearer ${creds.apiKey}`, "content-type": "application/json" },
          body: JSON.stringify({
            assistantId: creds.assistantId,
            phoneNumberId: creds.phoneNumberId,
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
}

/**
 * Cheap auth check: GET BOTH the assistant and the phone-number resources.
 * Both 2xx ⇒ creds valid. Checking the phone-number id here (not just the
 * assistant) means Test-connection catches a wrong phoneNumberId now, instead
 * of it silently failing at the first outbound dial.
 */
export async function verifyVapiCreds(
  creds: { apiKey: string; assistantId: string; phoneNumberId: string },
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const headers = { authorization: `Bearer ${creds.apiKey}` };
    const [assistant, phoneNumber] = await Promise.all([
      fetchImpl(`${VAPI_BASE}/assistant/${creds.assistantId}`, { headers }),
      fetchImpl(`${VAPI_BASE}/phone-number/${creds.phoneNumberId}`, { headers }),
    ]);
    return assistant.ok && phoneNumber.ok;
  } catch {
    return false;
  }
}

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
