import { withTenant, eq, appointment, communication, customer as customerTbl, tenant as tenantTbl } from "@savvy/db";
import { parseSchedulingConfig, signPayloadToken, requireSecret, parseEmailConfig } from "@savvy/core";
import { sms, smsFrom, getEmailSender } from "@savvy/integrations";
import { inngest } from "../client";

export function buildReminderMessage(
  appt: { type: string; startsAt: Date }, bookUrl: string, channel: "sms" | "email",
): string {
  const when = appt.startsAt.toUTCString();
  const base = `Reminder: your ${appt.type} appointment is at ${when}. Reschedule: ${bookUrl}`;
  return channel === "sms" ? `${base}  Reply CANCEL to cancel.` : base;
}

export const appointmentReminders = inngest.createFunction(
  {
    id: "appointment-reminders",
    concurrency: { limit: 20 },
    cancelOn: [{ event: "appointment/changed", match: "data.appointmentId" }],
  },
  [{ event: "appointment/booked" }, { event: "appointment/changed" }],
  async ({ event, step }) => {
    const { appointmentId, tenantId } = event.data as { appointmentId: string; tenantId: string };

    const ctx = await step.run("load", () => withTenant(tenantId, async (tx) => {
      const [a] = await tx.select().from(appointment).where(eq(appointment.id, appointmentId));
      // Guard: if appointment is canceled, done, or missing — no reminders needed.
      if (!a || a.status !== "scheduled") return null;
      const [t] = await tx.select().from(tenantTbl).where(eq(tenantTbl.id, tenantId));
      const cust = a.customerId
        ? (await tx.select().from(customerTbl).where(eq(customerTbl.id, a.customerId)))[0]
        : undefined;
      return {
        startsAt: a.startsAt,
        type: a.type,
        customerId: a.customerId,
        phone: cust?.phone ?? null,
        email: cust?.email ?? null,
        settings: (t?.settings as { scheduling?: unknown })?.scheduling,
        gmailConnectionId: parseEmailConfig((t?.settings as { email?: unknown } | undefined)?.email).gmailConnectionId ?? null,
      };
    }));
    if (!ctx) return { skipped: true };

    const cfg = parseSchedulingConfig(ctx.settings);
    const secret = requireSecret("UNSUBSCRIBE_SECRET", { devFallback: "dev-unsubscribe-secret" });
    const token = signPayloadToken({ appointmentId, tenantId, type: ctx.type }, secret);
    const bookUrl = `${process.env.APP_BASE_URL ?? "http://localhost:3000"}/book/${token}`;

    // Sort reminders soonest-fire first (largest offsetH fires earliest relative to appointment).
    const reminders = [...cfg.reminders].sort((a, b) => b.offsetH - a.offsetH);
    for (const r of reminders) {
      // Inngest step.run serialises return values through JSON — ctx.startsAt arrives as a string.
      // Always re-hydrate with new Date() before any Date arithmetic.
      const fireAt = new Date(new Date(ctx.startsAt as unknown as string).getTime() - r.offsetH * 3_600_000);
      await step.sleepUntil(`wait-${r.offsetH}-${r.channel}`, fireAt);

      const stillScheduled = await step.run(`recheck-${r.offsetH}-${r.channel}`, () =>
        withTenant(tenantId, async (tx) => {
          const [a] = await tx.select().from(appointment).where(eq(appointment.id, appointmentId));
          return a?.status === "scheduled";
        }),
      );
      if (!stillScheduled) return { stopped: true };

      await step.run(`send-${r.offsetH}-${r.channel}`, async () => {
        // Re-hydrate startsAt (string after JSON round-trip) before passing to buildReminderMessage.
        const body = buildReminderMessage(
          { type: ctx.type, startsAt: new Date(ctx.startsAt as unknown as string) },
          bookUrl,
          r.channel,
        );
        const to = r.channel === "sms" ? ctx.phone : ctx.email;
        if (!to) return { sent: false };
        try {
          if (r.channel === "sms") {
            await sms.sendSms({ to, from: smsFrom(), body });
          } else {
            await getEmailSender({ gmailConnectionId: ctx.gmailConnectionId }).sendEmail({
              to,
              from: process.env.EMAIL_FROM ?? "noreply@example.com",
              subject: "Appointment reminder",
              html: body,
            });
          }
        } catch {
          // Fail-soft in dev/test (no credentials configured).
        }
        await withTenant(tenantId, (tx) =>
          tx.insert(communication).values({
            tenantId,
            customerId: ctx.customerId,
            channel: r.channel,
            direction: "outbound",
            to,
            body,
            aiHandled: false,
          }),
        );
        return { sent: true };
      });
    }
    return { done: true };
  },
);
