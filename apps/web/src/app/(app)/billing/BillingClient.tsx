"use client";
import { Card } from "@/components/ui/card";
import type { getCurrentBilling, listUsageSnapshots } from "@/lib/billing-queries";
import { fmtUsd, fmtBytes } from "@/lib/format";
import { PageHeader } from "@/components/cockpit/PageHeader";
import { MetricCard } from "@/components/cockpit/MetricCard";

type CurrentBilling = Awaited<ReturnType<typeof getCurrentBilling>>;
type SnapshotRow = Awaited<ReturnType<typeof listUsageSnapshots>>[number];

function UsageBar({ used, allowed, label }: { used: number; allowed: number; label: string }) {
  const pct = allowed > 0 ? Math.min(100, Math.round((used / allowed) * 100)) : 0;
  const over = used > allowed;
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-sm">
        <span style={{ color: "var(--text-muted)" }}>{label}</span>
        <span className="mono" style={{ color: over ? "var(--status-skip)" : "var(--text-body)" }}>
          {used.toLocaleString()} / {allowed.toLocaleString()}
          {over && <span className="ml-1 text-xs">(over)</span>}
        </span>
      </div>
      <div className="h-2 w-full rounded-full bg-muted">
        <div
          className="h-2 rounded-full transition-all"
          style={{ width: `${pct}%`, background: over ? "var(--status-skip)" : "var(--accent-gold)" }}
        />
      </div>
    </div>
  );
}

export function BillingClient({
  current,
  history,
}: {
  current: CurrentBilling;
  history: SnapshotRow[];
}) {
  const { usage, band, bill } = current;
  const storageOver = usage.storageBytes > band.allowances.storageBytes;

  return (
    <div className="space-y-6" data-testid="billing-page">
      <PageHeader eyebrow="Usage" title={`${band.name} Plan`} />

      {/* Period total MetricCard */}
      <MetricCard
        label="Estimated this month"
        value={<span className="text-accent-gold" data-testid="billing-total">{fmtUsd(bill.totalCents)}</span>}
        testId={undefined}
      />

      {/* Usage meters */}
      <Card className="p-4 space-y-4">
        <div className="eyebrow">Usage vs Allowances</div>
        <UsageBar
          label="Jobs processed"
          used={usage.jobsProcessed}
          allowed={band.allowances.jobsProcessed}
        />
        <UsageBar
          label="AI spend"
          used={usage.aiSpendCents}
          allowed={band.allowances.aiSpendCents}
        />
        <UsageBar
          label="AI voice minutes"
          used={usage.aiVoiceMinutes}
          allowed={band.allowances.aiVoiceMinutes}
        />
        <div className="space-y-1">
          <div className="flex justify-between text-sm">
            <span style={{ color: "var(--text-muted)" }}>Storage (active)</span>
            <span className="mono" style={{ color: storageOver ? "var(--status-skip)" : "var(--text-body)" }}>
              {fmtBytes(usage.storageBytes)} / {fmtBytes(band.allowances.storageBytes)}
              {storageOver && <span className="ml-1 text-xs">(over)</span>}
            </span>
          </div>
          <div className="h-2 w-full rounded-full bg-muted">
            <div
              className="h-2 rounded-full transition-all"
              style={{
                width: `${Math.min(100, Math.round((usage.storageBytes / (band.allowances.storageBytes || 1)) * 100))}%`,
                background: storageOver ? "var(--status-skip)" : "var(--accent-gold)",
              }}
            />
          </div>
        </div>
      </Card>

      {/* Bill breakdown */}
      <Card className="p-4 space-y-2">
        <div className="eyebrow">Bill Breakdown</div>
        <div className="flex justify-between text-sm">
          <span style={{ color: "var(--text-muted)" }}>Base ({band.name})</span>
          <span className="mono" style={{ color: "var(--text-body)" }}>{fmtUsd(bill.basePriceCents)}</span>
        </div>
        {bill.overages.jobs > 0 && (
          <div className="flex justify-between text-sm">
            <span style={{ color: "var(--text-muted)" }}>Job overage</span>
            <span className="mono" style={{ color: "var(--text-body)" }}>{fmtUsd(bill.overages.jobs)}</span>
          </div>
        )}
        {bill.overages.voice > 0 && (
          <div className="flex justify-between text-sm">
            <span style={{ color: "var(--text-muted)" }}>Voice overage</span>
            <span className="mono" style={{ color: "var(--text-body)" }}>{fmtUsd(bill.overages.voice)}</span>
          </div>
        )}
        {bill.overages.storage > 0 && (
          <div className="flex justify-between text-sm">
            <span style={{ color: "var(--text-muted)" }}>Storage overage</span>
            <span className="mono" style={{ color: "var(--text-body)" }}>{fmtUsd(bill.overages.storage)}</span>
          </div>
        )}
        {bill.overages.aiSpend > 0 && (
          <div className="flex justify-between text-sm">
            <span style={{ color: "var(--text-muted)" }}>AI spend overage</span>
            <span className="mono" style={{ color: "var(--text-body)" }}>{fmtUsd(bill.overages.aiSpend)}</span>
          </div>
        )}
        <div className="flex justify-between border-t pt-2 text-sm font-semibold">
          <span style={{ color: "var(--text-body)" }}>Estimated total</span>
          <span className="mono text-accent-gold">{fmtUsd(bill.totalCents)}</span>
        </div>
      </Card>

      {/* Snapshot history */}
      {history.length > 0 && (
        <div>
          <div className="mb-2 eyebrow">Billing History</div>
          <Card className="overflow-hidden">
            <div className="grid grid-cols-5 gap-2 px-4 py-2 eyebrow border-b">
              <span>Period</span>
              <span className="text-right">Plan</span>
              <span className="text-right">Base</span>
              <span className="text-right">Overage</span>
              <span className="text-right">Total</span>
            </div>
            {history.map((snap, i) => (
              <div
                key={snap.id}
                className="grid grid-cols-5 gap-2 px-4 py-2 text-sm border-b last:border-0"
                style={{ background: i % 2 ? "var(--surface-panel)" : "transparent" }}
              >
                <span className="mono font-medium" style={{ color: "var(--text-body)" }}>{snap.periodKey}</span>
                <span className="mono text-right capitalize" style={{ color: "var(--text-muted)" }}>{snap.bandKey}</span>
                <span className="mono text-right" style={{ color: "var(--text-body)" }}>{fmtUsd(snap.basePriceCents)}</span>
                <span className="mono text-right" style={{ color: "var(--text-body)" }}>{fmtUsd(snap.overageCents)}</span>
                <span className="mono text-right font-medium text-accent-gold">{fmtUsd(snap.totalCents)}</span>
              </div>
            ))}
          </Card>
        </div>
      )}
    </div>
  );
}
