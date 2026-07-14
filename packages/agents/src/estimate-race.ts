// Estimate Experience slice 4: the 60-second rep race — the doing half.
// raceNotify fires on a hot page-open (rep SMS with one-tap links);
// raceResolve runs after the durable 60s sleep (NOVA texts the homeowner if
// the rep never engaged). Both are dependency-injected for tests; the Inngest
// wrapper at the bottom is the durable choreography.

import {
  withTenant,
  eq,
  estimate,
  lead,
  user,
  customer,
  communication,
  tenant as tenantTbl,
  recordEstimateEvent,
  listEstimateEvents,
  recordAgentRun,
  adminDb,
  ensureEstimateLink,
} from "@savvy/db";
import { isWithinQuietHours, parseHomeownerConfig, parseFinanceConfig } from "@savvy/core";
import { inngest } from "./client";
import { getTenantSms } from "./telephony";

type Deps = {
  getTenantSms: typeof getTenantSms;
  now?: () => Date;
};
const defaultDeps: Deps = { getTenantSms };

// Library-template slot — owner-editable copy arrives with the templates
// build; this is the shipped default.
const NOVA_RACE_COPY = "Saw you're looking over your roof estimate — questions? I'm here. Reply anytime.";

async function loadRaceContext(tenantId: string, estimateId: string) {
  return withTenant(tenantId, async (tx) => {
    const [est] = await tx.select().from(estimate).where(eq(estimate.id, estimateId));
    if (!est?.leadId) return null;
    const [l] = await tx.select({ assignedUserId: lead.assignedUserId, customerId: lead.customerId }).from(lead).where(eq(lead.id, est.leadId));
    if (!l) return null;
    const [rep] = l.assignedUserId
      ? await tx.select({ phone: user.phone, name: user.name }).from(user).where(eq(user.id, l.assignedUserId))
      : [null];
    const [cust] = l.customerId
      ? await tx.select({ id: customer.id, name: customer.name, phone: customer.phone, smsOptOut: customer.smsOptOut }).from(customer).where(eq(customer.id, l.customerId))
      : [null];
    return { est, rep: rep ?? null, cust: cust ?? null };
  });
}

export async function raceNotify(
  input: { tenantId: string; estimateId: string; sessionId: string; baseUrl?: string },
  deps: Deps = defaultDeps,
): Promise<{ notified: boolean; reason?: string }> {
  const { tenantId, estimateId, sessionId } = input;
  const now = deps.now?.() ?? new Date();

  const ctx = await loadRaceContext(tenantId, estimateId);
  if (!ctx?.rep?.phone || !ctx.cust) {
    await recordEstimateEvent({ tenantId, estimateId, kind: "race_skipped", sessionId, meta: { reason: "no_rep_or_customer" } });
    return { notified: false, reason: "no_rep_or_customer" };
  }

  // Quiet hours: nobody races at 2am — not the rep's phone, not the homeowner's.
  const [t] = await adminDb.select({ settings: tenantTbl.settings }).from(tenantTbl).where(eq(tenantTbl.id, tenantId));
  const settings = t?.settings as { homeowner?: unknown; finance?: unknown } | null;
  const qh = parseHomeownerConfig(settings?.homeowner).quietHours;
  const tz = parseFinanceConfig(settings?.finance).timezone;
  if (isWithinQuietHours(now, tz, qh)) {
    await recordEstimateEvent({ tenantId, estimateId, kind: "race_skipped", sessionId, meta: { reason: "quiet_hours" } });
    return { notified: false, reason: "quiet_hours" };
  }

  const base = (input.baseUrl ?? process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
  const { code } = await ensureEstimateLink({ tenantId, estimateId });
  const ackLink = `${base}/api/estimate/${code}/race-ack?s=${encodeURIComponent(sessionId)}`;

  const { sender, from } = await deps.getTenantSms(tenantId);
  await sender.sendSms({
    to: ctx.rep.phone,
    from,
    body: `${ctx.cust.name} is reading their estimate RIGHT NOW. Call: tel:${ctx.cust.phone ?? ""} — tap when you're on it: ${ackLink}`,
  });

  await recordEstimateEvent({ tenantId, estimateId, kind: "race_rep_notified", sessionId });
  await recordAgentRun({ tenantId, agent: "comms", taskKey: "estimate.race-notify", status: "ok", jobId: null });
  return { notified: true };
}

export async function raceResolve(
  input: { tenantId: string; estimateId: string; sessionId: string },
  deps: Deps = defaultDeps,
): Promise<{ novaTexted: boolean; reason?: string }> {
  const { tenantId, estimateId, sessionId } = input;

  const events = await listEstimateEvents(tenantId, estimateId);
  const acked = events.some((e) => e.kind === "race_rep_ack" && e.sessionId === sessionId);
  if (acked) return { novaTexted: false, reason: "rep_acked" };

  const ctx = await loadRaceContext(tenantId, estimateId);
  if (!ctx?.cust?.phone || ctx.cust.smsOptOut) return { novaTexted: false, reason: "no_customer_phone" };

  // A rep engaging by ANY outbound message to this customer counts as won.
  const notify = events.find((e) => e.kind === "race_rep_notified" && e.sessionId === sessionId);
  if (notify) {
    const talked = await withTenant(tenantId, (tx) =>
      tx
        .select({ id: communication.id, createdAt: communication.createdAt, direction: communication.direction, to: communication.to })
        .from(communication)
        .where(eq(communication.customerId, ctx.cust!.id)),
    );
    if (talked.some((c) => c.direction === "outbound" && c.createdAt > notify.createdAt)) {
      return { novaTexted: false, reason: "rep_messaged" };
    }
  }

  const { sender, from } = await deps.getTenantSms(tenantId);
  await sender.sendSms({ to: ctx.cust.phone, from, body: NOVA_RACE_COPY });
  await withTenant(tenantId, (tx) =>
    tx.insert(communication).values({
      tenantId,
      customerId: ctx.cust!.id,
      channel: "sms",
      direction: "outbound",
      to: ctx.cust!.phone,
      body: NOVA_RACE_COPY,
      aiHandled: true,
    }),
  );
  await recordEstimateEvent({ tenantId, estimateId, kind: "race_nova_text", sessionId });
  await recordAgentRun({ tenantId, agent: "comms", taskKey: "estimate.race-nova", status: "ok", jobId: null });
  return { novaTexted: true };
}

/** Durable choreography: hot open → rep SMS → 60s → NOVA fallback. */
export const estimateOpenRace = inngest.createFunction(
  { id: "estimate-open-race", idempotency: "event.data.estimateId + '-' + event.data.sessionId" },
  { event: "estimate/page.opened" },
  async ({ event, step }) => {
    const { tenantId, estimateId, sessionId } = event.data;
    const base = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

    const notify = await step.run("notify-rep", () =>
      raceNotify({ tenantId, estimateId, sessionId, baseUrl: base }),
    );
    if (!notify.notified) return { skipped: notify.reason };

    await step.sleep("the-60-seconds", "60s");

    return step.run("resolve", () => raceResolve({ tenantId, estimateId, sessionId }));
  },
);
