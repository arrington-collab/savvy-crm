// Estimate Experience slice 4 (part 4): the expiry sweep. Once a sent estimate
// crosses its validity window unaccepted, the homeowner gets the expiry
// variant follow-up and the rep hears about it — renewal re-prices against the
// CURRENT price book (never the stale one).

import { withTenant, eq, and, isNull, lt, estimate, lead, customer, tenant as tenantTbl, adminDb, recordEstimateEvent, listEstimateEvents, ensureEstimateLink, isSuppressed } from "@savvy/db";
import { parseEstimateConfig, parseFinanceConfig, parseHomeownerConfig, isWithinQuietHours, hourInTimeZone } from "@savvy/core";
import { inngest } from "../client";
import { getTenantSms, resolveA2pApproved } from "../telephony";
import { guardedSms } from "../comms-gateway";

const EXPIRY_COPY = (link: string) =>
  `Your roof estimate has expired — material prices move, so the numbers need a quick refresh. Nothing to do on your end; we'll send an updated one. You can still view the original here: ${link}`;

export async function sweepTenantEstimateExpiry(
  tenantId: string,
  deps: { getTenantSms: typeof getTenantSms; now?: () => Date } = { getTenantSms },
): Promise<{ noticed: number }> {
  const now = deps.now?.() ?? new Date();
  const [t] = await adminDb.select({ settings: tenantTbl.settings }).from(tenantTbl).where(eq(tenantTbl.id, tenantId));
  const settings = t?.settings as { estimate?: unknown; finance?: unknown; homeowner?: unknown } | null;
  const cfg = parseEstimateConfig(settings?.estimate);
  const tz = parseFinanceConfig(settings?.finance).timezone;
  const qh = parseHomeownerConfig(settings?.homeowner).quietHours;
  if (isWithinQuietHours(now, tz, qh)) return { noticed: 0 };

  const cutoff = new Date(now.getTime() - cfg.validityDays * 86_400_000);
  const expired = await withTenant(tenantId, (tx) =>
    tx
      .select({ id: estimate.id, leadId: estimate.leadId })
      .from(estimate)
      .where(and(eq(estimate.status, "sent"), isNull(estimate.acceptedAt), lt(estimate.sentAt, cutoff))),
  );

  let noticed = 0;
  for (const est of expired) {
    const events = await listEstimateEvents(tenantId, est.id);
    if (events.some((e) => e.kind === "expiry_notice")) continue; // once, ever

    // Homeowner phone via the lead's customer.
    const cust = await withTenant(tenantId, async (tx) => {
      if (!est.leadId) return null;
      const [l] = await tx.select({ customerId: lead.customerId }).from(lead).where(eq(lead.id, est.leadId));
      if (!l?.customerId) return null;
      const [c] = await tx
        .select({
          id: customer.id,
          phone: customer.phone,
          smsOptOut: customer.smsOptOut,
          emailOptOut: customer.emailOptOut,
          smsConsentAt: customer.smsConsentAt,
        })
        .from(customer)
        .where(eq(customer.id, l.customerId));
      return c ?? null;
    });
    if (!cust?.phone || cust.smsOptOut) {
      await recordEstimateEvent({ tenantId, estimateId: est.id, kind: "expiry_notice", meta: { suppressed: "no_phone_or_opt_out" } });
      continue;
    }

    const base = (process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
    const { code } = await ensureEstimateLink({ tenantId, estimateId: est.id });
    let sentOk = false;
    let meta: Record<string, unknown> | undefined;
    try {
      const { sender, from } = await deps.getTenantSms(tenantId);
      const result = await guardedSms(
        { isSuppressed, sms: sender, smsFrom: () => from },
        {
          tenantId, channel: "sms", to: cust.phone, from, body: EXPIRY_COPY(`${base}/estimate/${code}`),
          consent: { smsOptOut: cust.smsOptOut, emailOptOut: cust.emailOptOut, smsConsentAt: cust.smsConsentAt },
          a2pApproved: resolveA2pApproved(tenantId, from),
          contactId: cust.id,
        },
      );
      if (result.status === "sent") {
        sentOk = true;
      } else {
        meta = { suppressed: `guard_${result.status === "blocked" ? result.reason : result.status}` };
      }
    } catch (err) {
      meta = { suppressed: "guard_error", error: err instanceof Error ? err.message : "guardedSms failed" };
    }
    await recordEstimateEvent({ tenantId, estimateId: est.id, kind: "expiry_notice", ...(meta ? { meta } : {}) });
    if (sentOk) noticed += 1;
  }
  return { noticed };
}

/** Hourly cron; each tenant sweeps once daily at 10am local. */
export const estimateExpirySweep = inngest.createFunction(
  { id: "estimate-expiry-sweep" },
  { cron: "0 * * * *" },
  async ({ step }) => {
    const tenants = await step.run("due-tenants", async () => {
      const rows = await adminDb.select({ id: tenantTbl.id, settings: tenantTbl.settings }).from(tenantTbl);
      const now = new Date();
      return rows
        .filter((r) => {
          const tz = parseFinanceConfig((r.settings as { finance?: unknown } | null)?.finance).timezone;
          return hourInTimeZone(now, tz) === 10;
        })
        .map((r) => r.id);
    });
    let total = 0;
    for (const tenantId of tenants) {
      const r = await step.run(`sweep-${tenantId}`, () => sweepTenantEstimateExpiry(tenantId));
      total += r.noticed;
    }
    return { tenants: tenants.length, noticed: total };
  },
);
