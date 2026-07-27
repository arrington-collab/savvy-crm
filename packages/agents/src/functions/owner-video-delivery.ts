// Estimate Experience slice 5b: NOVA's day-after delivery. Personalized take
// first; the generic tenant video keeps the touch alive when the owner's day
// got away from them. Once per estimate, ever; quiet hours + demo-mute.

import { withTenant, eq, adminDb, tenant as tenantTbl, estimateVideo, recordEstimateEvent, ownerVideoDeliveryQueue, ensureEstimateLink, isSuppressed } from "@savvy/db";
import { parseFinanceConfig, parseHomeownerConfig, parseOwnerVideoConfig, isWithinQuietHours, hourInTimeZone } from "@savvy/core";
import { inngest } from "../client";
import { getTenantSms, resolveA2pApproved } from "../telephony";
import { guardedSms } from "../comms-gateway";

const WRAPPER = (repName: string | null, link: string) =>
  `You talked with ${repName ?? "our team"} yesterday — our owner wanted a word. 30 seconds, worth it: ${link}`;

export async function deliverOwnerVideos(
  tenantId: string,
  deps: { getTenantSms: typeof getTenantSms; now?: () => Date } = { getTenantSms },
): Promise<{ sent: number }> {
  const now = deps.now?.() ?? new Date();
  const [t] = await adminDb.select({ settings: tenantTbl.settings }).from(tenantTbl).where(eq(tenantTbl.id, tenantId));
  const settings = t?.settings as { finance?: unknown; homeowner?: unknown; ownerVideo?: unknown } | null;
  const tz = parseFinanceConfig(settings?.finance).timezone;
  const qh = parseHomeownerConfig(settings?.homeowner).quietHours;
  const cfg = parseOwnerVideoConfig(settings?.ownerVideo);
  if (isWithinQuietHours(now, tz, qh)) return { sent: 0 };

  const queue = await ownerVideoDeliveryQueue(tenantId, cfg.genericDocumentId, now);
  let sent = 0;
  for (const entry of queue) {
    if (!entry.customerPhone) {
      await recordEstimateEvent({ tenantId, estimateId: entry.estimateId, kind: "video_sent", meta: { suppressed: "no_phone", personalized: entry.personalized } });
      continue;
    }
    const base = (process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
    const { code } = await ensureEstimateLink({ tenantId, estimateId: entry.estimateId });
    try {
      const { sender, from } = await deps.getTenantSms(tenantId);
      const result = await guardedSms(
        { isSuppressed, sms: sender, smsFrom: () => from },
        {
          tenantId, channel: "sms", to: entry.customerPhone, from, body: WRAPPER(entry.repName, `${base}/estimate/${code}?v=1`),
          consent: { smsOptOut: false, emailOptOut: entry.emailOptOut, smsConsentAt: entry.smsConsentAt },
          a2pApproved: resolveA2pApproved(tenantId, from),
          contactId: entry.customerId ?? undefined,
        },
      );
      if (result.status === "sent") {
        await recordEstimateEvent({ tenantId, estimateId: entry.estimateId, kind: "video_sent", meta: { personalized: entry.personalized, documentId: entry.documentId } });
        if (entry.personalized) {
          await withTenant(tenantId, (tx) =>
            tx.update(estimateVideo).set({ status: "delivered" }).where(eq(estimateVideo.documentId, entry.documentId)),
          );
        }
        sent += 1;
      } else {
        // Blocked/deferred verdict: close the once-ever gate (mirrors the
        // no_phone suppressed-event shape) so the queue doesn't re-offer it —
        // but never mark delivered and never count it as sent.
        await recordEstimateEvent({
          tenantId, estimateId: entry.estimateId, kind: "video_sent",
          meta: { suppressed: `guard_${result.status === "blocked" ? result.reason : result.status}`, personalized: entry.personalized },
        });
      }
    } catch (err) {
      // Fail-soft: a thrown error (DB blip, provider 5xx) is transient — do NOT
      // record video_sent, so the once-ever gate stays open and the next
      // delivery pass retries instead of silently dropping the video.
      console.error("deliverOwnerVideos: guardedSms threw, will retry next pass", err);
      continue;
    }
  }
  return { sent };
}

/** Hourly cron; each tenant delivers at its configured local hour (default noon). */
export const ownerVideoDelivery = inngest.createFunction(
  { id: "owner-video-delivery" },
  { cron: "0 * * * *" },
  async ({ step }) => {
    const due = await step.run("due-tenants", async () => {
      const rows = await adminDb.select({ id: tenantTbl.id, settings: tenantTbl.settings }).from(tenantTbl);
      const now = new Date();
      return rows
        .filter((r) => {
          const s = r.settings as { finance?: unknown; ownerVideo?: unknown } | null;
          const tz = parseFinanceConfig(s?.finance).timezone;
          const hour = parseOwnerVideoConfig(s?.ownerVideo).deliveryHourLocal;
          return hourInTimeZone(now, tz) === hour;
        })
        .map((r) => r.id);
    });
    let total = 0;
    for (const tenantId of due) {
      const r = await step.run(`deliver-${tenantId}`, () => deliverOwnerVideos(tenantId));
      total += r.sent;
    }
    return { tenants: due.length, sent: total };
  },
);
