import { withTenant, eq, and, materialOrder, job, appointment, communication, customer as customerTbl, tenant as tenantTbl, recordProductionUpdate, isSuppressed } from "@savvy/db";
import { parseHomeownerConfig, parseEmailConfig, buildDeliveryTouches, signPayloadToken, requireSecret, type DeliveryTouch } from "@savvy/core";
import { getTenantSms, resolveA2pApproved } from "../telephony";
import { getTenantEmail } from "../email";
import { buildShortLink } from "../short-link";
import { guardedSms } from "../comms-gateway";
import { inngest } from "../client";

export type DeliveryTouchSendResult = { smsSent: boolean };

/**
 * Send site for a single delivery touch leg (extracted from the Inngest
 * step.run callback so it's directly unit-testable, mirroring dunning.ts's
 * sendDunningStep). SMS goes through guardedSms — the global
 * contact_suppression list, consent, and A2P are enforced. A thrown error
 * (getTenantSms/guardedSms/sender.sendSms) is fail-soft: caught and
 * swallowed, never recorded as a false "sent" or a completed delivery notice
 * in the production_update ledger.
 */
export async function sendDeliveryTouch(
  input: {
    tenantId: string; jobId: string; customerId: string; kind: string;
    phone: string | null; email: string | null; smsOptOut: boolean; emailOptOut: boolean; smsConsentAt: Date | null;
    body: string; link: string; gmailConnectionId: string | null;
  },
  deps: { getTenantSms: typeof getTenantSms; getTenantEmail: typeof getTenantEmail } = { getTenantSms, getTenantEmail },
): Promise<DeliveryTouchSendResult> {
  const { tenantId, jobId, customerId, kind, phone, email, smsOptOut, emailOptOut, smsConsentAt, body: copy, link, gmailConnectionId } = input;
  const body = `${copy} Track your project: ${link}`;
  let smsSent = false;
  let suppressedReason: string | null = null;

  if (phone && !smsOptOut) {
    try {
      const { sender, from } = await deps.getTenantSms(tenantId);
      const result = await guardedSms(
        { isSuppressed, sms: sender, smsFrom: () => from },
        {
          tenantId, channel: "sms", to: phone, from, body,
          consent: { smsOptOut, emailOptOut, smsConsentAt },
          a2pApproved: resolveA2pApproved(tenantId, from),
          contactId: customerId,
        },
      );
      if (result.status === "sent") {
        smsSent = true;
      } else {
        suppressedReason = `guard_${result.status === "blocked" ? result.reason : result.status}`;
      }
    } catch {
      // fail-soft: no creds / provider error — never a false "sent".
      suppressedReason = "guard_error";
    }
  } else {
    suppressedReason = smsOptOut ? "opt_out" : "no_phone";
  }

  if (smsSent) {
    await withTenant(tenantId, (tx) => tx.insert(communication).values({ tenantId, jobId, customerId, channel: "sms", direction: "outbound", to: phone, body, aiHandled: false }));
    await recordProductionUpdate({ tenantId, jobId, kind, body, sentAt: new Date() });
  } else {
    // Blocked, deferred, or thrown — never recorded as a completed delivery notice.
    await recordProductionUpdate({ tenantId, jobId, kind, suppressedReason: suppressedReason ?? "guard_blocked" });
  }

  if (email && !emailOptOut) {
    try {
      const emailSender = await deps.getTenantEmail(tenantId, { gmailConnectionId });
      await emailSender.sendEmail({ to: email, from: process.env.EMAIL_FROM ?? "noreply@example.com", subject: "Your roofing materials — delivery details", html: `<p>${copy}</p><p><a href="${link}">Track your project</a></p>` });
    } catch { /* fail-soft */ }
    await withTenant(tenantId, (tx) => tx.insert(communication).values({ tenantId, jobId, customerId, channel: "email", direction: "outbound", to: email, body, aiHandled: false }));
  }

  return { smsSent };
}

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
        smsConsentAt: cust.smsConsentAt,
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

      await step.run(`send-${leg.kind}`, () => {
        // Schedules move — merge the CURRENT build date into the copy.
        return resolveBuildStartsAt(tenantId, ctx.jobId).then((freshBuildMs) => {
          const fresh = buildDeliveryTouches(
            new Date(ctx.deliveryAtMs), freshBuildMs ? new Date(freshBuildMs) : null, ctx.tz, cfg,
            new Date(new Date(leg.fireAt as unknown as string).getTime() - 1),
          );
          const copy = (fresh.find((f) => f.kind === leg.kind) ?? (leg as DeliveryTouch)).body;
          return sendDeliveryTouch({
            tenantId, jobId: ctx.jobId, customerId: ctx.customerId, kind: leg.kind,
            phone: ctx.phone, email: ctx.email, smsOptOut: ctx.smsOptOut, emailOptOut: ctx.emailOptOut,
            // ctx crossed the step.run/JSON boundary — re-hydrate the Date.
            smsConsentAt: ctx.smsConsentAt ? new Date(ctx.smsConsentAt as unknown as string) : null,
            body: copy, link, gmailConnectionId,
          });
        });
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
