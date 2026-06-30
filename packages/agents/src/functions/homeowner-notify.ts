import { adminDb, withTenant, tenant, communication, listStageEventsToNotify, markStageEventNotified, eq } from "@savvy/db";
import { parseHomeownerConfig, parseEmailConfig, homeownerStageCopy, signPayloadToken, requireSecret } from "@savvy/core";
import { getEmailSender } from "@savvy/integrations";
import { getTenantSms } from "../telephony";
import { inngest } from "../client";

const LOOKBACK_MS = 2 * 3_600_000;

export async function evaluateTenantHomeownerNotifs(tenantId: string, now: Date): Promise<{ sent: number }> {
  const [t] = await withTenant(tenantId, (tx) => tx.select({ settings: tenant.settings, name: tenant.name }).from(tenant).where(eq(tenant.id, tenantId)));
  const settings = (t?.settings ?? {}) as { homeowner?: unknown; email?: unknown };
  const cfg = parseHomeownerConfig(settings.homeowner);
  if (!cfg.enabled) return { sent: 0 };
  const gmailConnectionId = parseEmailConfig(settings.email).gmailConnectionId ?? null;
  const secret = requireSecret("UNSUBSCRIBE_SECRET", { devFallback: "dev-unsubscribe-secret" });
  const base = process.env.APP_BASE_URL ?? "http://localhost:3000";

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
    const link = `${base}/status/${signPayloadToken({ tenantId, jobId: ev.jobId }, secret)}`;
    const body = `${copy.headline} ${copy.body} Track your project: ${link}`;
    // SMS — send is fail-soft (no creds in dev/test); the communication row records the
    // intent-to-send regardless, matching appointment-reminders. jobId links it to the job timeline.
    if (ev.phone && !ev.smsOptOut) {
      try { if (smsSender) { const { sender, from } = smsSender; await sender.sendSms({ to: ev.phone, from, body }); } } catch { /* fail-soft */ }
      await withTenant(tenantId, (tx) => tx.insert(communication).values({ tenantId, jobId: ev.jobId, customerId: ev.customerId, channel: "sms", direction: "outbound", to: ev.phone, body, aiHandled: false }));
    }
    // Email
    if (ev.email && !ev.emailOptOut) {
      try { await getEmailSender({ gmailConnectionId }).sendEmail({ to: ev.email, from: process.env.EMAIL_FROM ?? "noreply@example.com", subject: copy.headline, html: `<p>${copy.body}</p><p><a href="${link}">Track your project</a></p>` }); } catch { /* fail-soft */ }
      await withTenant(tenantId, (tx) => tx.insert(communication).values({ tenantId, jobId: ev.jobId, customerId: ev.customerId, channel: "email", direction: "outbound", to: ev.email, body, aiHandled: false }));
    }
    await markStageEventNotified(tenantId, ev.eventId);
    sent++;
  }
  return { sent };
}

export const homeownerNotify = inngest.createFunction(
  { id: "homeowner-notify", concurrency: { limit: 1 } },
  { cron: "TZ=America/Phoenix */15 * * * *" },
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
