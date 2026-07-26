import twilio from "twilio";

export interface SmsSender {
  sendSms(opts: {
    to: string;
    from: string;
    body: string;
    statusCallback?: string;
    messagingServiceSid?: string;
  }): Promise<{ sid: string }>;
}

export interface TwilioApiCreds {
  accountSid: string;
  authToken: string;
}

// Minimal type for the Twilio messages resource needed by this module.
interface TwilioMessagesClient {
  messages: {
    create(payload: Record<string, unknown>): Promise<{ sid: string }>;
  };
}

/**
 * Build an SmsSender from a pre-constructed Twilio client.
 * Exported for testing — keeps makeTwilioSms(creds) and twilioSms unchanged.
 */
export function makeTwilioSmsWithClient(client: TwilioMessagesClient): SmsSender {
  return {
    async sendSms({ to, from, body, statusCallback, messagingServiceSid }) {
      const payload: Record<string, unknown> = { to, from, body };
      if (statusCallback) payload.statusCallback = statusCallback;
      if (messagingServiceSid) payload.messagingServiceSid = messagingServiceSid;
      const msg = await client.messages.create(payload);
      return { sid: msg.sid };
    },
  };
}

/** Build an SmsSender from explicit creds (per-tenant BYO or platform env). */
export function makeTwilioSms(creds: TwilioApiCreds): SmsSender {
  return {
    async sendSms(opts) {
      const client = twilio(creds.accountSid, creds.authToken);
      return makeTwilioSmsWithClient(client as unknown as TwilioMessagesClient).sendSms(opts);
    },
  };
}

/** Cheap auth check: GET the account resource. 2xx ⇒ creds valid. */
export async function verifyTwilioCreds(
  creds: TwilioApiCreds,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const res = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${creds.accountSid}.json`, {
    headers: {
      authorization: "Basic " + Buffer.from(`${creds.accountSid}:${creds.authToken}`).toString("base64"),
    },
  });
  return res.ok;
}

// Platform instance — reads env at call time (unchanged behavior). Used when
// telephony_mode = 'platform'. Tests inject a mock SmsSender instead.
export const twilioSms: SmsSender = {
  async sendSms(opts) {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    // No real platform Twilio configured (dev / CI / the current mock-only prod):
    // do NOT hit a carrier. Return a clearly-mock sid so callers record a mock
    // communication instead of throwing on missing creds. Real creds → real send.
    if (!accountSid || !authToken) {
      return { sid: `mock-${opts.to}` };
    }
    return makeTwilioSms({ accountSid, authToken }).sendSms(opts);
  },
};
