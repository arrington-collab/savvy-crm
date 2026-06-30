import twilio from "twilio";

export interface SmsSender {
  sendSms(opts: { to: string; from: string; body: string }): Promise<{ sid: string }>;
}

export interface TwilioApiCreds {
  accountSid: string;
  authToken: string;
}

/** Build an SmsSender from explicit creds (per-tenant BYO or platform env). */
export function makeTwilioSms(creds: TwilioApiCreds): SmsSender {
  return {
    async sendSms({ to, from, body }) {
      const client = twilio(creds.accountSid, creds.authToken);
      const msg = await client.messages.create({ to, from, body });
      return { sid: msg.sid };
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
    return makeTwilioSms({
      accountSid: process.env.TWILIO_ACCOUNT_SID!,
      authToken: process.env.TWILIO_AUTH_TOKEN!,
    }).sendSms(opts);
  },
};
