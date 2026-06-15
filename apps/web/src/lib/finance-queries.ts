import "server-only";
import { withTenant, invoice, customer, payment, eq, and, desc } from "@savvy/db";
import type { InvoiceStatus } from "@savvy/core";
import { getTenantId } from "./tenant";

export async function listInvoices(filter?: { status?: InvoiceStatus }) {
  const tenantId = await getTenantId();
  return withTenant(tenantId, (tx) =>
    tx.select({
      id: invoice.id,
      number: invoice.number,
      status: invoice.status,
      amountDue: invoice.amountDue,
      amountPaid: invoice.amountPaid,
      dueAt: invoice.dueAt,
      customerName: customer.name,
    })
      .from(invoice)
      .leftJoin(customer, eq(invoice.customerId, customer.id))
      .where(
        and(
          eq(invoice.tenantId, tenantId),
          ...(filter?.status ? [eq(invoice.status, filter.status)] : []),
        ),
      )
      .orderBy(desc(invoice.createdAt)),
  );
}

export async function getInvoice(id: string) {
  const tenantId = await getTenantId();
  return withTenant(tenantId, async (tx) => {
    const [inv] = await tx.select().from(invoice).where(eq(invoice.id, id));
    const pays = await tx.select().from(payment).where(eq(payment.invoiceId, id));
    return inv ? { invoice: inv, payments: pays } : null;
  });
}
