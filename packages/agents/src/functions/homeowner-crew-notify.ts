import { withTenant, eq, appointment, job, communication, customer as customerTbl, tenant as tenantTbl } from "@savvy/db";
import { parseHomeownerConfig, parseEmailConfig, buildCrewDayTouches, signPayloadToken, requireSecret } from "@savvy/core";
import { getEmailSender } from "@savvy/integrations";
import { getTenantSms } from "../telephony";
import { inngest } from "../client";

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
      if (!a || a.type !== "crew" || a.status !== "scheduled") return null;
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
    const base = process.env.APP_BASE_URL ?? "http://localhost:3000";
    const link = `${base}/status/${signPayloadToken({ tenantId, jobId: ctx.jobId }, secret)}`;

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

      await step.run(`send-${t.key}`, async () => {
        const body = `${t.body} Track your project: ${link}`;
        if (ctx.phone && !ctx.smsOptOut) {
          try { const { sender, from } = await getTenantSms(tenantId); await sender.sendSms({ to: ctx.phone, from, body }); } catch { /* fail-soft: no creds */ }
          await withTenant(tenantId, (tx) => tx.insert(communication).values({ tenantId, jobId: ctx.jobId, customerId: ctx.customerId, channel: "sms", direction: "outbound", to: ctx.phone, body, aiHandled: false }));
        }
        if (ctx.email && !ctx.emailOptOut) {
          try { await getEmailSender({ gmailConnectionId }).sendEmail({ to: ctx.email, from: process.env.EMAIL_FROM ?? "noreply@example.com", subject: "An update on your roofing project", html: `<p>${t.body}</p><p><a href="${link}">Track your project</a></p>` }); } catch { /* fail-soft */ }
          await withTenant(tenantId, (tx) => tx.insert(communication).values({ tenantId, jobId: ctx.jobId, customerId: ctx.customerId, channel: "email", direction: "outbound", to: ctx.email, body, aiHandled: false }));
        }
        return { sent: t.key };
      });
    }
    return { scheduled: touches.length };
  },
);
