import { withTenant, eq, invoice, payment, customer, tenant } from "@savvy/db";
import type { QboGateway } from "@savvy/integrations";
import { nangoQbo } from "@savvy/integrations";
import { inngest } from "../client";

/**
 * Ensure the customer + invoice exist in QBO. Returns the QBO invoice id on
 * success, or a skip reason when the tenant has no QBO connection, the invoice
 * is missing, or it has already been pushed (idempotent via stored qboId).
 *
 * Exported as a plain async function so tests can inject a fake gateway and a
 * real/fake DB without needing an Inngest harness.
 */
export async function ensureCustomerAndInvoice(
  tenantId: string,
  invoiceId: string,
  qbo: QboGateway = nangoQbo,
): Promise<{ qboInvoiceId: string } | { skipped: string }> {
  return withTenant(tenantId, async (tx) => {
    const [t] = await tx.select().from(tenant).where(eq(tenant.id, tenantId));
    const conn = t?.qboConnectionId;
    if (!conn) return { skipped: "not_connected" };

    const [inv] = await tx.select().from(invoice).where(eq(invoice.id, invoiceId));
    if (!inv) return { skipped: "no_invoice" };
    // Already pushed — return stored id without hitting QBO again (idempotent).
    if (inv.qboId) return { qboInvoiceId: inv.qboId };

    // Upsert customer first (required for invoice CustomerRef).
    let qboCustomerId: string | null = null;
    if (inv.customerId) {
      const [cust] = await tx.select().from(customer).where(eq(customer.id, inv.customerId));
      if (cust) {
        qboCustomerId = cust.qboId ?? null;
        if (!qboCustomerId) {
          const r = await qbo.upsertCustomer({
            connectionId: conn,
            customer: { id: cust.id, name: cust.name, email: cust.email ?? undefined },
          });
          qboCustomerId = r.qboId;
          await tx.update(customer).set({ qboId: qboCustomerId }).where(eq(customer.id, cust.id));
        }
      }
    }

    const r = await qbo.upsertInvoice({
      connectionId: conn,
      qboCustomerId: qboCustomerId ?? "",
      invoice: {
        number: inv.number ?? "",
        lineItems: inv.lineItems as unknown[],
        amountCents: inv.amountDue ?? 0,
        dueAt: inv.dueAt ? inv.dueAt.toISOString() : null,
      },
    });
    await tx.update(invoice).set({ qboId: r.qboId }).where(eq(invoice.id, inv.id));
    return { qboInvoiceId: r.qboId };
  });
}

/**
 * Push the latest unsynced payment for an invoice. Returns the QBO payment id,
 * or a skip reason when there is no connection, no unsynced payment, or the
 * payment has already been pushed.
 *
 * Exported for testing with an injected fake gateway.
 */
export async function pushPaymentToQbo(
  tenantId: string,
  invoiceId: string,
  qboInvoiceId: string,
  qbo: QboGateway = nangoQbo,
): Promise<{ qboPaymentId: string } | { skipped: string }> {
  return withTenant(tenantId, async (tx) => {
    const [t] = await tx.select().from(tenant).where(eq(tenant.id, tenantId));
    if (!t?.qboConnectionId) return { skipped: "not_connected" };

    const [pmt] = await tx
      .select()
      .from(payment)
      .where(eq(payment.invoiceId, invoiceId))
      // NOTE: syncs only the earliest unsynced payment. Partial-payment invoices (multiple
      // payments) need a loop here — tracked as a follow-up; Phase 5B assumes single payment.
      .orderBy(payment.receivedAt);
    if (!pmt || pmt.qboId) return { skipped: "no_unsynced_payment" };

    const r = await qbo.recordPayment({
      connectionId: t.qboConnectionId,
      qboInvoiceId,
      amountCents: pmt.amount,
      receivedAt: pmt.receivedAt.toISOString(),
    });
    await tx.update(payment).set({ qboId: r.qboId }).where(eq(payment.id, pmt.id));
    return { qboPaymentId: r.qboId };
  });
}

/**
 * On invoice/sent: push customer + invoice to QBO so the tenant's books stay
 * in sync. Idempotent — safe to retry. No retries override; Inngest default
 * (3 retries with exponential back-off) applies.
 */
export const qboPushInvoice = inngest.createFunction(
  { id: "qbo-push-invoice", concurrency: { limit: 10 } },
  { event: "invoice/sent" },
  async ({ event, step }) =>
    step.run("push", () =>
      ensureCustomerAndInvoice(event.data.tenantId, event.data.invoiceId),
    ),
);

/**
 * On invoice/paid: ensure invoice exists in QBO, then push the payment.
 * Two discrete step.run calls so Inngest can memo each independently on retry.
 */
export const qboPushPayment = inngest.createFunction(
  { id: "qbo-push-payment", concurrency: { limit: 10 } },
  { event: "invoice/paid" },
  async ({ event, step }) => {
    const { tenantId, invoiceId } = event.data;
    const ensured = await step.run("ensure-invoice", () =>
      ensureCustomerAndInvoice(tenantId, invoiceId),
    );
    if (!("qboInvoiceId" in ensured)) return { skipped: ensured.skipped };
    return step.run("push-payment", () =>
      pushPaymentToQbo(tenantId, invoiceId, ensured.qboInvoiceId),
    );
  },
);
