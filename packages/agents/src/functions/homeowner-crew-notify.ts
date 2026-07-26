import { withTenant, eq, appointment, job, communication, customer as customerTbl, tenant as tenantTbl, isSuppressed } from "@savvy/db";
import { parseHomeownerConfig, parseEmailConfig, buildCrewDayTouches, signPayloadToken, requireSecret } from "@savvy/core";
import { getTenantSms, resolveA2pApproved } from "../telephony";
import { getTenantEmail } from "../email";
import { buildShortLink } from "../short-link";
import { guardedSms } from "../comms-gateway";
import { inngest } from "../client";

export type CrewTouchSendResult = { smsSent: boolean };

/**
 * Send site for a single crew-day touch (extracted from the Inngest step.run
 * callback so it's directly unit-testable, mirroring dunning.ts's
 * sendDunningStep). SMS goes through guardedSms — the global
 * contact_suppression list, consent, and A2P are enforced. A thrown error
 * (getTenantSms/guardedSms/sender.sendSms) is fail-soft: caught and
 * swallowed, never recorded as a false "sent".
 */
export async function sendCrewTouch(
  input: {
    tenantId: string; jobId: string; customerId: string;
    phone: string | null; email: string | null; smsOptOut: boolean; emailOptOut: boolean; smsConsentAt: Date | null;
    touchBody: string; link: string; gmailConnectionId: string | null;
  },
  deps: { getTenantSms: typeof getTenantSms; getTenantEmail: typeof getTenantEmail } = { getTenantSms, getTenantEmail },
): Promise<CrewTouchSendResult> {
  const { tenantId, jobId, customerId, phone, email, smsOptOut, emailOptOut, smsConsentAt, touchBody, link, gmailConnectionId } = input;
  const body = `${touchBody} Track your project: ${link}`;
  let smsSent = false;

  if (phone && !smsOptOut) {
    let smsLoggedBody = body;
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
      smsSent = result.status === "sent";
      if (result.status !== "sent") {
        smsLoggedBody = `[${result.status}: ${result.status === "blocked" ? result.reason : result.untilIso}]`;
      }
    } catch (err) {
      // fail-soft: no creds / provider error — never a false "sent", and the
      // logged row must not read as a delivered text either.
      smsLoggedBody = `[error: ${err instanceof Error ? err.message : "guardedSms failed"}]`;
    }
    await withTenant(tenantId, (tx) => tx.insert(communication).values({ tenantId, jobId, customerId, channel: "sms", direction: "outbound", to: phone, body: smsLoggedBody, aiHandled: false }));
  }

  if (email && !emailOptOut) {
    try {
      const emailSender = await deps.getTenantEmail(tenantId, { gmailConnectionId });
      await emailSender.sendEmail({ to: email, from: process.env.EMAIL_FROM ?? "noreply@example.com", subject: "An update on your roofing project", html: `<p>${touchBody}</p><p><a href="${link}">Track your project</a></p>` });
    } catch { /* fail-soft */ }
    await withTenant(tenantId, (tx) => tx.insert(communication).values({ tenantId, jobId, customerId, channel: "email", direction: "outbound", to: email, body, aiHandled: false }));
  }

  return { smsSent };
}

/**
 * Homeowner crew-day journey (§F): when a crew (install) appointment is booked, schedule
 * the evening-before prep text and the day-of-morning heads-up to the homeowner. Durable
 * (step.sleepUntil), quiet-hours-safe (times come from buildCrewDayTouches), config-driven
 * copy, opt-out-aware, and fail-soft. Cancels itself if the appointment is rescheduled or
 * canceled (cancelOn appointment/changed) — a fresh appointment/booked reschedules the touches.
 */
export const homeownerCrewNotify = inngest.createFunction(
  {
    id: "homeowner-crew-notify",
    concurrency: { limit: 5 },
    cancelOn: [{ event: "appointment/changed", match: "data.appointmentId" }],
  },
  [{ event: "appointment/booked" }, { event: "appointment/changed" }],
  async ({ event, step }) => {
    const { appointmentId, tenantId } = event.data as { appointmentId: string; tenantId: string };

    const ctx = await step.run("load", () => withTenant(tenantId, async (tx) => {
      const [a] = await tx.select().from(appointment).where(eq(appointment.id, appointmentId));
      // Only crew (install) appointments drive the homeowner crew-day journey.
      // Crew appointments are always job-scoped (installs happen after job creation).
      if (!a || a.type !== "crew" || a.status !== "scheduled" || !a.jobId) return null;
      const [j] = await tx.select({ customerId: job.customerId }).from(job).where(eq(job.id, a.jobId));
      const cust = j?.customerId ? (await tx.select().from(customerTbl).where(eq(customerTbl.id, j.customerId)))[0] : undefined;
      if (!cust) return null;
      const [t] = await tx.select().from(tenantTbl).where(eq(tenantTbl.id, tenantId));
      return {
        jobId: a.jobId,
        startsAt: a.startsAt,
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
    const gmailConnectionId = parseEmailConfig(ctx.settings.email).gmailConnectionId ?? null;
    const secret = requireSecret("UNSUBSCRIBE_SECRET", { devFallback: "dev-unsubscribe-secret" });
    const link = await buildShortLink({ tenantId, token: signPayloadToken({ tenantId, jobId: ctx.jobId }, secret), kind: "status" });

    // step.run serialises Dates to strings — re-hydrate startsAt before arithmetic.
    const touches = buildCrewDayTouches(new Date(ctx.startsAt as unknown as string), ctx.tz, cfg, new Date(ctx.nowMs));
    if (touches.length === 0) return { scheduled: 0 };

    for (const t of touches) {
      await step.sleepUntil(`wait-${t.key}`, new Date(t.fireAt as unknown as string));

      const stillScheduled = await step.run(`recheck-${t.key}`, () =>
        withTenant(tenantId, async (tx) => {
          const [a] = await tx.select({ status: appointment.status }).from(appointment).where(eq(appointment.id, appointmentId));
          return a?.status === "scheduled";
        }),
      );
      if (!stillScheduled) return { stopped: t.key };

      await step.run(`send-${t.key}`, () =>
        sendCrewTouch({
          tenantId, jobId: ctx.jobId, customerId: ctx.customerId,
          phone: ctx.phone, email: ctx.email, smsOptOut: ctx.smsOptOut, emailOptOut: ctx.emailOptOut,
          // ctx crossed the step.run/JSON boundary — re-hydrate the Date.
          smsConsentAt: ctx.smsConsentAt ? new Date(ctx.smsConsentAt as unknown as string) : null,
          touchBody: t.body, link, gmailConnectionId,
        }),
      );
    }
    return { scheduled: touches.length };
  },
);
