import { resolveTelephonyCreds, resolveVoiceCreds, adminPool } from "@savvy/db";
import { makeTwilioSms, makeHttpVapi, sms, smsFrom, voice, type SmsSender, type VoiceGateway } from "@savvy/integrations";
import { shouldThrottleOutbound } from "@savvy/core";

/** Build the Twilio statusCallback URL from APP_BASE_URL, or undefined when the env is absent. */
function statusCallbackUrl(): string | undefined {
  const base = process.env.APP_BASE_URL;
  if (!base) return undefined;
  return `${base.replace(/\/$/, "")}/api/twilio/status`;
}

/** Wrap a sender so every sendSms call includes statusCallback when APP_BASE_URL is set.
 *  An explicit caller-supplied statusCallback always wins. */
function withStatusCallback(sender: SmsSender): SmsSender {
  const cb = statusCallbackUrl();
  if (!cb) return sender; // dev/test: no env set — pass through unchanged
  return {
    sendSms(opts) {
      return sender.sendSms({ ...opts, statusCallback: opts.statusCallback ?? cb });
    },
  };
}

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
      sender: withStatusCallback(makeTwilioSms({ accountSid: r.twilio.accountSid, authToken: r.twilio.authToken })),
      from: r.twilio.from,
    };
  }
  return { sender: withStatusCallback(deps.platformSms), from: deps.platformFrom() };
}

const THROTTLE_WINDOW_HOURS = 24;

/** Injectable aggregate query — takes tenantId, returns terminal delivery counts. */
export type ThrottleQuery = (tenantId: string) => Promise<{ delivered: number; failed: number; undelivered: number }>;

async function defaultThrottleQuery(tenantId: string): Promise<{ delivered: number; failed: number; undelivered: number }> {
  const cutoff = new Date(Date.now() - THROTTLE_WINDOW_HOURS * 60 * 60 * 1000);
  const { rows } = await adminPool.query<Record<string, string>>(
    `select
      count(*) filter (where delivery_status = 'delivered')   as delivered,
      count(*) filter (where delivery_status = 'failed')      as failed,
      count(*) filter (where delivery_status = 'undelivered') as undelivered
    from communication
    where tenant_id = $1 and direction = 'outbound' and channel = 'sms'
      and created_at >= $2
      and delivery_status in ('delivered','failed','undelivered')`,
    [tenantId, cutoff],
  );
  const r = rows[0] ?? { delivered: "0", failed: "0", undelivered: "0" };
  return { delivered: Number(r.delivered), failed: Number(r.failed), undelivered: Number(r.undelivered) };
}

/**
 * True when the tenant's recent SMS delivery rate is below the floor with
 * enough terminal sample to trust the signal. Fail-soft: any error ⇒ false
 * (don't block sends on a DB hiccup).
 */
export async function isOutboundThrottled(
  tenantId: string,
  query: ThrottleQuery = defaultThrottleQuery,
): Promise<boolean> {
  try {
    const agg = await query(tenantId);
    return shouldThrottleOutbound(agg);
  } catch {
    return false; // fail-soft: don't block sends on instrumentation errors
  }
}

export interface TenantVoiceDeps {
  resolve: typeof resolveVoiceCreds;
  platformVoice: VoiceGateway;
}

const defaultVoiceDeps: TenantVoiceDeps = { resolve: resolveVoiceCreds, platformVoice: voice };

/**
 * Resolve the VoiceGateway for a tenant.
 * byo + active with non-empty vapi creds → the tenant's own Vapi gateway;
 * otherwise the platform account (platform mode, inactive byo, or empty placeholder creds).
 */
export async function getTenantVoice(
  tenantId: string,
  deps: TenantVoiceDeps = defaultVoiceDeps,
): Promise<VoiceGateway> {
  const r = await deps.resolve(tenantId);
  if (r.source === "tenant" && r.vapi.apiKey && r.vapi.assistantId && r.vapi.phoneNumberId) {
    return makeHttpVapi(r.vapi);
  }
  return deps.platformVoice;
}
