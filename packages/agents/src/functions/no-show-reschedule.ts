import { withTenant, eq, appointment, communication, isSuppressed, customer as customerTbl, tenant as tenantTbl } from "@savvy/db";
import { renderLocalized, signPayloadToken, requireSecret, nextAllowedSendTime, type QuietHours } from "@savvy/core";
import type { SmsSender } from "@savvy/integrations";
import { getTenantSms, resolveA2pApproved } from "../telephony";
import { guardedSms, type GuardedSmsResult } from "../comms-gateway";
import { resolveSendContext } from "../send-context";
import { buildShortLink } from "../short-link";
import { inngest } from "../client";

/**
 * Cadence drip key the customer is handed back to after a no-show reschedule
 * text. "nurture" is the dev-seed key (packages/db/src/seed.ts) for the
 * general new-lead nurture sequence — there is no dedicated "no-show" drip and
 * no provisioning-runbook step (unlike ensureEstimateFollowupDrip for
 * estimate-followup) that guarantees ANY drip with this key exists for a given
 * production tenant. The re-enrollment below is deliberately fail-soft for
 * that reason: see the comment on the "reenroll-cadence" step.
 */
export const NO_SHOW_REENROLL_DRIP_KEY = "nurture";

/**
 * Pure, unit-testable: the bilingual no-show reschedule body. EN/ES via
 * renderLocalized (Slice C1 helper) — resolved off the customer's
 * preferredLanguage.
 */
export function buildNoShowSms(v: { companyName: string; bookingUrl: string; language?: string | null }): string {
  return renderLocalized(
    {
      en: "We missed you for your appointment with {{companyName}}. Reschedule here: {{bookingUrl}}",
      es: "Lamentamos no verte en tu cita con {{companyName}}. Reprograma aquí: {{bookingUrl}}",
    },
    v.language,
    { companyName: v.companyName, bookingUrl: v.bookingUrl },
  );
}

/**
 * Pure decision: is `now` inside the tenant's quiet hours, and if so, what
 * Date should the caller sleep until before sending? Returns null when `now`
 * is already outside quiet hours (send immediately, no sleep needed).
 *
 * Extracted so the "should we sleep, and until when" decision is
 * unit-testable without a live Inngest runtime — mirrors the inline
 * `nextAllowedSendTime` check lead-cadence.ts makes per-touch before its own
 * `step.sleepUntil` call.
 */
export function quietSleepUntil(now: Date, tz: string, qh: QuietHours): Date | null {
  const allowed = nextAllowedSendTime(now, tz, qh);
  return allowed.getTime() > now.getTime() ? allowed : null;
}

export interface NoShowRescheduleDeps {
  isSuppressed: (a: { tenantId: string; contactId?: string; phoneE164?: string; channel: "sms" }) => Promise<boolean>;
  sms: SmsSender;
  smsFrom: () => string;
}

export interface NoShowCustomerCtx {
  customerId: string | null;
  phone: string | null;
  preferredLanguage: string | null;
  smsOptOut: boolean;
  emailOptOut: boolean;
  smsConsentAt: Date | null;
}

export type NoShowRescheduleOutcome =
  | { skipped: "not-no-show" }
  | { skipped: "no-phone" }
  | { body: string; result: GuardedSmsResult };

/**
 * The injectable guard+send unit: re-guards `reason === "no_show"` (so this is
 * unit-testable for "does nothing on any other appointment/changed reason"
 * without any DB/Inngest plumbing — the Inngest handler below ALSO guards this
 * up front, before any step.run, purely as a DB-round-trip optimization for the
 * ~5 other reasons that fire on the same event), then sends the localized
 * reschedule body via the guardedSms chokepoint.
 *
 * Quiet-hours ARE enforced here (`quiet` is required, not optional) — contrast
 * missed-call-textback.ts's sendMissedCallTextback, which omits `quiet`
 * because a text-back is an immediate response to a customer-initiated call.
 * A no-show reschedule is outreach initiated by us on a schedule, not a direct
 * response, so it defers like any other nurture/cadence touch — this stays
 * as defense-in-depth (guardedSms re-checks at actual send time), but the
 * Inngest handler below already sleeps past quiet hours via `quietSleepUntil`
 * before ever calling this function, so a "deferred" result from `guardedSms`
 * here should be rare in production, not the normal quiet-hours path.
 */
export async function sendNoShowReschedule(
  deps: NoShowRescheduleDeps,
  args: {
    reason: string;
    tenantId: string;
    customer: NoShowCustomerCtx;
    companyName: string;
    bookingUrl: string;
    from?: string;
    a2pApproved: boolean;
    quiet: { tz: string; qh: QuietHours };
    now?: Date;
  },
): Promise<NoShowRescheduleOutcome> {
  if (args.reason !== "no_show") return { skipped: "not-no-show" };
  if (!args.customer.phone) return { skipped: "no-phone" };
  const body = buildNoShowSms({
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
      quiet: args.quiet,
      now: args.now,
      contactId: args.customer.customerId ?? undefined,
    },
  );
  return { body, result };
}

/**
 * Pure decision: hand the customer back to cadence ONLY on a confirmed send.
 * A skip (not-no_show / no-phone), a block (suppressed/no-consent/a2p/cap), or
 * a quiet-hours defer must never silently re-enroll. In production the
 * Inngest handler below now sleeps past quiet hours (via `quietSleepUntil`)
 * BEFORE ever calling sendNoShowReschedule, so a "deferred" outcome should no
 * longer normally occur there — this stays conservative regardless, in case
 * this pure unit is ever invoked directly without that sleep (e.g. a test, or
 * a boundary race between the sleep decision and guardedSms's own re-check).
 *
 * Note this does NOT mean the appointment gets another attempt later: the
 * no_show producer (scheduling-actions.ts markStatusAction) sets a permanent
 * Inngest event id `appt-noshow-${appointmentId}` on the emit, so a repeat
 * no_show event for the SAME appointment row is deduped by Inngest before
 * this handler ever runs again — there is no "try again from scratch" for
 * that appointment. A genuine retry only happens if the customer is
 * re-booked onto a NEW appointment (a new id) that later also no-shows.
 */
export function shouldReenrollAfterNoShow(outcome: NoShowRescheduleOutcome): boolean {
  return "result" in outcome && outcome.result.status === "sent";
}

export const noShowReschedule = inngest.createFunction(
  { id: "no-show-reschedule", concurrency: { limit: 5 } },
  { event: "appointment/changed" },
  async ({ event, step }) => {
    const { appointmentId, tenantId, reason } = event.data;
    // Guard first, before any DB round-trip: this handler subscribes to the
    // same appointment/changed event as appointmentCalendarSync and
    // appointmentReminders, which also fire on rescheduled/reassigned/
    // canceled/done/weather_rescheduled. Only a no_show gets a customer-facing
    // reschedule text today.
    if (reason !== "no_show") return { skipped: "not-no-show" };

    const ctx = await step.run("load", () =>
      withTenant(tenantId, async (tx) => {
        const [a] = await tx.select().from(appointment).where(eq(appointment.id, appointmentId));
        // appointment has customerId as a direct FK (mirrors appointment-reminders.ts).
        if (!a?.customerId) return null;
        const [c] = await tx.select().from(customerTbl).where(eq(customerTbl.id, a.customerId));
        const [t] = await tx.select().from(tenantTbl).where(eq(tenantTbl.id, tenantId));
        if (!c || !t) return null;
        return {
          customerId: c.id,
          leadId: a.leadId,
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

    // locationId is null — appointment/changed carries no location today (see brief-C4/C1).
    const sendCtx = resolveSendContext({ name: ctx.tenantName, settings: ctx.tenantSettings }, null);

    const secret = requireSecret("UNSUBSCRIBE_SECRET", { devFallback: "dev-unsubscribe-secret" });
    const token = signPayloadToken({ appointmentId, tenantId, type: "inspection" }, secret);
    const bookingUrl = await step.run("mint-short-link", () => buildShortLink({ tenantId, token, kind: "booking" }));

    // Quiet hours: SLEEP THEN SEND, mirroring lead-cadence.ts's per-touch gate.
    // Without this, marking a no-show at night would hit guardedSms's quiet
    // check directly, get `{ status: "deferred" }`, and the reschedule text
    // would never actually go out — shouldReenrollAfterNoShow also never
    // re-enrolls on a deferred outcome, so the whole touchpoint would silently
    // no-op for any no-show marked during the tenant's quiet window. Compute
    // the decision inside a step.run so the `now` snapshot (and therefore the
    // sleep target) is durable across replays, then sleepUntil OUTSIDE any
    // step.run (step.sleepUntil is itself the durable primitive).
    const quietUntilIso = await step.run("quiet-check", () => {
      const until = quietSleepUntil(new Date(), sendCtx.tz, sendCtx.quietHours);
      return until ? until.toISOString() : null;
    });
    if (quietUntilIso) {
      await step.sleepUntil("quiet-window", quietUntilIso);
    }

    // Keyed on appointmentId — one reschedule attempt per appointment. Combined
    // with the `id: appt-noshow-${appointmentId}` Inngest event id the no_show
    // producer (scheduling-actions.ts markStatusAction) sets, a duplicate
    // appointment/changed(no_show) send for the same appointment is deduped
    // before it ever reaches this run, and step.run memoizes this step within
    // any single run's retries.
    const sendResult = await step.run(`send-noshow-${appointmentId}`, async () => {
      // Inngest step.run serialises the "load" step's return through JSON —
      // smsConsentAt arrives as a string. Re-hydrate before passing to the guard.
      const smsConsentAt = ctx.smsConsentAt ? new Date(ctx.smsConsentAt as unknown as string) : null;

      let loggedBody: string | null = null;
      let sent = false;
      try {
        const { sender, from } = await getTenantSms(tenantId);
        const outcome = await sendNoShowReschedule(
          { isSuppressed, sms: sender, smsFrom: () => from },
          {
            reason,
            tenantId,
            customer: {
              customerId: ctx.customerId, phone: ctx.phone, preferredLanguage: ctx.preferredLanguage,
              smsOptOut: ctx.smsOptOut, emailOptOut: ctx.emailOptOut, smsConsentAt,
            },
            companyName: sendCtx.companyName,
            bookingUrl,
            from,
            a2pApproved: resolveA2pApproved(tenantId, from),
            quiet: { tz: sendCtx.tz, qh: sendCtx.quietHours },
          },
        );
        if ("result" in outcome) {
          const { result } = outcome;
          sent = result.status === "sent";
          loggedBody = result.status === "sent"
            ? outcome.body
            : `[${result.status}: ${result.status === "blocked" ? result.reason : result.untilIso}]`;
        }
        // outcome.skipped === "no-phone" (or "not-no-show", unreachable here since
        // the handler already guarded reason) -> loggedBody stays null, nothing logged.
      } catch (err) {
        // getTenantSms/guardedSms threw (e.g. a transient isSuppressed DB error,
        // or the sender itself failing) — the real send never fired, so this
        // must NOT be logged as a successful "sent" comm.
        loggedBody = `[error: ${err instanceof Error ? err.message : "guardedSms failed"}]`;
      }

      // Fail-soft comm log: a logging failure must never fail the whole step
      // (the SMS, if any, already went out above).
      if (loggedBody) {
        try {
          await withTenant(tenantId, (tx) =>
            tx.insert(communication).values({
              tenantId, customerId: ctx.customerId, channel: "sms", direction: "outbound",
              to: ctx.phone, body: loggedBody, aiHandled: false,
            }),
          );
        } catch (err) {
          console.error("no-show-reschedule: failed to log communication:", err instanceof Error ? err.message : err);
        }
      }
      return { sent };
    });

    // Hand back to cadence ONLY after a confirmed send (shouldReenrollAfterNoShow
    // logic inlined here as a plain boolean check — see its doc comment for why
    // skip/blocked/deferred must never re-enroll). Fail-soft + a sibling step (not
    // nested in send-noshow-${appointmentId}) so a re-enroll failure can NEVER
    // unwind the SMS that already sent: "nurture" (NO_SHOW_REENROLL_DRIP_KEY) has
    // no provisioning-runbook guarantee of existing for every tenant (dev seed
    // only — see the constant's doc comment), and dripRun itself already no-ops
    // safely when the key doesn't resolve to an active drip. This try/catch is
    // the extra layer covering a thrown inngest.send (e.g. a transient
    // Inngest-engine error), not the missing-drip case (which dripRun handles).
    if (sendResult.sent) {
      await step.run("reenroll-cadence", async () => {
        try {
          await inngest.send({
            name: "drip/enroll",
            data: {
              tenantId,
              dripKey: NO_SHOW_REENROLL_DRIP_KEY,
              customerId: ctx.customerId,
              ...(ctx.leadId ? { leadId: ctx.leadId } : {}),
            },
          });
        } catch (err) {
          console.error("no-show-reschedule: drip/enroll re-enrollment failed (SMS already sent):", err instanceof Error ? err.message : err);
        }
      });
    }

    return { done: true, sent: sendResult.sent };
  },
);
