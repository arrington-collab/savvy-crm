import { adminDb, withTenant, lead, customer, tenant, communication, recordAgentRun, isSuppressed, eq } from "@savvy/db";
import { parseLeadCadenceConfig, parseFinanceConfig, shouldSendChannel, nextAllowedSendTime, signPayloadToken, requireSecret } from "@savvy/core";
import { getTenantSms, resolveA2pApproved } from "../telephony";
import { getTenantEmail } from "../email";
import { guardedSms } from "../comms-gateway";
import { buildAckSms, buildAckEmail } from "./lead-intake";
import { buildShortLink } from "../short-link";
import { inngest } from "../client";

const OPEN = ["new", "contacted", "qualified", "booked"];

export const leadCadence = inngest.createFunction(
  {
    id: "lead-cadence", concurrency: { limit: 5 },
    cancelOn: [
      { event: "lead/contacted", match: "data.leadId" },
      { event: "lead/disqualified", match: "data.leadId" },
    ],
  },
  { event: "lead/created" },
  async ({ event, step }) => {
    const { leadId, tenantId } = event.data;
    const setup = await step.run("load-cadence", async () => {
      const [t] = await adminDb.select({ settings: tenant.settings }).from(tenant).where(eq(tenant.id, tenantId));
      const cfg = parseLeadCadenceConfig((t?.settings as { leadCadence?: unknown } | null)?.leadCadence);
      const tz = parseFinanceConfig((t?.settings as { finance?: unknown } | null)?.finance).timezone;
      return { cfg, tz };
    });

    const secret = requireSecret("UNSUBSCRIBE_SECRET", { devFallback: "dev-unsubscribe-secret" });
    const bookingUrl = await step.run("mint-short-link", () => buildShortLink({ tenantId, token: signPayloadToken({ leadId, tenantId, type: "inspection" }, secret), kind: "booking" }));

    for (let i = 0; i < setup.cfg.steps.length; i++) {
      const touch = setup.cfg.steps[i]!;
      await step.sleep(`wait-${i}`, `${touch.dayOffset * 24 + touch.hourOffset}h`);

      // Load lead state + compute quiet-hours gate time for SMS touches in one durable step.
      const ctx = await step.run(`load-${i}`, async () => {
        const row = await withTenant(tenantId, async (tx) => {
          const [r] = await tx.select({
            status: lead.status, contacted: lead.firstRepContactAt, customerId: lead.customerId,
            name: customer.name, phone: customer.phone, email: customer.email,
            smsOptOut: customer.smsOptOut, emailOptOut: customer.emailOptOut, smsConsentAt: customer.smsConsentAt,
          }).from(lead).leftJoin(customer, eq(lead.customerId, customer.id)).where(eq(lead.id, leadId));
          return r ?? null;
        });
        if (!row) return null;
        // For SMS touches: compute the next allowed send time past quiet hours.
        // Email is exempt from quiet-hours.
        let nextAllowed: string | null = null;
        if (touch.channel === "sms") {
          const now = new Date();
          const allowed = nextAllowedSendTime(now, setup.tz, setup.cfg.quietHours);
          // Only set nextAllowed if we need to wait (allowed is strictly after now).
          if (allowed.getTime() > now.getTime()) {
            nextAllowed = allowed.toISOString();
          }
        }
        return { ...row, nextAllowed };
      });

      if (!ctx || ctx.contacted != null || !OPEN.includes(ctx.status)) return { stopped: "contacted-or-closed", atStep: i };

      // smsConsentAt is a Date in the DB but arrives as a string after JSON round-trip through step.run.
      const smsConsentAt = ctx.smsConsentAt ? new Date(ctx.smsConsentAt as unknown as string) : null;
      const gate = { smsOptOut: ctx.smsOptOut ?? false, emailOptOut: ctx.emailOptOut ?? false, smsConsentAt };
      if (!shouldSendChannel(touch.channel, gate)) continue; // opted out / no consent for this channel
      if (touch.channel === "sms" && !ctx.phone) continue;
      if (touch.channel === "email" && !ctx.email) continue;

      // For SMS: if we're inside quiet hours, sleep until the next allowed time before sending.
      if (touch.channel === "sms" && ctx.nextAllowed) {
        await step.sleepUntil(`quiet-${i}`, ctx.nextAllowed);
      }

      await step.run(`send-${i}`, async () => {
        const vars = { name: ctx.name ?? "there", bookingUrl };
        if (touch.channel === "sms") {
          // Quiet hours were already respected by the sleepUntil above; guardedSms
          // re-checks at actual send time (defense-in-depth) plus enforces global
          // suppression, consent/opt-out, and A2P approval before the sender fires.
          let sid = "mock";
          let blockedReason: string | null = null;
          try {
            const { sender, from } = await getTenantSms(tenantId);
            const result = await guardedSms(
              { isSuppressed, sms: sender, smsFrom: () => from },
              {
                tenantId, channel: "sms", to: ctx.phone!, from, body: buildAckSms(vars),
                consent: gate, a2pApproved: resolveA2pApproved(tenantId, from),
                quiet: { tz: setup.tz, qh: setup.cfg.quietHours }, contactId: ctx.customerId ?? undefined,
              },
            );
            if (result.status === "sent") sid = result.sid;
            else blockedReason = result.status === "blocked" ? `blocked: ${result.reason}` : `deferred: ${result.untilIso}`;
          } catch { /* dev */ }

          if (blockedReason) {
            // blocked/deferred at actual send time: don't send. The prior sleepUntil
            // already handles the expected quiet-hours case; a later Slice B task
            // turns `blocked` into a compliance-block escalation — for now, just log.
            await recordAgentRun({
              tenantId, leadId, agent: "comms", taskKey: "lead.cadence.sms", status: "skipped", error: blockedReason,
            });
          } else {
            await withTenant(tenantId, (tx) => tx.insert(communication).values({
              tenantId, customerId: ctx.customerId, channel: "sms", direction: "outbound", to: ctx.phone, body: buildAckSms(vars), twilioSid: sid, aiHandled: false,
            }));
          }
        } else {
          const { subject, html } = buildAckEmail(vars);
          try {
            const emailSender = await getTenantEmail(tenantId, { gmailConnectionId: null });
            await emailSender.sendEmail({ to: ctx.email!, from: process.env.RESEND_FROM ?? "noreply@savvy.app", subject, html });
          } catch { /* dev */ }
          await withTenant(tenantId, (tx) => tx.insert(communication).values({
            tenantId, customerId: ctx.customerId, channel: "email", direction: "outbound", to: ctx.email, body: subject, aiHandled: false,
          }));
        }
        return { sent: touch.channel };
      });
    }
    return { status: "exhausted-in-nurture" };
  },
);
