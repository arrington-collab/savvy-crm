import {
  parseFinanceConfig,
  parseEmailConfig,
  dunningSchedule,
  dunningEmail,
  dunningSms,
  nextAllowedSendTime,
  type DunningStep,
} from "@savvy/core";
import {
  withTenant,
  eq,
  invoice,
  tenant,
  customer,
  communication,
  agentRun,
  isSuppressed,
} from "@savvy/db";
import { getTenantSms, resolveA2pApproved } from "../telephony";
import { getTenantEmail } from "../email";
import { guardedSms } from "../comms-gateway";
import { inngest } from "../client";

export type DunningSendResult = { skipped: true } | { completed: true };

/**
 * Phase-1/2/3 send for a single dunning step (extracted from the Inngest
 * step.run callback so it's directly unit-testable). SMS goes through
 * guardedSms — the global contact_suppression list, consent, and A2P are
 * enforced. A thrown error (guardedSms/getTenantSms/sender.sendSms) is left
 * to propagate: it must NOT be caught and logged as a fail-soft "sent" —
 * Inngest retries the step instead.
 */
export async function sendDunningStep(
  input: { tenantId: string; invoiceId: string; step: DunningStep; gmailConnectionId: string | null },
  deps: { getTenantSms: typeof getTenantSms; getTenantEmail: typeof getTenantEmail } = { getTenantSms, getTenantEmail },
): Promise<DunningSendResult> {
  const { tenantId, invoiceId, step: s, gmailConnectionId } = input;

  // ── Phase 1: read fresh invoice + customer; flip overdue if needed ──────
  const phase1 = await withTenant(tenantId, async (tx) => {
    const [inv] = await tx.select().from(invoice).where(eq(invoice.id, invoiceId));
    if (!inv) return null;
    // Re-fetch the customer live (don't rely on stale setup data).
    const cust = inv.customerId
      ? (await tx.select().from(customer).where(eq(customer.id, inv.customerId)))[0] ?? null
      : null;
    if (s.flipsOverdue && inv.status === "sent") {
      await tx.update(invoice).set({ status: "overdue" }).where(eq(invoice.id, invoiceId));
    }
    return {
      number: inv.number,
      amountDue: inv.amountDue,
      customerId: inv.customerId ?? null,
      jobId: inv.jobId ?? null,
      email: cust?.email ?? null,
      phone: cust?.phone ?? null,
      smsOptOut: cust?.smsOptOut ?? false,
      emailOptOut: cust?.emailOptOut ?? false,
      smsConsentAt: cust?.smsConsentAt ?? null,
    };
  });
  if (!phase1) return { skipped: true };

  // ── Phase 2: outbound send — NO open transaction ──────────────────────
  const payUrl = `${process.env.APP_BASE_URL ?? "http://localhost:3000"}/invoices/${invoiceId}`;
  let suppressed: string | null = null;
  let commBody = "";
  let commTo: string | null = null;
  let twilioSid: string | null = null;

  if (s.channel === "email") {
    if (!phase1.email) {
      suppressed = "no email";
    } else {
      commTo = phase1.email;
      const mail = dunningEmail({
        tone: s.tone,
        number: phase1.number ?? "",
        payUrl,
        amountCents: phase1.amountDue ?? 0,
      });
      commBody = mail.subject;
      try {
        // id is not used further — fail-soft, the comm row is always inserted.
        const emailSender = await deps.getTenantEmail(tenantId, { gmailConnectionId });
        await emailSender.sendEmail({
          to: phase1.email,
          from: process.env.EMAIL_FROM ?? "noreply@example.com",
          subject: mail.subject,
          html: mail.html,
        });
      } catch {
        // No creds in dev/test — still log the comm with a mock id (fail-soft).
      }
    }
  } else {
    if (!phase1.phone) {
      suppressed = "no phone";
    } else if (phase1.smsOptOut) {
      commTo = phase1.phone;
      suppressed = "sms opt-out";
    } else {
      commTo = phase1.phone;
      const body = dunningSms({ number: phase1.number ?? "", payUrl });
      const { sender, from } = await deps.getTenantSms(tenantId);
      const result = await guardedSms(
        { isSuppressed, sms: sender, smsFrom: () => from },
        {
          tenantId, channel: "sms", to: phase1.phone, from, body,
          consent: { smsOptOut: phase1.smsOptOut, emailOptOut: phase1.emailOptOut, smsConsentAt: phase1.smsConsentAt },
          a2pApproved: resolveA2pApproved(tenantId, from),
          contactId: phase1.customerId ?? undefined,
        },
      );
      if (result.status === "sent") {
        commBody = body;
        twilioSid = result.sid;
      } else {
        // Blocked/deferred by the guard — never a false "sent"; no sid logged.
        suppressed = `guard_${result.status === "blocked" ? result.reason : result.status}`;
      }
    }
  }

  // ── Phase 3: log communication (and agentRun on a real send) ──────────
  const wasSuppressed = suppressed !== null;
  await withTenant(tenantId, async (tx) => {
    await tx.insert(communication).values({
      tenantId,
      customerId: phase1.customerId,
      jobId: phase1.jobId,
      channel: s.channel,
      direction: "outbound",
      to: commTo,
      body: wasSuppressed ? `[suppressed: ${suppressed}]` : commBody,
      twilioSid: s.channel === "sms" && !wasSuppressed ? twilioSid : null,
      aiHandled: false,
    });
    if (!wasSuppressed) {
      await tx.insert(agentRun).values({
        tenantId,
        agent: "finance",
        jobId: phase1.jobId,
        status: "ok",
        modelUsed: null,
      });
    }
  });
  return { completed: true };
}

/**
 * One run per sent invoice. Sends escalating dunning reminders relative to
 * dueAt, flips the invoice to "overdue" at the SMS escalation step, and stops
 * immediately when the invoice is paid or voided.
 *
 * cancelOn kills the run mid-sleep (belt); the per-step status re-check is the
 * backstop suspenders — same pattern as dripRun.
 *
 * SMS sends are pushed past TCPA quiet-hours via nextAllowedSendTime.
 */
export const dunningRun = inngest.createFunction(
  {
    id: "dunning-run",
    concurrency: { limit: 5 },
    cancelOn: [
      { event: "invoice/paid", match: "data.invoiceId" },
      { event: "invoice/void", match: "data.invoiceId" },
    ],
  },
  { event: "invoice/sent" },
  async ({ event, step }) => {
    // event.data is fully typed via EventSchemas in client.ts — no cast needed.
    const { tenantId, invoiceId } = event.data;

    const setup = await step.run("load", async () =>
      withTenant(tenantId, async (tx) => {
        const [inv] = await tx.select().from(invoice).where(eq(invoice.id, invoiceId));
        const [t] = await tx.select().from(tenant).where(eq(tenant.id, tenantId));
        if (!inv || !inv.dueAt) return null;
        const cfg = parseFinanceConfig((t?.settings as { finance?: unknown } | undefined)?.finance);
        if (!cfg.dunning.enabled) return null;
        const gmailConnectionId = parseEmailConfig((t?.settings as { email?: unknown } | undefined)?.email).gmailConnectionId ?? null;
        return { inv, cfg, gmailConnectionId };
      }),
    );
    if (!setup) return { skipped: true };

    const { cfg } = setup;
    // Re-hydrate dueAt — step.run return values are JSON-serialised; Date arrives as string.
    const dueAt = new Date(setup.inv.dueAt as unknown as string);
    const steps = dunningSchedule({ smsEscalationDay: cfg.dunning.smsEscalationDay });

    for (const s of steps) {
      let sendAt = new Date(dueAt.getTime() + s.dayOffset * 86_400_000);
      // Push SMS past TCPA quiet hours (e.g. 9pm–8am tenant-local time).
      if (s.channel === "sms") {
        sendAt = nextAllowedSendTime(sendAt, cfg.timezone, cfg.dunning.quietHours);
      }
      await step.sleepUntil(`wait-${s.stepNum}`, sendAt);

      // Backstop: re-read status in case cancelOn didn't fire (e.g. payment recorded
      // between Inngest delivery and step execution).
      const status = await step.run(`check-${s.stepNum}`, async () =>
        withTenant(tenantId, async (tx) => {
          const [inv] = await tx.select().from(invoice).where(eq(invoice.id, invoiceId));
          return inv?.status ?? "void";
        }),
      );
      if (status === "paid" || status === "void") return { stopped: true, atStep: s.stepNum };

      await step.run(`send-${s.stepNum}`, () =>
        sendDunningStep({ tenantId, invoiceId, step: s, gmailConnectionId: setup.gmailConnectionId }),
      );
    }

    return { completed: true };
  },
);
