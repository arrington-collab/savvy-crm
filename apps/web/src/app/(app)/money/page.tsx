import Link from "next/link";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/cockpit/PageHeader";
import { getMoneyKpis, getVerificationProof } from "@/lib/money-queries";
import { summarizeVerification } from "@savvy/core";
import { ProofRows } from "@/components/money/ProofRows";

export const dynamic = "force-dynamic"; // always read live, tenant-scoped data

function usd(cents: number): string {
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}
function usdK(cents: number): string {
  const k = cents / 100000;
  return k >= 1 ? `$${k.toFixed(1)}k` : usd(cents);
}

const DRILLDOWNS = [
  { href: "/money/owners-room", label: "Owner's Room" },
  { href: "/invoices", label: "Invoices" },
  { href: "/commissions", label: "Commissions" },
  { href: "/billing", label: "Billing" },
  { href: "/settings/quickbooks", label: "QuickBooks" },
];

export default async function MoneyPage() {
  const [kpis, proof] = await Promise.all([getMoneyKpis(), getVerificationProof()]);
  const v = summarizeVerification(proof.map((p) => ({ checkKey: p.checkKey, status: p.status as "pass" | "fail" | "stale" | "skip" })));
  const { aging } = kpis;
  const maxBucket = Math.max(aging.current.cents, aging.d31_60.cents, aging.d61plus.cents, 1);
  const ladder = [
    { label: "0–30", b: aging.current, bad: false },
    { label: "31–60", b: aging.d31_60, bad: false },
    { label: "61+", b: aging.d61plus, bad: true },
  ];
  const commTotal = kpis.commissions.pendingCents + kpis.commissions.approvedCents + kpis.commissions.paidCents;

  return (
    <div className="space-y-6" data-testid="money-page">
      <PageHeader
        eyebrow="Money · Headless"
        title="Money"
        right={
          <div className="mono flex flex-wrap gap-3 text-[11px]">
            {DRILLDOWNS.map((d) => (
              <Link key={d.href} href={d.href} className="hover:text-accent-gold" style={{ color: "var(--text-muted)" }} data-testid={`drill-${d.label.toLowerCase()}`}>{d.label} ↗</Link>
            ))}
          </div>
        }
      />
      <p className="max-w-2xl text-sm" style={{ color: "var(--text-muted)" }}>
        Agents calculate; invariants and reconciliation prove it. You see summaries and evidence — detail only when a check fails. No CRUD here.
      </p>

      {/* KPI GRID */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="money-kpis">
        <Kpi label="Cash · wk" value={kpis.cashWkCents > 0 ? usdK(kpis.cashWkCents) : "—"} />
        <Kpi label="WIP value" value={kpis.wipCents > 0 ? usdK(kpis.wipCents) : "—"} sub={kpis.wipJobs > 0 ? `${kpis.wipJobs} job${kpis.wipJobs === 1 ? "" : "s"}` : undefined} />
        <Kpi label="GM · MTD" value={kpis.gmMtdPct != null ? `${kpis.gmMtdPct}%` : "est —"} tip="Month-to-date gross margin from supplier-invoice cost actuals" testId="kpi-gm-mtd" />
        <Kpi label="MRR" value={kpis.mrrCents != null ? usd(kpis.mrrCents) : "—"} tip="Monthly-equivalent recurring revenue from active maintenance memberships" testId="kpi-mrr" />
        <Kpi label="AR outstanding" value={aging.totalCents > 0 ? usdK(aging.totalCents) : "—"} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* AR AGING LADDER */}
        <Card className="p-4" data-testid="ar-ladder">
          <div className="eyebrow mb-4">AR aging</div>
          <div className="flex h-24 items-end gap-3">
            {ladder.map((l) => (
              <div key={l.label} className="flex flex-1 flex-col items-center justify-end">
                <span className="mono mb-1 text-[10px]" style={{ color: "var(--text-muted)" }}>{l.b.cents > 0 ? usdK(l.b.cents) : ""}</span>
                <div
                  className="w-full rounded-t"
                  style={{ height: `${Math.round((l.b.cents / maxBucket) * 100)}%`, minHeight: l.b.cents > 0 ? 4 : 0, background: l.bad ? "var(--status-error)" : "var(--accent-030)" }}
                  data-testid={`ar-bar-${l.label}`}
                />
                <span className="mono mt-1 text-[9px]" style={{ color: "var(--text-faint)" }}>{l.label}</span>
              </div>
            ))}
          </div>
          {aging.d61plus.cents > 0 ? (
            <p className="mt-3 text-[12px]" style={{ color: "var(--text-faint)" }}>
              61+ bucket = {aging.d61plus.count} invoice{aging.d61plus.count === 1 ? "" : "s"} → already an exception in Today.
            </p>
          ) : null}
        </Card>

        {/* COMMISSIONS ACCRUAL */}
        <Card className="p-4" data-testid="commissions-panel">
          <div className="eyebrow mb-3">Commissions accrued</div>
          <div className="mono text-2xl font-semibold text-accent-gold">{usd(commTotal)}</div>
          <div className="mt-3 grid grid-cols-3 gap-2">
            <Mini label="pending" value={usd(kpis.commissions.pendingCents)} />
            <Mini label="approved" value={usd(kpis.commissions.approvedCents)} />
            <Mini label="paid" value={usd(kpis.commissions.paidCents)} />
          </div>
        </Card>
      </div>

      {/* NIGHTLY PROOF-OF-CORRECTNESS */}
      <Card className="p-4" data-testid="proof-panel">
        <div className="flex items-baseline justify-between">
          <div className="eyebrow">Nightly proof-of-correctness</div>
          <span className="mono text-[11px]" style={{ color: v.allGreen ? "var(--status-ok)" : v.failed > 0 ? "var(--status-error)" : "var(--text-faint)" }} data-testid="proof-summary">
            {v.total === 0 ? "no sweep yet" : v.allGreen ? `all green · ${v.passed}/${v.total}` : `${v.failed} failing · ${v.stale} stale · ${v.passed}/${v.total} pass`}
          </span>
        </div>
        {proof.length === 0 ? (
          <p className="mt-3 text-sm" style={{ color: "var(--text-faint)" }}>
            Checks populate after the first nightly sweep runs the evidence invariants.
          </p>
        ) : (
          <ProofRows initial={proof} />
        )}
        <p className="mono mt-3 text-[11px]" style={{ color: "var(--text-faint)" }}>
          Checker ≠ doer — agents write the numbers, deterministic SQL + external reconciliation verify them. Failures become exceptions in Today.
        </p>
      </Card>
    </div>
  );
}

function Kpi({ label, value, sub, tip, testId }: { label: string; value: string; sub?: string; tip?: string; testId?: string }) {
  return (
    <Card className="p-3.5" title={tip}>
      <div className="eyebrow">{label}</div>
      <div className="mono mt-1 text-xl font-semibold" data-testid={testId} style={{ color: value.startsWith("est") || value === "—" ? "var(--text-faint)" : "var(--text-primary)" }}>{value}</div>
      {sub ? <div className="mono text-[10px]" style={{ color: "var(--text-faint)" }}>{sub}</div> : null}
    </Card>
  );
}

function Mini({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="eyebrow" style={{ fontSize: "0.5rem" }}>{label}</div>
      <div className="mono text-[13px]" style={{ color: "var(--text-body)" }}>{value}</div>
    </div>
  );
}
