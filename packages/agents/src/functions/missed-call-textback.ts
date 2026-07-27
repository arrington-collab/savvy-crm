import { withTenant, eq, lead, customer, communication, isSuppressed, tenant as tenantTbl } from "@savvy/db";
import { renderLocalized, signPayloadToken, requireSecret } from "@savvy/core";
import type { SmsSender } from "@savvy/integrations";
import { getTenantSms, resolveA2pApproved } from "../telephony";
import { guardedSms, type GuardedSmsResult } from "../comms-gateway";
import { resolveSendContext } from "../send-context";
import { buildShortLink } from "../short-link";
import { inngest } from "../client";

/**
 * Pure, unit-testable: the bilingual "sorry we missed your call" + booking-link
 * body. EN/ES via renderLocalized (Slice C1 helper) — resolved off the lead's
 * customer.preferredLanguage.
 */
export function buildMissedCallSms(v: { companyName: string; bookingUrl: string; language?: string | null }): string {
  return renderLocalized(
    {
      en: "Sorry we missed your call at {{companyName}}! Book a time here: {{bookingUrl}}",
      es: "¡Perdón por no contestar en {{companyName}}! Reserve aquí: {{bookingUrl}}",
    },
    v.language,
    { companyName: v.companyName, bookingUrl: v.bookingUrl },
  );
}

export interface MissedCallTextbackDeps {
  isSuppressed: (a: { tenantId: string; contactId?: string; phoneE164?: string; channel: "sms" }) => Promise<boolean>;
  sms: SmsSender;
  smsFrom: () => string;
}

export interface MissedCallCustomerCtx {
  customerId: string | null;
  phone: string | null;
  preferredLanguage: string | null;
  smsOptOut: boolean;
  emailOptOut: boolean;
  smsConsentAt: Date | null;
}

export type MissedCallTextbackOutcome =
  | { skipped: "no-phone" }
  | { body: string; result: GuardedSmsResult };

/**
 * The injectable send unit: builds the localized body and sends it via the
 * guardedSms chokepoint (suppression/consent/a2p enforced). No `quiet` block
 * is passed — a missed-call text-back is a direct, immediate response to a
 * customer-initiated call, not a scheduled/nurture touch, so quiet-hours
 * deferral is intentionally NOT applied here (see missedCallTextback below).
 * Kept separate from the Inngest handler (which resolves the lead/customer
 * from Postgres and mints the booking link) so it's unit-testable with a
 * fake SmsSender + isSuppressed, mirroring comms-gateway.test.ts.
 */
export async function sendMissedCallTextback(
  deps: MissedCallTextbackDeps,
  args: {
    tenantId: string;
    customer: MissedCallCustomerCtx;
    companyName: string;
    bookingUrl: string;
    from?: string;
    a2pApproved: boolean;
  },
): Promise<MissedCallTextbackOutcome> {
  if (!args.customer.phone) return { skipped: "no-phone" };
  const body = buildMissedCallSms({
    companyName: args.companyName,
    bookingUrl: args.bookingUrl,
    language: args.customer.preferredLanguage,
  });
  const result = await guardedSms(
    { isSuppressed: deps.isSuppressed, sms: deps.sms, smsFrom: deps.smsFrom },
    {
      tenantId: args.tenantId,
      channel: "sms",
      to: args.customer.phone,
      from: args.from,
      body,
      consent: {
        smsOptOut: args.customer.smsOptOut,
        emailOptOut: args.customer.emailOptOut,
        smsConsentAt: args.customer.smsConsentAt,
      },
      a2pApproved: args.a2pApproved,
      contactId: args.customer.customerId ?? undefined,
      // Intentionally no `quiet` — see the doc comment above.
    },
  );
  return { body, result };
}

export const missedCallTextback = inngest.createFunction(
  { id: "missed-call-textback", concurrency: { limit: 5 } },
  { event: "call/missed" },
  async ({ event, step }) => {
    const { tenantId, leadId } = event.data as { tenantId: string; leadId: string; fromNumber: string; toNumber: string };

    // Load the lead's customer + tenant (for branding via resolveSendContext)
    // in one durable step. createLeadForTenant (the webhook's caller) always
    // sets lead.customerId, but guard defensively in case of a stale/bad event.
    const ctx = await step.run("load", () =>
      withTenant(tenantId, async (tx) => {
        const [l] = await tx.select().from(lead).where(eq(lead.id, leadId));
        if (!l?.customerId) return null;
        const [c] = await tx.select().from(customer).where(eq(customer.id, l.customerId));
        const [t] = await tx.select().from(tenantTbl).where(eq(tenantTbl.id, tenantId));
        if (!c || !t) return null;
        return {
          customerId: c.id,
          phone: c.phone,
          preferredLanguage: c.preferredLanguage,
          smsOptOut: c.smsOptOut,
          emailOptOut: c.emailOptOut,
          smsConsentAt: c.smsConsentAt,
          tenantName: t.name,
          tenantSettings: t.settings,
        };
      }),
    );
    if (!ctx) return { skipped: "no-customer" };

    // locationId is null — the call/missed event carries no location (see brief-C3).
    const sendCtx = resolveSendContext({ name: ctx.tenantName, settings: ctx.tenantSettings }, null);

    const secret = requireSecret("UNSUBSCRIBE_SECRET", { devFallback: "dev-unsubscribe-secret" });
    const token = signPayloadToken({ leadId, tenantId, type: "inspection" }, secret);
    const bookingUrl = await step.run("mint-short-link", () => buildShortLink({ tenantId, token, kind: "booking" }));

    const sendResult = await step.run("send-textback", async () => {
      // Re-hydrate smsConsentAt — Inngest step.run serialises "load"'s return
      // through JSON, so a Date arrives back as a string.
      const smsConsentAt = ctx.smsConsentAt ? new Date(ctx.smsConsentAt as unknown as string) : null;

      let loggedBody: string | null = null;
      let sent = false;
      if (ctx.phone) {
        try {
          const { sender, from } = await getTenantSms(tenantId);
          const outcome = await sendMissedCallTextback(
            { isSuppressed, sms: sender, smsFrom: () => from },
            {
              tenantId,
              customer: {
                customerId: ctx.customerId, phone: ctx.phone, preferredLanguage: ctx.preferredLanguage,
                smsOptOut: ctx.smsOptOut, emailOptOut: ctx.emailOptOut, smsConsentAt,
              },
              companyName: sendCtx.companyName,
              bookingUrl,
              from,
              a2pApproved: resolveA2pApproved(tenantId, from),
            },
          );
          if ("result" in outcome) {
            const { result } = outcome;
            sent = result.status === "sent";
            if (result.status !== "sent") {
              loggedBody = `[${result.status}: ${result.status === "blocked" ? result.reason : result.untilIso}]`;
            } else {
              loggedBody = outcome.body;
            }
          }
        } catch (err) {
          // getTenantSms/guardedSms threw (e.g. a transient isSuppressed DB
          // error, or the sender itself failing) — the real send never
          // fired, so this must NOT be logged as a successful "sent" comm.
          loggedBody = `[error: ${err instanceof Error ? err.message : "guardedSms failed"}]`;
        }
      }

      // Fail-soft comm log: a logging failure must never fail the whole
      // text-back step (the SMS, if any, already went out above).
      if (loggedBody) {
        try {
          await withTenant(tenantId, (tx) =>
            tx.insert(communication).values({
              tenantId, customerId: ctx.customerId, channel: "sms", direction: "outbound",
              to: ctx.phone, body: loggedBody, aiHandled: false,
            }),
          );
        } catch (err) {
          console.error("missed-call-textback: failed to log communication:", err instanceof Error ? err.message : err);
        }
      }
      return { sent };
    });

    return { done: true, sent: sendResult.sent };
  },
);
