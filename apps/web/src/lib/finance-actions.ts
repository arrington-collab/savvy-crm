"use server";
import { revalidatePath } from "next/cache";
import {
  withTenant, invoice, tenant, eq,
  createInvoice, createInvoiceFromEstimate, sendInvoice, voidInvoice, StripeNotConnectedError,
} from "@savvy/db";
import { stripeGateway } from "@savvy/integrations";
import type { LineItem } from "@savvy/core";
import { inngest } from "@savvy/agents";
import { getTenantId } from "./tenant";

export async function createInvoiceAction(jobId: string, lineItems: LineItem[]) {
  const tenantId = await getTenantId();
  const inv = await createInvoice({ tenantId, jobId, lineItems });
  revalidatePath("/invoices");
  return { ok: true as const, id: inv.id };
}

export async function createFromEstimateAction(estimateId: string) {
  const tenantId = await getTenantId();
  const inv = await createInvoiceFromEstimate({ tenantId, estimateId });
  revalidatePath("/invoices");
  return { ok: true as const, id: inv.id };
}

export async function sendInvoiceAction(invoiceId: string) {
  const tenantId = await getTenantId();
  try {
    await sendInvoice({ tenantId, invoiceId });
  } catch (e) {
    if (e instanceof StripeNotConnectedError) return { error: "stripe_not_connected" as const };
    throw e;
  }
  try { await inngest.send({ name: "invoice/sent", data: { invoiceId, tenantId } }); } catch (e) { console.error(e); }
  revalidatePath("/invoices");
  return { ok: true as const };
}

export async function voidInvoiceAction(invoiceId: string) {
  const tenantId = await getTenantId();
  await voidInvoice({ tenantId, invoiceId });
  revalidatePath("/invoices");
  return { ok: true as const };
}

export async function createCheckoutForInvoice(invoiceId: string) {
  const tenantId = await getTenantId();
  const base = process.env.APP_BASE_URL ?? "http://localhost:3000";
  const ctx = await withTenant(tenantId, async (tx) => {
    const [inv] = await tx.select().from(invoice).where(eq(invoice.id, invoiceId));
    const [t] = await tx.select().from(tenant).where(eq(tenant.id, tenantId));
    return { inv, accountId: t?.stripeAccountId ?? null };
  });
  if (!ctx.inv) return { error: "not_found" as const };
  if (ctx.inv.status === "paid" || ctx.inv.status === "void") return { error: "not_payable" as const };
  if (!ctx.accountId) return { error: "stripe_not_connected" as const };

  const session = await stripeGateway.createCheckoutSession({
    connectedAccountId: ctx.accountId,
    amountCents: ctx.inv.amountDue ?? 0,
    invoiceId,
    tenantId,
    description: ctx.inv.number ?? "Invoice",
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
  return { ok: true as const, url: session.url };
}
