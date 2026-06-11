"use client";
import { Card } from "@/components/ui/card";
import type { listCommissions } from "@/lib/commission-queries";

type CommissionRow = Awaited<ReturnType<typeof listCommissions>>[number];

function fmtUsd(cents: number): string {
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
}

const STATUS_COLORS: Record<string, string> = {
  pending: "bg-yellow-100 text-yellow-800",
  approved: "bg-blue-100 text-blue-800",
  paid: "bg-green-100 text-green-800",
  voided: "bg-red-100 text-red-800",
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

export function CommissionsClient({ rows }: { rows: CommissionRow[] }) {
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">No commissions yet.</p>;
  }

  return (
    <div className="space-y-2">
      {/* Header row */}
      <div className="grid grid-cols-8 gap-2 px-4 text-xs font-medium text-muted-foreground uppercase tracking-wide">
        <span>Rep</span>
        <span>Invoice #</span>
        <span>Model</span>
        <span>Basis</span>
        <span>Rate</span>
        <span>Amount</span>
        <span>Period</span>
        <span>Status</span>
      </div>

      {rows.map((row) => (
        <Card key={row.id} className="p-4" data-testid="commission-row">
          <div className="grid grid-cols-8 gap-2 items-center text-sm">
            <span className="font-medium truncate">{row.repName ?? "—"}</span>
            <span className="text-muted-foreground">{row.invoiceNumber ?? "—"}</span>
            <span className="capitalize">{row.model}</span>
            <span>{fmtUsd(row.basisCents)}</span>
            {/* rate is stored in basis points: 1000 bp = 10% */}
            <span>{(row.rate / 100).toFixed(1)}%</span>
            <span className="font-medium">{fmtUsd(row.amountCents)}</span>
            <span className="text-muted-foreground">{row.periodKey}</span>
            <StatusBadge status={row.status} />
          </div>
        </Card>
      ))}
    </div>
  );
}
