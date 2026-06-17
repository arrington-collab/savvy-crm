"use client";
import Link from "next/link";
import { Card } from "@/components/ui/card";
import { fmtUsd, formatDate } from "@/lib/format";
import { StatusBadge } from "@/components/cockpit/StatusBadge";
import { PageHeader } from "@/components/cockpit/PageHeader";
import { PERSONAS, personaLine } from "@/lib/agents";

type InvoiceRow = {
  id: string;
  number: string | null;
  status: string | null;
  amountDue: number | null;
  amountPaid: number;
  dueAt: string | null;
  customerName: string | null;
};

const newInvoiceLink = (
  <Link
    href="/invoices/new"
    className="inline-flex items-center justify-center rounded-md bg-primary text-primary-foreground hover:bg-primary/90 h-9 px-4 py-2 text-sm font-medium"
  >
    New Invoice
  </Link>
);

export function InvoicesClient({ invoices }: { invoices: InvoiceRow[] }) {
  if (invoices.length === 0) {
    return (
      <div className="space-y-4">
        <PageHeader eyebrow="Billing" title="Invoices" right={newInvoiceLink} />
        <p style={{ color: "var(--text-faint)" }}>{personaLine(PERSONAS.RAINE)}</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <PageHeader eyebrow="Billing" title="Invoices" right={newInvoiceLink} />

      <div className="space-y-2">
        {invoices.map((inv, i) => (
          <Link
            key={inv.id}
            href={`/invoices/${inv.id}`}
            className="block"
            data-testid="invoice-row"
            data-invoice-id={inv.id}
          >
            <Card
              className="p-4 hover:bg-muted/50 transition-colors cursor-pointer"
              style={{ background: i % 2 ? "var(--surface-panel)" : "transparent" }}
            >
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0 flex-1 space-y-0.5">
                  <div className="font-medium text-sm" style={{ color: "var(--text-body)" }}>
                    {inv.number ?? "Draft"}
                    {inv.customerName ? ` · ${inv.customerName}` : ""}
                  </div>
                  {inv.dueAt && (
                    <div className="text-xs" style={{ color: "var(--text-muted)" }}>
                      Due {formatDate(inv.dueAt)}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <div className="mono text-sm font-medium text-right text-accent-gold">
                    {inv.amountDue !== null ? fmtUsd(inv.amountDue) : "—"}
                  </div>
                  <StatusBadge status={inv.status ?? "unknown"} />
                </div>
              </div>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
