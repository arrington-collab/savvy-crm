import { withTenant, eq, materialOrder, job, communication, customer as customerTbl, tenant as tenantTbl } from "@savvy/db";
import { parseHomeownerConfig, parseEmailConfig, buildDeliveryEveTouch, signPayloadToken, requireSecret } from "@savvy/core";
import { getEmailSender } from "@savvy/integrations";
import { getTenantSms } from "../telephony";
import { inngest } from "../client";

/**
 * Evening-before-DELIVERY homeowner text (§F/F2b): when a material order is placed
 * (`material/ordered`), schedule a heads-up the evening before the delivery date
 * (`material_order.neededByAt`). Durable (step.sleepUntil), quiet-hours-safe (times from
 * buildDeliveryEveTouch), config-driven copy, opt-out-aware, fail-soft. Stops if the order
 * is canceled before the send fires.
 */
export const homeownerDeliveryNotify = inngest.createFunction(
  { id: "homeowner-delivery-notify", concurrency: { limit: 5 } },
  { event: "material/ordered" },
  async ({ event, step }) => {
    const { materialOrderId, tenantId } = event.data;

    const ctx = await step.run("load", () => withTenant(tenantId, async (tx) => {
      const [mo] = await tx.select({ jobId: materialOrder.jobId, neededByAt: materialOrder.neededByAt, status: materialOrder.status }).from(materialOrder).where(eq(materialOrder.id, materialOrderId));
      if (!mo || mo.status === "canceled" || !mo.neededByAt) return null;
      const [j] = await tx.select({ customerId: job.customerId }).from(job).where(eq(job.id, mo.jobId));
      const cust = j?.customerId ? (await tx.select().from(customerTbl).where(eq(customerTbl.id, j.customerId)))[0] : undefined;
      if (!cust) return null;
      const [t] = await tx.select().from(tenantTbl).where(eq(tenantTbl.id, tenantId));
      return {
        jobId: mo.jobId,
        deliveryAtMs: mo.neededByAt.getTime(),
        customerId: cust.id,
        phone: cust.phone ?? null,
        email: cust.email ?? null,
        smsOptOut: cust.smsOptOut,
        emailOptOut: cust.emailOptOut,
        tz: t?.timezone ?? "America/Phoenix",
        settings: (t?.settings ?? {}) as { homeowner?: unknown; email?: unknown },
        nowMs: Date.now(),
      };
    }));
    if (!ctx) return { skipped: true };

    const cfg = parseHomeownerConfig(ctx.settings.homeowner);
    if (!cfg.enabled) return { skipped: "disabled" };
    const touch = buildDeliveryEveTouch(new Date(ctx.deliveryAtMs), ctx.tz, cfg, new Date(ctx.nowMs));
    if (!touch) return { skipped: "past_or_no_date" };

    const gmailConnectionId = parseEmailConfig(ctx.settings.email).gmailConnectionId ?? null;
    const secret = requireSecret("UNSUBSCRIBE_SECRET", { devFallback: "dev-unsubscribe-secret" });
    const base = process.env.APP_BASE_URL ?? "http://localhost:3000";
    const link = `${base}/status/${signPayloadToken({ tenantId, jobId: ctx.jobId }, secret)}`;

    await step.sleepUntil("wait-delivery-eve", new Date(touch.fireAt as unknown as string));

    const stillActive = await step.run("recheck", () =>
      withTenant(tenantId, async (tx) => {
        const [mo] = await tx.select({ status: materialOrder.status }).from(materialOrder).where(eq(materialOrder.id, materialOrderId));
        return !!mo && mo.status !== "canceled";
      }),
    );
    if (!stillActive) return { stopped: true };

    await step.run("send", async () => {
      const body = `${touch.body} Track your project: ${link}`;
      if (ctx.phone && !ctx.smsOptOut) {
        try { const { sender, from } = await getTenantSms(tenantId); await sender.sendSms({ to: ctx.phone, from, body }); } catch { /* fail-soft */ }
        await withTenant(tenantId, (tx) => tx.insert(communication).values({ tenantId, jobId: ctx.jobId, customerId: ctx.customerId, channel: "sms", direction: "outbound", to: ctx.phone, body, aiHandled: false }));
      }
      if (ctx.email && !ctx.emailOptOut) {
        try { await getEmailSender({ gmailConnectionId }).sendEmail({ to: ctx.email, from: process.env.EMAIL_FROM ?? "noreply@example.com", subject: "Your roofing materials arrive tomorrow", html: `<p>${touch.body}</p><p><a href="${link}">Track your project</a></p>` }); } catch { /* fail-soft */ }
        await withTenant(tenantId, (tx) => tx.insert(communication).values({ tenantId, jobId: ctx.jobId, customerId: ctx.customerId, channel: "email", direction: "outbound", to: ctx.email, body, aiHandled: false }));
      }
      return { sent: true };
    });
    return { scheduled: true };
  },
);
