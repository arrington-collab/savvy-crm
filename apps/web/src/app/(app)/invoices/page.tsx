import { listInvoices } from "@/lib/finance-queries";
import { InvoicesClient } from "./InvoicesClient";

export const dynamic = "force-dynamic";

export default async function InvoicesPage() {
  const rows = await listInvoices();

  const invoices = rows.map((r) => ({
    id: r.id,
    number: r.number,
    status: r.status,
    amountDue: r.amountDue,
    amountPaid: r.amountPaid,
    dueAt: r.dueAt ? r.dueAt.toISOString() : null,
    customerName: r.customerName,
  }));

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Invoices</h1>
      <InvoicesClient invoices={invoices} />
    </div>
  );
}
