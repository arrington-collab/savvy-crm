import { listSupplierInvoicesForJob } from "@savvy/db";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { fmtUsd } from "@/lib/format";
import { getTenantId } from "@/lib/tenant";
import type { SupplierInvoiceLine } from "@savvy/core";

function statusVariant(status: string): "default" | "secondary" | "destructive" | "outline" {
  if (status === "guarded") return "default";
  if (status === "parsed") return "secondary";
  if (status === "parse_failed") return "destructive";
  return "outline";
}

function OverageBadge({ cents }: { cents: number | null | undefined }) {
  if (!cents || cents <= 0) return null;
  return (
    <span className="mono text-[11px] font-semibold" style={{ color: "var(--status-error)" }}>
      +{fmtUsd(cents)} over
    </span>
  );
}

function LineTable({ lines }: { lines: SupplierInvoiceLine[] }) {
  if (lines.length === 0) return <p className="text-xs" style={{ color: "var(--text-faint)" }}>No line items parsed.</p>;
  return (
    <table className="w-full text-xs" style={{ color: "var(--text-muted)" }}>
      <thead>
        <tr className="border-b border-border">
          <th className="pb-1 text-left font-medium">Description</th>
          <th className="pb-1 text-right font-medium">Billed</th>
          <th className="pb-1 text-right font-medium">Expected</th>
          <th className="pb-1 text-right font-medium">Overage</th>
        </tr>
      </thead>
      <tbody>
        {lines.map((l, i) => (
          <tr key={i} className="border-b border-border/50 last:border-0">
            <td className="py-1 pr-2">
              <span>{l.description}</span>
              {l.matchedItemKey && (
                <span className="block text-[10px]" style={{ color: "var(--text-faint)" }}>{l.matchedItemKey}</span>
              )}
              {!l.matchedItemKey && (
                <span className="block text-[10px]" style={{ color: "var(--text-faint)" }}>key: —</span>
              )}
            </td>
            <td className="py-1 text-right">{fmtUsd(l.amountBilledCents)}</td>
            <td className="py-1 text-right">
              {l.expectedUnitCostCents != null
                ? fmtUsd(l.expectedUnitCostCents * l.quantity)
                : <span style={{ color: "var(--text-faint)" }}>—</span>}
            </td>
            <td className="py-1 text-right">
              {l.overageCents != null && l.overageCents > 0
                ? <span style={{ color: "var(--status-error)" }}>+{fmtUsd(l.overageCents)}</span>
                : <span style={{ color: "var(--text-faint)" }}>—</span>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export async function SupplierInvoicesPanel({ jobId }: { jobId: string }) {
  const tenantId = await getTenantId();
  const invoices = await listSupplierInvoicesForJob(tenantId, jobId);

  if (invoices.length === 0) return null;

  return (
    <Card data-testid="supplier-invoices-panel">
      <CardHeader>
        <CardTitle>Supplier invoices</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        {invoices.map((inv) => (
          <div key={inv.id} className="space-y-3">
            <div className="flex flex-wrap items-center gap-3">
              <span className="font-medium">{inv.supplierName ?? "Unknown supplier"}</span>
              {inv.invoiceNumber && (
                <span className="mono text-xs" style={{ color: "var(--text-faint)" }}>#{inv.invoiceNumber}</span>
              )}
              <Badge variant={statusVariant(inv.status)} className="capitalize text-[10px]">
                {inv.status.replace("_", " ")}
              </Badge>
              {inv.totalCents != null && (
                <span className="mono ml-auto font-semibold text-accent-gold">{fmtUsd(inv.totalCents)}</span>
              )}
              {/* Overage summary: sum of positive overageCents across lines */}
              {(() => {
                const totalOverage = inv.lines.reduce((sum, l) => sum + (l.overageCents ?? 0), 0);
                return <OverageBadge cents={totalOverage} />;
              })()}
            </div>
            <LineTable lines={inv.lines} />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
