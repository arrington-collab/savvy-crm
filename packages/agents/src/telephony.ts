import { resolveTelephonyCreds } from "@savvy/db";
import { makeTwilioSms, sms, smsFrom, type SmsSender } from "@savvy/integrations";

export interface TenantSmsDeps {
  resolve: typeof resolveTelephonyCreds;
  platformSms: SmsSender;
  platformFrom: () => string;
}

const defaultDeps: TenantSmsDeps = { resolve: resolveTelephonyCreds, platformSms: sms, platformFrom: smsFrom };

/**
 * Resolve the SMS sender + from-number for a tenant.
 * byo + active with non-empty creds → the tenant's own Twilio; otherwise the
 * platform account (platform mode, inactive byo, or empty placeholder creds).
 */
export async function getTenantSms(
  tenantId: string,
  deps: TenantSmsDeps = defaultDeps,
): Promise<{ sender: SmsSender; from: string }> {
  const r = await deps.resolve(tenantId);
  if (r.source === "tenant" && r.twilio.accountSid && r.twilio.from) {
    return {
      sender: makeTwilioSms({ accountSid: r.twilio.accountSid, authToken: r.twilio.authToken }),
      from: r.twilio.from,
    };
  }
  return { sender: deps.platformSms, from: deps.platformFrom() };
}
