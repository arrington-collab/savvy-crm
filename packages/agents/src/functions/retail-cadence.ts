import { withTenant, invoice, job, customer, tenant, communication, eq } from "@savvy/db";
import { parseRetailCadenceConfig, buildRetailTouchBody, nextAllowedSendTime, signPayloadToken, requireSecret } from "@savvy/core";
import { getEmailSender } from "@savvy/integrations";
import { getTenantSms } from "../telephony";
import { buildShortLink } from "../short-link";
import { inngest } from "../client";

/**
 * Retail close-out follow-up cadence (§F/retail lane): when a **retail** job's invoice is
 * sent, drip 7/15/30/60/90-day touches to the homeowner — a gentle balance nudge while a
 * balance is open plus a review/referral ask — driving reviews into the referral lane.
 *
 * Lane branch: insurance jobs are skipped here; they follow the carrier/depreciation
 * timeline (slice G). This is the softer relationship layer; hard overdue collection is
 * dunning's job (both key off invoice/sent, complementary). Cancels on invoice/void.
 */
export const retailCloseoutCadence = inngest.createFunction(
  {
    id: "retail-closeout-cadence",
    concurrency: { limit: 5 },
    cancelOn: [{ event: "invoice/void", match: "data.invoiceId" }],
  },
  { event: "invoice/sent" },
  async ({ event, step }) => {
    const { invoiceId, tenantId } = event.data;

    const setup = await step.run("load", () => withTenant(tenantId, async (tx) => {
      const [inv] = await tx.select({ jobId: invoice.jobId }).from(invoice).where(eq(invoice.id, invoiceId));
      if (!inv) return null;
      const [j] = await tx.select({ type: job.type, customerId: job.customerId }).from(job).where(eq(job.id, inv.jobId));
      if (!j || j.type !== "retail") return null; // lane branch: retail only
      const cust = j.customerId ? (await tx.select().from(customer).where(eq(customer.id, j.customerId)))[0] : undefined;
      if (!cust) return null;
      const [t] = await tx.select({ settings: tenant.settings, timezone: tenant.timezone }).from(tenant).where(eq(tenant.id, tenantId));
      return {
        jobId: inv.jobId,
        customerId: cust.id,
        phone: cust.phone ?? null,
        email: cust.email ?? null,
        smsOptOut: cust.smsOptOut,
        emailOptOut: cust.emailOptOut,
        tz: t?.timezone ?? "America/Phoenix",
        settings: (t?.settings ?? {}) as { retailCadence?: unknown; email?: unknown },
      };
    }));
    if (!setup) return { skipped: "not_retail" };

    const cfg = parseRetailCadenceConfig(setup.settings.retailCadence);
    if (!cfg.enabled) return { skipped: "disabled" };
    const secret = requireSecret("UNSUBSCRIBE_SECRET", { devFallback: "dev-unsubscribe-secret" });
    const statusLink = await step.run("mint-short-link", () => buildShortLink({ tenantId, token: signPayloadToken({ tenantId, jobId: setup.jobId }, secret), kind: "status" }));
    const reviewLink = cfg.reviewUrl || statusLink;

    for (let i = 0; i < cfg.steps.length; i++) {
      const touch = cfg.steps[i]!;
      await step.sleep(`wait-${i}`, `${touch.dayOffset * 24}h`);

      // Reload live invoice state each touch: stop if void, compute the current balance.
      const live = await step.run(`load-${i}`, () => withTenant(tenantId, async (tx) => {
        const [inv] = await tx.select({ status: invoice.status, amountDue: invoice.amountDue, amountPaid: invoice.amountPaid }).from(invoice).where(eq(invoice.id, invoiceId));
        if (!inv) return null;
        const balanceCents = Math.max(0, (inv.amountDue ?? 0) - (inv.amountPaid ?? 0));
        const now = new Date();
        const nextAllowed = touch.channel === "sms" ? nextAllowedSendTime(now, setup.tz, cfg.quietHours) : now;
        return { status: inv.status, balanceCents, nextAllowedMs: nextAllowed.getTime(), nowMs: now.getTime() };
      }));
      if (!live || live.status === "void") return { stopped: "void", atStep: i };

      const optedOut = touch.channel === "sms" ? setup.smsOptOut || !setup.phone : setup.emailOptOut || !setup.email;
      if (optedOut) continue;

      if (touch.channel === "sms" && live.nextAllowedMs > live.nowMs) {
        await step.sleepUntil(`quiet-${i}`, new Date(live.nextAllowedMs));
      }

      await step.run(`send-${i}`, async () => {
        const body = buildRetailTouchBody({ balanceCents: live.balanceCents, payLink: statusLink, reviewLink, copy: cfg.copy });
        if (touch.channel === "sms") {
          try { const { sender, from } = await getTenantSms(tenantId); await sender.sendSms({ to: setup.phone!, from, body }); } catch { /* fail-soft */ }
          await withTenant(tenantId, (tx) => tx.insert(communication).values({ tenantId, jobId: setup.jobId, customerId: setup.customerId, channel: "sms", direction: "outbound", to: setup.phone, body, aiHandled: false }));
        } else {
          const gmailConnectionId = null;
          try { await getEmailSender({ gmailConnectionId }).sendEmail({ to: setup.email!, from: process.env.EMAIL_FROM ?? "noreply@example.com", subject: "How's your new roof?", html: `<p>${body}</p>` }); } catch { /* fail-soft */ }
          await withTenant(tenantId, (tx) => tx.insert(communication).values({ tenantId, jobId: setup.jobId, customerId: setup.customerId, channel: "email", direction: "outbound", to: setup.email, body, aiHandled: false }));
        }
        return { sent: touch.channel };
      });
    }
    return { done: cfg.steps.length };
  },
);
