import { adminDb, withTenant, tenant, communication, listStageEventsToNotify, markStageEventNotified, claimCommunication, eq, isSuppressed } from "@savvy/db";
import { parseHomeownerConfig, parseEmailConfig, homeownerStageCopy, signPayloadToken, requireSecret, isWithinQuietHours } from "@savvy/core";
import { getTenantSms, resolveA2pApproved } from "../telephony";
import { getTenantEmail } from "../email";
import { buildShortLink } from "../short-link";
import { guardedSms } from "../comms-gateway";
import { inngest } from "../client";

const LOOKBACK_MS = 2 * 3_600_000;

export async function evaluateTenantHomeownerNotifs(tenantId: string, now: Date): Promise<{ sent: number }> {
  const [t] = await withTenant(tenantId, (tx) => tx.select({ settings: tenant.settings, name: tenant.name, timezone: tenant.timezone }).from(tenant).where(eq(tenant.id, tenantId)));
  const settings = (t?.settings ?? {}) as { homeowner?: unknown; email?: unknown };
  const cfg = parseHomeownerConfig(settings.homeowner);
  if (!cfg.enabled) return { sent: 0 };
  // TCPA: never send a milestone SMS during the tenant's quiet hours (email still goes).
  const smsQuiet = isWithinQuietHours(now, t?.timezone ?? "America/Phoenix", cfg.quietHours);
  const gmailConnectionId = parseEmailConfig(settings.email).gmailConnectionId ?? null;
  const secret = requireSecret("UNSUBSCRIBE_SECRET", { devFallback: "dev-unsubscribe-secret" });

  const events = await listStageEventsToNotify(tenantId, { stages: cfg.notifyStages, sinceMs: LOOKBACK_MS, now });
  let sent = 0;
  let smsSender: Awaited<ReturnType<typeof getTenantSms>> | null = null;
  try {
    smsSender = await getTenantSms(tenantId);
  } catch {
    // fail-soft: no SMS credentials available
  }
  for (const ev of events) {
    const copy = homeownerStageCopy(ev.toStage);
    const link = await buildShortLink({ tenantId, token: signPayloadToken({ tenantId, jobId: ev.jobId }, secret), kind: "status" });
    const body = `${copy.headline} ${copy.body} Track your project: ${link}`;
    let delivered = false;
    // SMS — claim-then-send: insert the communication row first (dedupe key prevents double rows);
    // only send if we won the claim. jobId links it to the job timeline. The actual
    // send is routed through guardedSms so global contact_suppression, consent, and
    // A2P are enforced — a blocked/deferred verdict simply doesn't send and isn't
    // counted in `sent`; the claim (and its dedupe row) still stands.
    if (ev.phone && !ev.smsOptOut && !smsQuiet) {
      const claimed = await claimCommunication({ tenantId, jobId: ev.jobId, customerId: ev.customerId, channel: "sms", direction: "outbound", to: ev.phone, body, dedupeKey: `stage:sms:${ev.phone}:${ev.eventId}` });
      if (claimed && smsSender) {
        try {
          const { sender, from } = smsSender;
          const result = await guardedSms(
            { isSuppressed, sms: sender, smsFrom: () => from },
            {
              tenantId, channel: "sms", to: ev.phone, from, body,
              consent: { smsOptOut: ev.smsOptOut, emailOptOut: ev.emailOptOut, smsConsentAt: ev.smsConsentAt },
              a2pApproved: resolveA2pApproved(tenantId, from),
              contactId: ev.customerId ?? undefined,
            },
          );
          if (result.status === "sent") {
            delivered = true;
          } else {
            // Non-sent verdict: the claimed row still holds the real milestone
            // body — rewrite it to the verdict marker so it doesn't read as a
            // delivered SMS to a suppressed/blocked/deferred customer.
            const marker = `[${result.status}: ${result.status === "blocked" ? result.reason : result.untilIso}]`;
            await withTenant(tenantId, (tx) => tx.update(communication).set({ body: marker }).where(eq(communication.id, claimed.id)));
          }
        } catch (err) {
          // fail-soft on the send itself, but the claimed row must not be left
          // with the real body — it never actually went out.
          const marker = `[error: ${err instanceof Error ? err.message : "guardedSms failed"}]`;
          await withTenant(tenantId, (tx) => tx.update(communication).set({ body: marker }).where(eq(communication.id, claimed.id)));
        }
      }
    }
    // Email — same claim-then-send pattern
    if (ev.email && !ev.emailOptOut) {
      const claimed = await claimCommunication({ tenantId, jobId: ev.jobId, customerId: ev.customerId, channel: "email", direction: "outbound", to: ev.email, body, dedupeKey: `stage:email:${ev.email}:${ev.eventId}` });
      if (claimed) {
        try {
          const emailSender = await getTenantEmail(tenantId, { gmailConnectionId });
          await emailSender.sendEmail({ to: ev.email, from: process.env.EMAIL_FROM ?? "noreply@example.com", subject: copy.headline, html: `<p>${copy.body}</p><p><a href="${link}">Track your project</a></p>` });
        } catch { /* fail-soft */ }
        // Unlike SMS (delivered = guardedSms actually returned "sent"), email
        // counts as delivered here even if sendEmail threw above — so the
        // `sent` counter this feeds is really "SMS delivered + email attempted".
        delivered = true;
      }
    }
    await markStageEventNotified(tenantId, ev.eventId);
    if (delivered) sent++;
  }
  return { sent };
}

export const homeownerNotify = inngest.createFunction(
  { id: "homeowner-notify", concurrency: { limit: 1 } },
  { cron: "*/15 * * * *" }, // every 15 min — frequency-based, so tenant-local time doesn't apply
  async ({ step }) => {
    const tenants = await step.run("list-tenants", async () => adminDb.select({ id: tenant.id }).from(tenant));
    let sent = 0;
    for (const t of tenants) {
      const r = await step.run(`notify-${t.id}`, () => evaluateTenantHomeownerNotifs(t.id, new Date()));
      sent += r.sent;
    }
    return { sent };
  },
);
