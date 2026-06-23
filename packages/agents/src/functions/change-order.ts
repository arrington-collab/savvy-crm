import { withTenant, approveChangeOrder, sendInvoice, recordAgentRun, invoice, tenant, eq } from "@savvy/db";
import { stripeGateway, type StripeGateway } from "@savvy/integrations";
import { inngest } from "../client";

/** Thin wrapper so the apply step stays a one-liner and the test can call the work directly. */
export async function applyAcceptedChangeOrder(
  tenantId: string,
  changeOrderId: string,
): Promise<{ invoiceCreated: boolean; invoiceId: string | null }> {
  const res = await approveChangeOrder({ tenantId, changeOrderId });
  await recordAgentRun({ tenantId, agent: "finance", taskKey: "change-order.apply", status: "ok" });
  return res;
}

export type AutoSendResult =
  | { sent: true; invoiceId: string }
  | { sent: false; reason: "no-invoice" | "already-sent" | "stripe-not-connected" };

/**
 * Finance agent: auto-send a draft supplemental invoice created by approveChangeOrder.
 * Idempotent via invoice.status='draft' (sendInvoice flips draft->sent atomically).
 * Resilient: no Stripe account -> skipped (no throw, no infinite Inngest retry).
 * Outbound Stripe I/O happens outside any withTenant tx.
 */
export async function autoSendSupplementalInvoice(
  input: { tenantId: string; invoiceId: string | null },
  deps: { stripe?: StripeGateway } = {},
): Promise<AutoSendResult> {
  const stripe = deps.stripe ?? stripeGateway;
  const { tenantId } = input;
  if (!input.invoiceId) return { sent: false, reason: "no-invoice" };
  const invoiceId = input.invoiceId;

  const ctx = await withTenant(tenantId, async (tx) => {
    const [inv] = await tx.select().from(invoice).where(eq(invoice.id, invoiceId));
    const [t] = await tx.select().from(tenant).where(eq(tenant.id, tenantId));
    return { inv, accountId: t?.stripeAccountId ?? null };
  });
  if (!ctx.inv || ctx.inv.status !== "draft") return { sent: false, reason: "already-sent" };

  if (!ctx.accountId) {
    await recordAgentRun({
      tenantId, agent: "finance", taskKey: "change-order.auto-send-invoice",
      status: "skipped", jobId: ctx.inv.jobId, error: "stripe-not-connected",
    });
    return { sent: false, reason: "stripe-not-connected" };
  }

  const sent = await sendInvoice({ tenantId, invoiceId }); // number + draft->sent (atomic)

  // sendInvoice's UPDATE is WHERE status='draft'; a concurrent run may have already
  // flipped it (row undefined at runtime despite the non-null type), and a supplemental
  // invoice must have a positive amount to charge. Either way: don't call Stripe.
  if (!sent || (sent.amountDue ?? 0) <= 0) {
    return { sent: false, reason: "already-sent" };
  }

  const base = process.env.APP_BASE_URL ?? "http://localhost:3000";
  const session = await stripe.createCheckoutSession({
    connectedAccountId: ctx.accountId,
    amountCents: sent.amountDue ?? 0,
    invoiceId, tenantId,
    description: sent.number ?? "Supplemental Invoice",
    successUrl: `${base}/invoices/${invoiceId}?paid=1`,
    cancelUrl: `${base}/invoices/${invoiceId}`,
  });

  await withTenant(tenantId, (tx) =>
    tx.update(invoice)
      .set({
        stripeCheckoutSessionId: session.id,
        ...(session.paymentIntentId ? { stripePaymentIntentId: session.paymentIntentId } : {}),
      })
      .where(eq(invoice.id, invoiceId)),
  );

  await recordAgentRun({
    tenantId, agent: "finance", taskKey: "change-order.auto-send-invoice",
    status: "ok", jobId: sent.jobId,
  });
  return { sent: true, invoiceId };
}

export const changeOrderAccepted = inngest.createFunction(
  { id: "change-order-accepted", concurrency: { limit: 5 } },
  { event: "change_order/accepted" },
  async ({ event, step }) => {
    const applied = await step.run("apply", () =>
      applyAcceptedChangeOrder(event.data.tenantId, event.data.changeOrderId));
    const result = await step.run("auto-send-invoice", () =>
      autoSendSupplementalInvoice({ tenantId: event.data.tenantId, invoiceId: applied.invoiceId }));
    if (result.sent) {
      await step.run("enroll-dunning", async () => {
        await inngest.send({ name: "invoice/sent", data: { invoiceId: result.invoiceId, tenantId: event.data.tenantId } });
        return { enrolled: true };
      });
    }
    return { invoiceCreated: applied.invoiceCreated, sent: result.sent };
  },
);
