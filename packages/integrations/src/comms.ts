import type { SmsSender } from "./twilio";
import { twilioSms } from "./twilio";
import { ringcentralSms } from "./ringcentral";

/** Pure selector — pass an env bag for testing. */
export function selectSms(env: Record<string, string | undefined> = process.env): SmsSender {
  return env.TELEPHONY_SMS_PROVIDER === "ringcentral" ? ringcentralSms : twilioSms;
}

/** The SMS "from" number for the active provider. */
export function smsFrom(env: Record<string, string | undefined> = process.env): string {
  return env.TELEPHONY_SMS_PROVIDER === "ringcentral"
    ? (env.RINGCENTRAL_FROM_NUMBER ?? "")
    : (env.TWILIO_FROM ?? "+15555550000");
}

/** The SMS sender feature code should import. Resolved once at module load from env. */
export const sms: SmsSender = selectSms();
