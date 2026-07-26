import { withTenant, eq, appointment, communication, isSuppressed, customer as customerTbl, tenant as tenantTbl, DrizzleOrchestratorStore } from "@savvy/db";
import { parseSchedulingConfig, signPayloadToken, requireSecret, parseEmailConfig } from "@savvy/core";
import type { OrchestratorStore } from "@savvy/orchestrator";
import { publishDomainEvent, makeEvent } from "@savvy/orchestrator";
import { getTenantSms, resolveA2pApproved } from "../telephony";
import { getTenantEmail } from "../email";
import { guardedSms } from "../comms-gateway";
import { buildShortLink } from "../short-link";
import { inngest } from "../client";

// The reminder.sent event's offset field is a flexible string, not a narrow
// enum — tenants can configure any positive-hour offset via scheduling
// settings (the default schedule itself is 24h + 2h), and every configured
// offset gets bridged onto the domain-event bus.
export function reminderOffsetLabel(offsetH: number): string {
  return `${offsetH}h`;
}

// --- Slice B bridge helper ------------------------------------------------
// Pure, DB-free (given a store) so it's unit-testable with an InMemoryStore.
// Publishes reminder.sent onto the domain-event bus so the Command Center
// read-model can project it. No escalation rule keys off reminder.sent, so
// unlike bridgeBreach (lead-speed-to-lead.ts) there's nothing to record back.
export async function bridgeReminderSent(
  store: OrchestratorStore,
  a: { tenantId: string; leadId: string; appointmentId: string; offset: string; channel: string },
): Promise<void> {
  await publishDomainEvent(store, makeEvent({
    type: "reminder.sent", source: "savvy", tenantId: a.tenantId,
    correlationId: a.appointmentId, idempotencyKey: `reminder.sent:${a.appointmentId}:${a.offset}`,
    payload: { leadId: a.leadId, appointmentId: a.appointmentId, offset: a.offset, channel: a.channel },
  }));
}

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
    concurrency: { limit: 5 },
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
        leadId: a.leadId,
        customerId: a.customerId,
        phone: cust?.phone ?? null,
        email: cust?.email ?? null,
        smsOptOut: cust?.smsOptOut ?? false,
        emailOptOut: cust?.emailOptOut ?? false,
        smsConsentAt: cust?.smsConsentAt ?? null,
        settings: (t?.settings as { scheduling?: unknown })?.scheduling,
        gmailConnectionId: parseEmailConfig((t?.settings as { email?: unknown } | undefined)?.email).gmailConnectionId ?? null,
      };
    }));
    if (!ctx) return { skipped: true };

    const cfg = parseSchedulingConfig(ctx.settings);
    const secret = requireSecret("UNSUBSCRIBE_SECRET", { devFallback: "dev-unsubscribe-secret" });
    const token = signPayloadToken({ appointmentId, tenantId, type: ctx.type }, secret);
    const bookUrl = await step.run("mint-short-link", () => buildShortLink({ tenantId, token, kind: "booking" }));

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

      const sendResult = await step.run(`send-${r.offsetH}-${r.channel}`, async () => {
        // Re-hydrate startsAt (string after JSON round-trip) before passing to buildReminderMessage.
        const body = buildReminderMessage(
          { type: ctx.type, startsAt: new Date(ctx.startsAt as unknown as string) },
          bookUrl,
          r.channel,
        );
        const to = r.channel === "sms" ? ctx.phone : ctx.email;
        if (!to) return { sent: false, smsSentOk: false };
        let loggedBody = body;
        let smsSentOk = false;
        if (r.channel === "sms") {
          try {
            // Inngest step.run serialises the "load" step's return through JSON —
            // smsConsentAt arrives as a string. Re-hydrate before passing to the guard.
            const smsConsentAt = ctx.smsConsentAt ? new Date(ctx.smsConsentAt as unknown as string) : null;
            const { sender, from } = await getTenantSms(tenantId);
            const result = await guardedSms(
              { isSuppressed, sms: sender, smsFrom: () => from },
              {
                tenantId, channel: "sms", to, from, body,
                consent: { smsOptOut: ctx.smsOptOut, emailOptOut: ctx.emailOptOut, smsConsentAt },
                a2pApproved: resolveA2pApproved(tenantId, from),
                contactId: ctx.customerId ?? undefined,
              },
            );
            smsSentOk = result.status === "sent";
            if (result.status !== "sent") {
              loggedBody = `[${result.status}: ${result.status === "blocked" ? result.reason : result.untilIso}]`;
            }
          } catch (err) {
            // getTenantSms/guardedSms threw (e.g. a transient isSuppressed DB
            // error, or the sender itself failing) — the real send never
            // fired, so this must NOT be logged as a successful "sent" comm.
            loggedBody = `[error: ${err instanceof Error ? err.message : "guardedSms failed"}]`;
          }
        } else {
          try {
            const emailSender = await getTenantEmail(tenantId, { gmailConnectionId: ctx.gmailConnectionId });
            await emailSender.sendEmail({
              to,
              from: process.env.EMAIL_FROM ?? "noreply@example.com",
              subject: "Appointment reminder",
              html: body,
            });
          } catch {
            // Fail-soft in dev/test (no credentials configured, email unaffected).
          }
        }
        await withTenant(tenantId, (tx) =>
          tx.insert(communication).values({
            tenantId,
            customerId: ctx.customerId,
            channel: r.channel,
            direction: "outbound",
            to,
            body: loggedBody,
            aiHandled: false,
          }),
        );
        return { sent: loggedBody === body, smsSentOk };
      });

      // Slice B bridge: project a successful SMS reminder send onto the domain-event
      // bus (reminder.sent -> Command Center read-model). A sibling step.run (not
      // nested inside "send-*") so it's durable + retried independently, and
      // fail-soft: a publish error must never unwind the comm log that already
      // landed above. Only fires for reminders with a lead to attribute to (crew/
      // install appointments post-conversion have no leadId) — every configured
      // offset (24h, 2h, 1h, or any other tenant-configured hour count) bridges.
      const offset = reminderOffsetLabel(r.offsetH);
      if (sendResult.smsSentOk && ctx.leadId) {
        await step.run(`bridge-reminder-${r.offsetH}-${r.channel}`, async () => {
          try {
            const store = new DrizzleOrchestratorStore();
            await bridgeReminderSent(store, {
              tenantId, leadId: ctx.leadId as string, appointmentId, offset, channel: r.channel,
            });
          } catch (err) {
            console.error("bridge-reminder-sent: failed to publish reminder.sent bridge event:", err instanceof Error ? err.message : err);
          }
        });
      }
    }
    return { done: true };
  },
);
