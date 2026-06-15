"use client";
import Link from "next/link";
import { Card } from "@/components/ui/card";

type InvoiceRow = {
  id: string;
  number: string | null;
  status: string | null;
  amountDue: number | null;
  amountPaid: number;
  dueAt: string | null;
  customerName: string | null;
};

function fmtUsd(cents: number): string {
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
}

const STATUS_COLORS: Record<string, string> = {
  draft: "bg-gray-100 text-gray-700",
  sent: "bg-blue-100 text-blue-800",
  paid: "bg-green-100 text-green-800",
  void: "bg-red-100 text-red-800",
  partial: "bg-yellow-100 text-yellow-800",
};

function StatusBadge({ status }: { status: string | null }) {
  const label = status ?? "unknown";
  const cls = STATUS_COLORS[label] ?? "bg-muted text-muted-foreground";
  return (
    <span className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-medium ${cls}`}>
      {label}
    </span>
  );
}

export function InvoicesClient({ invoices }: { invoices: InvoiceRow[] }) {
  if (invoices.length === 0) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">No invoices yet.</p>
        <Link
          href="/invoices/new"
          className="inline-flex items-center justify-center rounded-md bg-primary text-primary-foreground hover:bg-primary/90 h-9 px-4 py-2 text-sm font-medium"
        >
          New Invoice
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Link
          href="/invoices/new"
          className="inline-flex items-center justify-center rounded-md bg-primary text-primary-foreground hover:bg-primary/90 h-9 px-4 py-2 text-sm font-medium"
        >
          New Invoice
        </Link>
      </div>

      <div className="space-y-2">
        {invoices.map((inv) => (
          <Link
            key={inv.id}
            href={`/invoices/${inv.id}`}
            className="block"
            data-testid="invoice-row"
            data-invoice-id={inv.id}
          >
            <Card className="p-4 hover:bg-muted/50 transition-colors cursor-pointer">
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0 flex-1 space-y-0.5">
                  <div className="font-medium text-sm">
                    {inv.number ?? "Draft"}
                    {inv.customerName ? ` · ${inv.customerName}` : ""}
                  </div>
                  {inv.dueAt && (
                    <div className="text-xs text-muted-foreground">
                      Due {new Date(inv.dueAt).toLocaleDateString()}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <div className="text-sm font-medium text-right">
                    {inv.amountDue !== null ? fmtUsd(inv.amountDue) : "—"}
                  </div>
                  <StatusBadge status={inv.status} />
                </div>
              </div>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
