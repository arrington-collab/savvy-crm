import type { SmsSender } from "./twilio";
import { twilioSms } from "./twilio";
import { ringcentralSms } from "./ringcentral";

/** Pure selector — pass an env bag for testing. */
export function selectSms(env: Record<string, string | undefined> = process.env): SmsSender {
  return env.TELEPHONY_SMS_PROVIDER === "ringcentral" ? ringcentralSms : twilioSms;
}

/** The SMS sender feature code should import. Resolved once at module load from env. */
export const sms: SmsSender = selectSms();
