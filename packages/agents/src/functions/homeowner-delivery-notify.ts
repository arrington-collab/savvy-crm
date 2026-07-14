import { withTenant, eq, and, materialOrder, job, appointment, communication, customer as customerTbl, tenant as tenantTbl, recordProductionUpdate } from "@savvy/db";
import { parseHomeownerConfig, parseEmailConfig, buildDeliveryTouches, signPayloadToken, requireSecret, type DeliveryTouch } from "@savvy/core";
import { getTenantSms } from "../telephony";
import { getTenantEmail } from "../email";
import { buildShortLink } from "../short-link";
import { inngest } from "../client";

/**
 * Delivery homeowner comms (§F extended by Production Pulse slice 2 §0, owner
 * decision): TWO texts — 3 days out AND the evening before — and BOTH say
 * clearly that DELIVERY DAY IS NOT BUILD DAY, with the build date merged from
 * the crew schedule when it exists. Durable (step.sleepUntil per leg),
 * quiet-hours-safe, opt-out-aware, fail-soft; each leg re-checks the order and
 * re-resolves the build date at send time (schedules move). Every leg logs to
 * the production_update ledger (production.delivery_notice evidence).
 */
export const homeownerDeliveryNotify = inngest.createFunction(
  { id: "homeowner-delivery-notify", concurrency: { limit: 5 } },
  { event: "material/ordered" },
  async ({ event, step }) => {
    const { materialOrderId, tenantId } = event.data;

    const ctx = await step.run("load", () => withTenant(tenantId, async (tx) => {
      const [mo] = await tx.select({ jobId: materialOrder.jobId, neededByAt: materialOrder.neededByAt, status: materialOrder.status }).from(materialOrder).where(eq(materialOrder.id, materialOrderId));
      if (!mo || mo.status === "canceled" || !mo.neededByAt) return null;
      const [j] = await tx.select({ customerId: job.customerId }).from(job).where(eq(job.id, mo.jobId));
      const cust = j?.customerId ? (await tx.select().from(customerTbl).where(eq(customerTbl.id, j.customerId)))[0] : undefined;
      if (!cust) return null;
      const [t] = await tx.select().from(tenantTbl).where(eq(tenantTbl.id, tenantId));
      return {
        jobId: mo.jobId,
        deliveryAtMs: mo.neededByAt.getTime(),
        customerId: cust.id,
        phone: cust.phone ?? null,
        email: cust.email ?? null,
        smsOptOut: cust.smsOptOut,
        emailOptOut: cust.emailOptOut,
        tz: t?.timezone ?? "America/Phoenix",
        settings: (t?.settings ?? {}) as { homeowner?: unknown; email?: unknown },
        nowMs: Date.now(),
      };
    }));
    if (!ctx) return { skipped: true };

    const cfg = parseHomeownerConfig(ctx.settings.homeowner);
    if (!cfg.enabled) return { skipped: "disabled" };

    // Build date at schedule time — each leg re-resolves before sending.
    const buildStartsAt = await step.run("build-date", () => resolveBuildStartsAt(tenantId, ctx.jobId));
    const touches = buildDeliveryTouches(
      new Date(ctx.deliveryAtMs), buildStartsAt ? new Date(buildStartsAt) : null, ctx.tz, cfg, new Date(ctx.nowMs),
    );
    if (touches.length === 0) return { skipped: "past_or_no_date" };

    const gmailConnectionId = parseEmailConfig(ctx.settings.email).gmailConnectionId ?? null;
    const secret = requireSecret("UNSUBSCRIBE_SECRET", { devFallback: "dev-unsubscribe-secret" });
    const link = await buildShortLink({ tenantId, token: signPayloadToken({ tenantId, jobId: ctx.jobId }, secret), kind: "status" });

    let sent = 0;
    for (const leg of touches) {
      await step.sleepUntil(`wait-${leg.kind}`, new Date(leg.fireAt as unknown as string));

      const stillActive = await step.run(`recheck-${leg.kind}`, () =>
        withTenant(tenantId, async (tx) => {
          const [mo] = await tx.select({ status: materialOrder.status }).from(materialOrder).where(eq(materialOrder.id, materialOrderId));
          return !!mo && mo.status !== "canceled";
        }),
      );
      if (!stillActive) return { stopped: true, sent };

      await step.run(`send-${leg.kind}`, async () => {
        // Schedules move — merge the CURRENT build date into the copy.
        const freshBuildMs = await resolveBuildStartsAt(tenantId, ctx.jobId);
        const fresh = buildDeliveryTouches(
          new Date(ctx.deliveryAtMs), freshBuildMs ? new Date(freshBuildMs) : null, ctx.tz, cfg,
          new Date(new Date(leg.fireAt as unknown as string).getTime() - 1),
        );
        const copy = (fresh.find((f) => f.kind === leg.kind) ?? (leg as DeliveryTouch)).body;
        const body = `${copy} Track your project: ${link}`;

        if (ctx.phone && !ctx.smsOptOut) {
          try { const { sender, from } = await getTenantSms(tenantId); await sender.sendSms({ to: ctx.phone, from, body }); } catch { /* fail-soft */ }
          await withTenant(tenantId, (tx) => tx.insert(communication).values({ tenantId, jobId: ctx.jobId, customerId: ctx.customerId, channel: "sms", direction: "outbound", to: ctx.phone, body, aiHandled: false }));
          await recordProductionUpdate({ tenantId, jobId: ctx.jobId, kind: leg.kind, body, sentAt: new Date() });
        } else {
          await recordProductionUpdate({ tenantId, jobId: ctx.jobId, kind: leg.kind, suppressedReason: ctx.smsOptOut ? "opt_out" : "no_phone" });
        }
        if (ctx.email && !ctx.emailOptOut) {
          try {
            const emailSender = await getTenantEmail(tenantId, { gmailConnectionId });
            await emailSender.sendEmail({ to: ctx.email, from: process.env.EMAIL_FROM ?? "noreply@example.com", subject: "Your roofing materials — delivery details", html: `<p>${copy}</p><p><a href="${link}">Track your project</a></p>` });
          } catch { /* fail-soft */ }
          await withTenant(tenantId, (tx) => tx.insert(communication).values({ tenantId, jobId: ctx.jobId, customerId: ctx.customerId, channel: "email", direction: "outbound", to: ctx.email, body, aiHandled: false }));
        }
      });
      sent += 1;
    }
    return { scheduled: true, legs: touches.length, sent };
  },
);

/** First scheduled crew appointment = the build start the copy merges. */
async function resolveBuildStartsAt(tenantId: string, jobId: string): Promise<number | null> {
  return withTenant(tenantId, async (tx) => {
    const [appt] = await tx.select({ startsAt: appointment.startsAt }).from(appointment)
      .where(and(eq(appointment.jobId, jobId), eq(appointment.type, "crew"), eq(appointment.status, "scheduled")))
      .orderBy(appointment.startsAt)
      .limit(1);
    return appt?.startsAt ? appt.startsAt.getTime() : null;
  });
}
