// Roof Record slice 4: the lightweight storm hook (wave-2 sentinel ships the
// full machinery; this hook ships NOW). Daily, per tenant: look up verified
// storm tracks over the baselined-roof clusters, and any swath covering ≥1
// baselined address raises ONE batch card on /today. The OWNER approves;
// NOVA sends the service-framed outreach ("checking your roof against its
// <month> baseline" — never sales); bookings create kind=post_storm
// inspections linked to their baseline.

import {
  adminDb, withTenant, eq, and, customer, tenant as tenantTbl, messageTemplate,
  getBaselinedProperties, proposeStormReinspectBatch, markStormBatchSent,
  stormReinspectBatch, isDemoTenant,
} from "@savvy/db";
import { parseFinanceConfig, parseHomeownerConfig, isWithinQuietHours, hourInTimeZone, renderTemplate } from "@savvy/core";
import { stormProof, slimStormSwaths } from "@savvy/integrations";
import { clusterKnockCenters } from "../storm-alert";
import { inngest } from "../client";
import { getTenantSms } from "../telephony";

export const STORM_OUTREACH_TEMPLATE_KEY = "roof-record-storm-outreach";
const DEFAULT_OUTREACH =
  "Hi {{firstName}} — a verified {{kind}} event passed near your home. We have your roof's {{baselineMonth}} baseline on file, so a quick free check against it will tell us (and your insurer, if it comes to that) exactly what changed. Want us to swing by? No charge, no pressure.";

/** Sweep one tenant: cluster baselined roofs, look up verified tracks, card new swaths. */
export async function sweepTenantStormBaselines(
  tenantId: string,
  deps: { lookup: typeof stormProof.lookupStormTracks } = { lookup: stormProof.lookupStormTracks.bind(stormProof) },
): Promise<{ proposed: number }> {
  if (await isDemoTenant(tenantId)) return { proposed: 0 };
  const baselined = await getBaselinedProperties(tenantId);
  if (baselined.length === 0) return { proposed: 0 };

  const centers = clusterKnockCenters(baselined.map((p) => ({ lat: p.lat, lng: p.lng })));
  let proposed = 0;
  const seen = new Set<string>();
  for (const c of centers) {
    const swaths = slimStormSwaths(await deps.lookup({ lat: c.lat, lng: c.lng, months: 1 }).catch(() => []));
    for (const swath of swaths) {
      const key = `${swath.kind}|${swath.date}|${swath.size ?? ""}|${swath.windMph ?? ""}`;
      if (seen.has(key)) continue; // two centers can see the same swath
      seen.add(key);
      const res = await proposeStormReinspectBatch({ tenantId, swath });
      if ("batchId" in res) proposed += 1;
    }
  }
  return { proposed };
}

/** Hourly cron; each tenant sweeps once daily at 7am local (storm cards greet
 *  the owner with the morning coffee, ahead of the 10am outreach sweeps). */
export const stormBaselineWatch = inngest.createFunction(
  { id: "storm-baseline-watch" },
  { cron: "0 * * * *" },
  async ({ step }) => {
    const tenants = await step.run("due-tenants", async () => {
      const rows = await adminDb.select({ id: tenantTbl.id, settings: tenantTbl.settings }).from(tenantTbl);
      const now = new Date();
      return rows
        .filter((r) => hourInTimeZone(now, parseFinanceConfig((r.settings as { finance?: unknown } | null)?.finance).timezone) === 7)
        .map((r) => r.id);
    });
    let proposed = 0;
    for (const tenantId of tenants) {
      const r = await step.run(`sweep-${tenantId}`, () => sweepTenantStormBaselines(tenantId));
      proposed += r.proposed;
    }
    return { tenants: tenants.length, proposed };
  },
);

/** Send the approved batch: one SMS per affected roof's customer, Library
 *  template first, quiet hours + opt-out respected. Idempotent per batch —
 *  markStormBatchSent only flips approved→sent, and a sent batch never re-enters. */
export async function sendStormReinspectOutreach(
  input: { tenantId: string; batchId: string },
  deps: { getTenantSms: typeof getTenantSms; now?: () => Date } = { getTenantSms },
): Promise<{ sent: number } | { skipped: string }> {
  const now = deps.now?.() ?? new Date();
  const [batch] = await withTenant(input.tenantId, (tx) => tx.select().from(stormReinspectBatch)
    .where(and(eq(stormReinspectBatch.id, input.batchId), eq(stormReinspectBatch.status, "approved"))));
  if (!batch) return { skipped: "not_approved" };

  const [t] = await adminDb.select({ settings: tenantTbl.settings }).from(tenantTbl).where(eq(tenantTbl.id, input.tenantId));
  const settings = t?.settings as { finance?: unknown; homeowner?: unknown } | null;
  const tz = parseFinanceConfig(settings?.finance).timezone;
  const qh = parseHomeownerConfig(settings?.homeowner).quietHours;
  if (isWithinQuietHours(now, tz, qh)) return { skipped: "quiet_hours" }; // Inngest retries land it after the window

  const [tpl] = await adminDb.select({ body: messageTemplate.body }).from(messageTemplate)
    .where(and(eq(messageTemplate.tenantId, input.tenantId), eq(messageTemplate.key, STORM_OUTREACH_TEMPLATE_KEY)));
  const template = tpl?.body?.trim() || DEFAULT_OUTREACH;

  const props = batch.properties as { customerId: string | null; baselineAt: string }[];
  let sent = 0;
  for (const p of props) {
    if (!p.customerId) continue;
    const cust = await withTenant(input.tenantId, async (tx) => {
      const [c] = await tx.select({ name: customer.name, phone: customer.phone, smsOptOut: customer.smsOptOut })
        .from(customer).where(eq(customer.id, p.customerId!));
      return c ?? null;
    });
    if (!cust?.phone || cust.smsOptOut) continue;

    const baselineMonth = new Date(p.baselineAt).toLocaleDateString(undefined, { month: "long", year: "numeric" });
    const body = renderTemplate(template, {
      firstName: cust.name.split(/\s+/)[0] ?? cust.name,
      kind: batch.kind,
      baselineMonth,
    });
    const { sender, from } = await deps.getTenantSms(input.tenantId);
    await sender.sendSms({ to: cust.phone, from, body });
    sent += 1;
  }
  await markStormBatchSent({ tenantId: input.tenantId, batchId: input.batchId });
  return { sent };
}

export const stormReinspectSend = inngest.createFunction(
  { id: "storm-reinspect-send", retries: 3 },
  { event: "storm/reinspect.approved" },
  async ({ event, step }) => {
    const { tenantId, batchId } = event.data;
    return step.run("send-outreach", () => sendStormReinspectOutreach({ tenantId, batchId }));
  },
);
