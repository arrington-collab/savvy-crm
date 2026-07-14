// Customer for Life slice 2: the standing-cadence sweep. Enroll every completed
// job, keep next year's roofiversary + holiday card on the calendar, send the
// due TEXT touches (30-day check-in, roofiversary), and HOLD due print pieces
// as print_pending until the PostGrid build. Every send rides a governor-
// admitted touch — rogue sends stay structurally impossible.

import {
  adminDb, withTenant, eq, and, tenant as tenantTbl, messageTemplate, communication,
  isDemoTenant, enrollCompletedJobs, extendStandingCadence, holdDuePrintTouches,
  dueCadenceTextTouches, markTouchSent,
} from "@savvy/db";
import {
  parseFinanceConfig, parseHomeownerConfig, parseRelationshipCadenceConfig,
  isWithinQuietHours, hourInTimeZone, renderTemplate,
} from "@savvy/core";
import { inngest } from "../client";
import { getTenantSms } from "../telephony";

export const RELATIONSHIP_TEMPLATE_KEYS = {
  checkin_30d: "relationship-checkin-30d",
  roofiversary: "relationship-roofiversary",
} as const;

export async function sweepTenantRelationshipCadence(
  tenantId: string,
  deps: { getTenantSms: typeof getTenantSms; now?: () => Date } = { getTenantSms },
): Promise<{ enrolled: number; extended: number; sent: number; held: number }> {
  const now = deps.now?.() ?? new Date();
  if (await isDemoTenant(tenantId)) return { enrolled: 0, extended: 0, sent: 0, held: 0 };

  const [t] = await adminDb.select({ settings: tenantTbl.settings }).from(tenantTbl).where(eq(tenantTbl.id, tenantId));
  const settings = t?.settings as { finance?: unknown; homeowner?: unknown; relationship?: unknown } | null;
  const cfg = parseRelationshipCadenceConfig(settings?.relationship);
  if (!cfg.enabled) return { enrolled: 0, extended: 0, sent: 0, held: 0 };

  const { enrolled } = await enrollCompletedJobs(tenantId, now);
  const { scheduled: extended } = await extendStandingCadence(tenantId, now);
  // Holding print pieces is bookkeeping, not comms — quiet hours don't apply.
  const { held } = await holdDuePrintTouches(tenantId, now);

  const tz = parseFinanceConfig(settings?.finance).timezone;
  const qh = parseHomeownerConfig(settings?.homeowner).quietHours;
  if (isWithinQuietHours(now, tz, qh)) return { enrolled, extended, sent: 0, held };

  const due = await dueCadenceTextTouches(tenantId, now);
  let sent = 0;
  for (const d of due) {
    const program = d.program as keyof typeof RELATIONSHIP_TEMPLATE_KEYS;
    const key = RELATIONSHIP_TEMPLATE_KEYS[program];
    if (!key) continue; // other programs have their own senders
    const [tpl] = await adminDb.select({ body: messageTemplate.body }).from(messageTemplate)
      .where(and(eq(messageTemplate.tenantId, tenantId), eq(messageTemplate.key, key)));
    const fallback = program === "checkin_30d" ? cfg.copy.checkin30d : cfg.copy.roofiversary;
    const body = renderTemplate(tpl?.body?.trim() || fallback, {
      firstName: d.name.split(/\s+/)[0] ?? d.name,
      years: d.sourceRef?.split(":")[2] ?? "",
    });

    const { sender, from } = await deps.getTenantSms(tenantId);
    await sender.sendSms({ to: d.phone, from, body });
    await markTouchSent({ tenantId, touchId: d.touchId });
    // Cadence sourceRefs are job-anchored by construction: `${jobId}:…`.
    const jobId = d.sourceRef?.split(":")[0] ?? null;
    await withTenant(tenantId, (tx) => tx.insert(communication).values({
      tenantId, jobId, customerId: d.customerId, channel: "sms", direction: "outbound",
      to: d.phone, body, aiHandled: false,
    }));
    sent += 1;
  }
  return { enrolled, extended, sent, held };
}

/** Hourly cron; each tenant sweeps once daily at 10am local — the same
 *  homeowner-facing service-touch slot as the repair-credit sweep. */
export const relationshipCadenceSweep = inngest.createFunction(
  { id: "relationship-cadence-sweep" },
  { cron: "0 * * * *" },
  async ({ step }) => {
    const tenants = await step.run("due-tenants", async () => {
      const rows = await adminDb.select({ id: tenantTbl.id, settings: tenantTbl.settings }).from(tenantTbl);
      const now = new Date();
      return rows
        .filter((r) => hourInTimeZone(now, parseFinanceConfig((r.settings as { finance?: unknown } | null)?.finance).timezone) === 10)
        .map((r) => r.id);
    });
    let enrolled = 0, sent = 0, held = 0;
    for (const tenantId of tenants) {
      const r = await step.run(`sweep-${tenantId}`, () => sweepTenantRelationshipCadence(tenantId));
      enrolled += r.enrolled; sent += r.sent; held += r.held;
    }
    return { tenants: tenants.length, enrolled, sent, held };
  },
);
