import type { SmsSender } from "./twilio";

export interface RingCentralConfig {
  serverUrl: string;
  clientId: string;
  clientSecret: string;
  jwt: string;
  from: string;
  fetchImpl?: typeof fetch;
}

const JWT_GRANT = "urn:ietf:params:oauth:grant-type:jwt-bearer";

/** Factory so tests inject fetch; the token cache is closure-local (per instance). */
// No promise dedup: two concurrent cold calls each fetch a token; both are valid (RC allows multiple active tokens). One wasted auth, never a failure.
export function makeRingCentralSms(cfg: RingCentralConfig): SmsSender {
  const doFetch = cfg.fetchImpl ?? fetch;
  let cached: { token: string; expiresAt: number } | null = null;

  async function token(): Promise<string> {
    const now = Date.now();
    if (cached && now < cached.expiresAt - 60_000) return cached.token;
    const res = await doFetch(`${cfg.serverUrl}/restapi/oauth/token`, {
      method: "POST",
      headers: {
        authorization: "Basic " + Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64"),
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ grant_type: JWT_GRANT, assertion: cfg.jwt }).toString(),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`ringcentral auth failed: ${res.status} ${detail}`);
    }
    const data = (await res.json()) as { access_token: string; expires_in: number };
    cached = { token: data.access_token, expiresAt: now + data.expires_in * 1000 };
    return cached.token;
  }

  return {
    async sendSms({ to, from, body }) {
      const at = await token();
      const res = await doFetch(`${cfg.serverUrl}/restapi/v1.0/account/~/extension/~/sms`, {
        method: "POST",
        headers: { authorization: `Bearer ${at}`, "content-type": "application/json" },
        body: JSON.stringify({ from: { phoneNumber: from }, to: [{ phoneNumber: to }], text: body }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`ringcentral send failed: ${res.status} ${detail}`);
      }
      const data = (await res.json()) as { id: number | string };
      return { sid: String(data.id) };
    },
  };
}

// Real instance bound to env. Feature code uses the `sms` selector (comms.ts), not this directly.
export const ringcentralSms: SmsSender = makeRingCentralSms({
  serverUrl: process.env.RINGCENTRAL_SERVER_URL ?? "https://platform.ringcentral.com",
  clientId: process.env.RINGCENTRAL_CLIENT_ID ?? "",
  clientSecret: process.env.RINGCENTRAL_CLIENT_SECRET ?? "",
  jwt: process.env.RINGCENTRAL_JWT ?? "",
  from: process.env.RINGCENTRAL_FROM_NUMBER ?? "",
});
