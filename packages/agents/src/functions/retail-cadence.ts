import { withTenant, invoice, job, customer, tenant, communication, eq, jobHasActiveEnrollment, isSuppressed } from "@savvy/db";
import { parseRetailCadenceConfig, buildRetailTouchBody, stepAbsorbedByRelationship, nextAllowedSendTime, signPayloadToken, requireSecret } from "@savvy/core";
import { getTenantSms, resolveA2pApproved } from "../telephony";
import { getTenantEmail } from "../email";
import { buildShortLink } from "../short-link";
import { guardedSms } from "../comms-gateway";
import { inngest } from "../client";

export type RetailTouchSendResult = { sent: boolean };

/**
 * Send site for a single retail-cadence SMS touch (extracted from the
 * Inngest step.run callback so it's directly unit-testable, mirroring
 * dunning.ts's sendDunningStep / homeowner-crew-notify.ts's sendCrewTouch).
 * SMS goes through guardedSms — the global contact_suppression list,
 * consent, and A2P are enforced. A thrown error (getTenantSms/guardedSms/
 * sender.sendSms) is fail-soft: caught and swallowed, never recorded as a
 * false "sent".
 */
export async function sendRetailSmsTouch(
  input: {
    tenantId: string; jobId: string; customerId: string; phone: string;
    smsOptOut: boolean; emailOptOut: boolean; smsConsentAt: Date | null;
    body: string;
  },
  deps: { getTenantSms: typeof getTenantSms } = { getTenantSms },
): Promise<RetailTouchSendResult> {
  const { tenantId, jobId, customerId, phone, smsOptOut, emailOptOut, smsConsentAt, body } = input;
  let loggedBody = body;
  let sent = false;
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
    sent = result.status === "sent";
    if (result.status !== "sent") {
      loggedBody = `[${result.status}: ${result.status === "blocked" ? result.reason : result.untilIso}]`;
    }
  } catch (err) {
    // fail-soft: no creds / provider error — never a false "sent", and the
    // logged row must not read as a delivered text either.
    loggedBody = `[error: ${err instanceof Error ? err.message : "guardedSms failed"}]`;
  }
  await withTenant(tenantId, (tx) => tx.insert(communication).values({ tenantId, jobId, customerId, channel: "sms", direction: "outbound", to: phone, body: loggedBody, aiHandled: false }));
  return { sent };
}

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
        smsConsentAt: cust.smsConsentAt,
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

      // Customer for Life: an enrolled job's day-30 touch is the standing
      // cadence's governed check-in — the drip's 30-day step is absorbed.
      if (stepAbsorbedByRelationship(touch, true)) {
        const enrolled = await step.run(`absorbed-${i}`, () => jobHasActiveEnrollment(tenantId, setup.jobId));
        if (stepAbsorbedByRelationship(touch, enrolled)) continue;
      }

      if (touch.channel === "sms" && live.nextAllowedMs > live.nowMs) {
        await step.sleepUntil(`quiet-${i}`, new Date(live.nextAllowedMs));
      }

      await step.run(`send-${i}`, async () => {
        const body = buildRetailTouchBody({ balanceCents: live.balanceCents, payLink: statusLink, reviewLink, copy: cfg.copy });
        if (touch.channel === "sms") {
          await sendRetailSmsTouch({
            tenantId, jobId: setup.jobId, customerId: setup.customerId, phone: setup.phone!,
            smsOptOut: setup.smsOptOut, emailOptOut: setup.emailOptOut,
            // setup crossed the step.run/JSON boundary — re-hydrate the Date.
            smsConsentAt: setup.smsConsentAt ? new Date(setup.smsConsentAt as unknown as string) : null,
            body,
          });
        } else {
          const gmailConnectionId = null;
          try {
            const emailSender = await getTenantEmail(tenantId, { gmailConnectionId });
            await emailSender.sendEmail({ to: setup.email!, from: process.env.EMAIL_FROM ?? "noreply@example.com", subject: "How's your new roof?", html: `<p>${body}</p>` });
          } catch { /* fail-soft */ }
          await withTenant(tenantId, (tx) => tx.insert(communication).values({ tenantId, jobId: setup.jobId, customerId: setup.customerId, channel: "email", direction: "outbound", to: setup.email, body, aiHandled: false }));
        }
        return { sent: touch.channel };
      });
    }
    return { done: cfg.steps.length };
  },
);
