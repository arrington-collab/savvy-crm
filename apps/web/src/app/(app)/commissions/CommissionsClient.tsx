"use client";
import { Card } from "@/components/ui/card";
import type { listCommissions } from "@/lib/commission-queries";
import { fmtUsd } from "@/lib/format";
import { StatusBadge } from "@/components/cockpit/StatusBadge";
import { PageHeader } from "@/components/cockpit/PageHeader";
import { PERSONAS, personaLine } from "@/lib/agents";

type CommissionRow = Awaited<ReturnType<typeof listCommissions>>[number];

export function CommissionsClient({ rows }: { rows: CommissionRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="space-y-4">
        <PageHeader eyebrow="Payouts" title="Commissions" />
        <p style={{ color: "var(--text-faint)" }}>{personaLine(PERSONAS.RAINE)}</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <PageHeader eyebrow="Payouts" title="Commissions" />

      {/* Header row */}
      <div className="grid grid-cols-8 gap-2 px-4 eyebrow">
        <span>Rep</span>
        <span>Invoice #</span>
        <span>Model</span>
        <span>Basis</span>
        <span>Rate</span>
        <span>Amount</span>
        <span>Period</span>
        <span>Status</span>
      </div>

      {rows.map((row, i) => (
        <Card
          key={row.id}
          className="p-4"
          data-testid="commission-row"
          style={{ background: i % 2 ? "var(--surface-panel)" : "transparent" }}
        >
          <div className="grid grid-cols-8 gap-2 items-center text-sm">
            <span className="font-medium truncate" style={{ color: "var(--text-body)" }}>{row.repName ?? "—"}</span>
            <span style={{ color: "var(--text-muted)" }}>{row.invoiceNumber ?? "—"}</span>
            <span className="capitalize" style={{ color: "var(--text-body)" }}>{row.model}</span>
            <span className="mono" style={{ color: "var(--text-body)" }}>{fmtUsd(row.basisCents)}</span>
            {/* rate is stored in basis points: 1000 bp = 10% */}
            <span className="mono" style={{ color: "var(--text-body)" }}>{(row.rate / 100).toFixed(1)}%</span>
            <span className="mono font-medium text-accent-gold">{fmtUsd(row.amountCents)}</span>
            <span className="mono" style={{ color: "var(--text-muted)" }}>{row.periodKey}</span>
            <StatusBadge status={row.status ?? "unknown"} />
          </div>
        </Card>
      ))}
    </div>
  );
}
