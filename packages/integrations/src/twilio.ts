import twilio from "twilio";

export interface SmsSender {
  sendSms(opts: { to: string; from: string; body: string }): Promise<{ sid: string }>;
}

// Real implementation. In tests we pass a mock SmsSender instead.
export const twilioSms: SmsSender = {
  async sendSms({ to, from, body }) {
    const client = twilio(process.env.TWILIO_ACCOUNT_SID!, process.env.TWILIO_AUTH_TOKEN!);
    const msg = await client.messages.create({ to, from, body });
    return { sid: msg.sid };
  },
};
