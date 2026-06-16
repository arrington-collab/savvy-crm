"use client";
import { Card } from "@/components/ui/card";
import type { getCurrentBilling, listUsageSnapshots } from "@/lib/billing-queries";

type CurrentBilling = Awaited<ReturnType<typeof getCurrentBilling>>;
type SnapshotRow = Awaited<ReturnType<typeof listUsageSnapshots>>[number];

function fmtUsd(cents: number): string {
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function UsageBar({ used, allowed, label }: { used: number; allowed: number; label: string }) {
  const pct = allowed > 0 ? Math.min(100, Math.round((used / allowed) * 100)) : 0;
  const over = used > allowed;
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-sm">
        <span className="text-muted-foreground">{label}</span>
        <span className={over ? "font-medium text-destructive" : "text-foreground"}>
          {used.toLocaleString()} / {allowed.toLocaleString()}
          {over && <span className="ml-1 text-xs">(over)</span>}
        </span>
      </div>
      <div className="h-2 w-full rounded-full bg-muted">
        <div
          className={`h-2 rounded-full transition-all ${over ? "bg-destructive" : "bg-primary"}`}
          style={{ width: `${pct}%` }}
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

  return (
    <div className="space-y-6" data-testid="billing-page">
      {/* Current period header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">{band.name} Plan</h2>
          <p className="text-sm text-muted-foreground">Current billing period usage</p>
        </div>
        <div className="text-right">
          <div className="text-2xl font-bold" data-testid="billing-total">{fmtUsd(bill.totalCents)}</div>
          <div className="text-xs text-muted-foreground">estimated this month</div>
        </div>
      </div>

      {/* Usage meters */}
      <Card className="p-4 space-y-4">
        <h3 className="text-sm font-medium">Usage vs Allowances</h3>
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
            <span className="text-muted-foreground">Storage (active)</span>
            <span>{fmtBytes(usage.storageBytes)} / {fmtBytes(band.allowances.storageBytes)}</span>
          </div>
          <div className="h-2 w-full rounded-full bg-muted">
            <div
              className={`h-2 rounded-full transition-all ${usage.storageBytes > band.allowances.storageBytes ? "bg-destructive" : "bg-primary"}`}
              style={{ width: `${Math.min(100, Math.round((usage.storageBytes / (band.allowances.storageBytes || 1)) * 100))}%` }}
            />
          </div>
        </div>
      </Card>

      {/* Bill breakdown */}
      <Card className="p-4 space-y-2">
        <h3 className="text-sm font-medium">Bill Breakdown</h3>
        <div className="flex justify-between text-sm">
          <span className="text-muted-foreground">Base ({band.name})</span>
          <span>{fmtUsd(bill.basePriceCents)}</span>
        </div>
        {bill.overages.jobs > 0 && (
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">Job overage</span>
            <span>{fmtUsd(bill.overages.jobs)}</span>
          </div>
        )}
        {bill.overages.voice > 0 && (
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">Voice overage</span>
            <span>{fmtUsd(bill.overages.voice)}</span>
          </div>
        )}
        {bill.overages.storage > 0 && (
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">Storage overage</span>
            <span>{fmtUsd(bill.overages.storage)}</span>
          </div>
        )}
        {bill.overages.aiSpend > 0 && (
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">AI spend overage</span>
            <span>{fmtUsd(bill.overages.aiSpend)}</span>
          </div>
        )}
        <div className="flex justify-between border-t pt-2 text-sm font-semibold">
          <span>Estimated total</span>
          <span>{fmtUsd(bill.totalCents)}</span>
        </div>
      </Card>

      {/* Snapshot history */}
      {history.length > 0 && (
        <div>
          <h3 className="mb-2 text-sm font-medium text-muted-foreground">Billing History</h3>
          <Card className="overflow-hidden">
            <div className="grid grid-cols-5 gap-2 px-4 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground border-b">
              <span>Period</span>
              <span className="text-right">Plan</span>
              <span className="text-right">Base</span>
              <span className="text-right">Overage</span>
              <span className="text-right">Total</span>
            </div>
            {history.map((snap) => (
              <div key={snap.id} className="grid grid-cols-5 gap-2 px-4 py-2 text-sm border-b last:border-0">
                <span className="font-medium">{snap.periodKey}</span>
                <span className="text-right capitalize">{snap.bandKey}</span>
                <span className="text-right">{fmtUsd(snap.basePriceCents)}</span>
                <span className="text-right">{fmtUsd(snap.overageCents)}</span>
                <span className="text-right font-medium">{fmtUsd(snap.totalCents)}</span>
              </div>
            ))}
          </Card>
        </div>
      )}
    </div>
  );
}
