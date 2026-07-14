// Roof Record slice 2: the repair-credit check-in cadence. While a credit sits
// unapplied the customer hears from us as SERVICE, never pressure — 12mo/24mo
// light touches, ~33mo the before-it-expires note with a re-inspection offer.
// Quiet hours + demo-mute + tenant timezone respected; touches log to
// checkin_log (repair.credit_checkin: no credit expires without the cadence
// having run or an explicit opt-out).

import {
  adminDb, withTenant, eq, customer, tenant as tenantTbl, messageTemplate, and,
  creditCheckinsDue, recordCreditCheckin, expireLapsedCredits, isDemoTenant,
  scheduleRelationshipTouch, markTouchSent,
} from "@savvy/db";
import { parseFinanceConfig, parseHomeownerConfig, isWithinQuietHours, hourInTimeZone, renderTemplate } from "@savvy/core";
import { inngest } from "../client";
import { getTenantSms } from "../telephony";

export const CREDIT_CHECKIN_TEMPLATE_KEY = "roof-record-credit-checkin";

const DEFAULT_COPY: Record<"12mo" | "24mo" | "33mo", string> = {
  "12mo": "Hi {{firstName}} — your ${{amount}} repair credit from our visit is still good toward a future roof replacement. Want a free condition check against your baseline? No pressure either way.",
  "24mo": "Hi {{firstName}} — quick note that your ${{amount}} repair credit is still active. Happy to swing by for a free condition check whenever it suits you.",
  "33mo": "Hi {{firstName}} — your ${{amount}} repair credit expires in a few months. If a replacement is ever on your mind, it applies in full — and a free re-inspection is yours either way.",
};

export async function sweepTenantRepairCredits(
  tenantId: string,
  deps: { getTenantSms: typeof getTenantSms; now?: () => Date } = { getTenantSms },
): Promise<{ touched: number; expired: number }> {
  const now = deps.now?.() ?? new Date();
  if (await isDemoTenant(tenantId)) return { touched: 0, expired: 0 };

  const [t] = await adminDb.select({ settings: tenantTbl.settings }).from(tenantTbl).where(eq(tenantTbl.id, tenantId));
  const settings = t?.settings as { finance?: unknown; homeowner?: unknown } | null;
  const tz = parseFinanceConfig(settings?.finance).timezone;
  const qh = parseHomeownerConfig(settings?.homeowner).quietHours;

  const { expired } = await expireLapsedCredits(tenantId, now);
  if (isWithinQuietHours(now, tz, qh)) return { touched: 0, expired };

  const due = await creditCheckinsDue(tenantId, now);
  let touched = 0;
  for (const d of due) {
    // Customer for Life governor: check-ins schedule THROUGH the relationship
    // calendar (idempotent per credit+kind). A refusal still closes the cadence
    // step — the governor's ledger row carries the why.
    const admitted = await scheduleRelationshipTouch({
      tenantId, customerId: d.customerId, program: "credit_checkin", channel: "text",
      scheduledFor: now, sourceRef: `${d.creditId}:${d.kind}`, now,
    });
    if (!("touchId" in admitted)) {
      await recordCreditCheckin({ tenantId, creditId: d.creditId, kind: d.kind, commId: null });
      continue;
    }
    const touchId = admitted.touchId;
    const cust = await withTenant(tenantId, async (tx) => {
      const [c] = await tx.select({ name: customer.name, phone: customer.phone, smsOptOut: customer.smsOptOut })
        .from(customer).where(eq(customer.id, d.customerId));
      return c ?? null;
    });
    if (!cust?.phone || cust.smsOptOut) {
      // Opted-out/unreachable still logs — the cadence RAN; it was suppressed.
      await recordCreditCheckin({ tenantId, creditId: d.creditId, kind: d.kind, commId: null });
      continue;
    }

    const [tpl] = await adminDb.select({ body: messageTemplate.body }).from(messageTemplate)
      .where(and(eq(messageTemplate.tenantId, tenantId), eq(messageTemplate.key, `${CREDIT_CHECKIN_TEMPLATE_KEY}-${d.kind}`)));
    const body = renderTemplate(tpl?.body?.trim() || DEFAULT_COPY[d.kind], {
      firstName: cust.name.split(/\s+/)[0] ?? cust.name,
      amount: (d.amountCents / 100).toFixed(0),
    });

    const { sender, from } = await deps.getTenantSms(tenantId);
    await sender.sendSms({ to: cust.phone, from, body });
    await markTouchSent({ tenantId, touchId });
    await recordCreditCheckin({ tenantId, creditId: d.creditId, kind: d.kind });
    touched += 1;
  }
  return { touched, expired };
}

/** Hourly cron; each tenant sweeps once daily at 10am local (same slot as the
 *  expiry sweep — both are homeowner-facing service touches). */
export const repairCreditSweep = inngest.createFunction(
  { id: "repair-credit-sweep" },
  { cron: "0 * * * *" },
  async ({ step }) => {
    const tenants = await step.run("due-tenants", async () => {
      const rows = await adminDb.select({ id: tenantTbl.id, settings: tenantTbl.settings }).from(tenantTbl);
      const now = new Date();
      return rows
        .filter((r) => hourInTimeZone(now, parseFinanceConfig((r.settings as { finance?: unknown } | null)?.finance).timezone) === 10)
        .map((r) => r.id);
    });
    let touched = 0, expired = 0;
    for (const tenantId of tenants) {
      const r = await step.run(`sweep-${tenantId}`, () => sweepTenantRepairCredits(tenantId));
      touched += r.touched; expired += r.expired;
    }
    return { tenants: tenants.length, touched, expired };
  },
);
