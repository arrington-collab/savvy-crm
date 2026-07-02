import { withTenant } from "../tenant";
import { invoice, payment, estimate } from "../schema/finance";
import { job } from "../schema/jobs";
import { tenant } from "../schema/tenancy";
import { and, eq, sql } from "drizzle-orm";
import { computeInvoiceTotal, formatInvoiceNumber, parseFinanceConfig, REGISTRY_TASK, type LineItem } from "@savvy/core";
import type { PaymentMethod } from "@savvy/core";
import { markJobTaskDoneTx } from "./job-tasks";

export class StripeNotConnectedError extends Error {
  constructor() { super("stripe_not_connected"); this.name = "StripeNotConnectedError"; }
}

type InvoiceRow = typeof invoice.$inferSelect;

export async function createInvoice(input: {
  tenantId: string; jobId: string; lineItems: LineItem[];
}): Promise<InvoiceRow> {
  return withTenant(input.tenantId, async (tx) => {
    const [j] = await tx.select().from(job).where(eq(job.id, input.jobId));
    const amountDue = computeInvoiceTotal(input.lineItems);
    const [row] = await tx.insert(invoice).values({
      tenantId: input.tenantId, jobId: input.jobId, customerId: j?.customerId ?? null,
      lineItems: input.lineItems, amountDue, status: "draft",
    }).returning();
    await markJobTaskDoneTx(tx, input.tenantId, { jobId: input.jobId, taskId: REGISTRY_TASK.INVOICE_GENERATION, owner: "finance", evidence: { type: "invoice", ref: row!.id } });
    return row!;
  });
}

export async function createInvoiceFromEstimate(input: {
  tenantId: string; estimateId: string;
}): Promise<InvoiceRow> {
  return withTenant(input.tenantId, async (tx) => {
    const [e] = await tx.select().from(estimate).where(eq(estimate.id, input.estimateId));
    if (!e) throw new Error("estimate not found");
    const [j] = await tx.select().from(job).where(eq(job.id, e.jobId));
    const [row] = await tx.insert(invoice).values({
      tenantId: input.tenantId, jobId: e.jobId, customerId: j?.customerId ?? null,
      lineItems: e.lineItems as unknown[], amountDue: e.total ?? 0, status: "draft",
    }).returning();
    await tx.update(estimate).set({ status: "accepted" }).where(eq(estimate.id, input.estimateId));
    await markJobTaskDoneTx(tx, input.tenantId, { jobId: e.jobId, taskId: REGISTRY_TASK.INVOICE_GENERATION, owner: "finance", evidence: { type: "invoice", ref: row!.id } });
    return row!;
  });
}

export async function sendInvoice(input: { tenantId: string; invoiceId: string }): Promise<InvoiceRow> {
  return withTenant(input.tenantId, async (tx) => {
    const [t] = await tx.select().from(tenant).where(eq(tenant.id, input.tenantId));
    if (!t?.stripeAccountId) throw new StripeNotConnectedError();
    const cfg = parseFinanceConfig((t.settings as { finance?: unknown })?.finance);
    // Serialize per-tenant number assignment so concurrent sends can't collide.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${input.tenantId}))`);
    const cntRows = await tx.select({ cnt: sql<number>`count(*)::int` }).from(invoice)
      .where(and(eq(invoice.tenantId, input.tenantId), sql`number is not null`));
    const cnt = cntRows[0]?.cnt ?? 0;
    const number = formatInvoiceNumber(cfg.invoiceNumberPrefix, cnt + 1);
    const dueAt = new Date(Date.now() + cfg.netDays * 86400_000);
    const [row] = await tx.update(invoice)
      .set({ number, dueAt, status: "sent" })
      .where(and(eq(invoice.id, input.invoiceId), eq(invoice.status, "draft")))
      .returning();
    if (row) {
      await markJobTaskDoneTx(tx, input.tenantId, { jobId: row.jobId, taskId: REGISTRY_TASK.INVOICE_DELIVERY, owner: "finance", evidence: { type: "invoice", ref: row.id } });
    }
    return row!;
  });
}

export async function voidInvoice(input: { tenantId: string; invoiceId: string }): Promise<void> {
  await withTenant(input.tenantId, (tx) => tx.update(invoice).set({ status: "void" }).where(eq(invoice.id, input.invoiceId)));
}

export async function recordStripePayment(input: {
  tenantId: string; invoiceId: string; stripePaymentId: string;
  method: PaymentMethod; amountCents: number;
}): Promise<{ alreadyRecorded: boolean; nowPaid: boolean }> {
  return withTenant(input.tenantId, async (tx) => {
    const dup = await tx.select({ id: payment.id }).from(payment)
      .where(and(eq(payment.tenantId, input.tenantId), eq(payment.stripePaymentId, input.stripePaymentId)));
    if (dup.length > 0) return { alreadyRecorded: true, nowPaid: false };

    await tx.insert(payment).values({
      tenantId: input.tenantId, invoiceId: input.invoiceId, method: input.method,
      amount: input.amountCents, stripePaymentId: input.stripePaymentId,
    });
    const [inv] = await tx.select().from(invoice).where(eq(invoice.id, input.invoiceId));
    const amountPaid = (inv?.amountPaid ?? 0) + input.amountCents;
    const nowPaid = amountPaid >= (inv?.amountDue ?? 0);
    await tx.update(invoice).set({
      amountPaid, ...(nowPaid ? { status: "paid" as const, stripePaymentIntentId: input.stripePaymentId } : {}),
    }).where(eq(invoice.id, input.invoiceId));
    return { alreadyRecorded: false, nowPaid };
  });
}
