import { getInvoice } from "@/lib/finance-queries";
import { InvoiceDetail } from "./InvoiceDetail";

export const dynamic = "force-dynamic";

export default async function InvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const data = await getInvoice(id);

  if (!data) {
    return (
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold">Invoice not found</h1>
        <p className="text-sm text-muted-foreground">
          No invoice with that ID exists in your account.
        </p>
      </div>
    );
  }

  const { invoice: inv, payments } = data;

  return (
    <InvoiceDetail
      invoice={{
        id: inv.id,
        number: inv.number,
        status: inv.status,
        amountDue: inv.amountDue,
        amountPaid: inv.amountPaid,
        dueAt: inv.dueAt ? inv.dueAt.toISOString() : null,
        lineItems: inv.lineItems as unknown[],
      }}
      payments={payments.map((p) => ({
        id: p.id,
        method: p.method,
        amount: p.amount,
        receivedAt: p.receivedAt ? p.receivedAt.toISOString() : null,
        stripePaymentId: p.stripePaymentId,
      }))}
    />
  );
}
