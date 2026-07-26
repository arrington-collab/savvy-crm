import { parseFinanceConfig, parseLeadCadenceConfig, type QuietHours } from "@savvy/core";

export interface SendContext {
  companyName: string;
  tz: string;
  quietHours: QuietHours;
}

/**
 * Resolves branding/timezone/quiet-hours for a send.
 *
 * TODAY this resolves entirely from the tenant: `companyName` = `tenant.name`,
 * `tz` from the tenant's finance config, `quietHours` from the tenant's
 * lead-cadence config.
 *
 * `locationId` is accepted and threaded through end-to-end but is RESERVED —
 * there is no location entity yet, so it deliberately does not branch or
 * change the result. Once a location entity exists, this function should
 * look up location-level overrides (branding, timezone, quiet hours) keyed
 * by `locationId` and fall back to the tenant defaults below.
 */
export function resolveSendContext(
  tenant: { name: string; settings: unknown },
  locationId?: string | null,
): SendContext {
  void locationId; // reserved for future per-location overrides; unused today (YAGNI)

  const settings = tenant.settings as { finance?: unknown; leadCadence?: unknown } | null | undefined;
  const tz = parseFinanceConfig(settings?.finance).timezone;
  const quietHours = parseLeadCadenceConfig(settings?.leadCadence).quietHours;

  return {
    companyName: tenant.name,
    tz,
    quietHours,
  };
}
