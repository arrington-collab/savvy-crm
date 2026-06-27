import { Card } from "@/components/ui/card";
import { getPipelineSummary } from "@/lib/pipeline-queries";

function usd(cents: number): string {
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

function TrendBadge({ pct }: { pct: number | null }) {
  if (pct == null) return <span className="mono text-xs" style={{ color: "var(--text-faint)" }}>—</span>;
  const up = pct >= 0;
  return (
    <span className="mono text-xs" style={{ color: up ? "var(--status-ok)" : "var(--status-error)" }}>
      {up ? "▲" : "▼"} {Math.abs(pct)}%
    </span>
  );
}

export async function PipelineSummaryPanel() {
  const s = await getPipelineSummary();
  return (
    <div data-testid="pipeline-summary">
      <div className="eyebrow">Pipeline</div>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Card className="p-4">
          <div className="text-xs" style={{ color: "var(--text-muted)" }}>Gross pipeline</div>
          <div data-testid="pipeline-gross" className="mono text-xl font-semibold">{usd(s.totals.grossCents)}</div>
          <TrendBadge pct={s.totals.wowPct} />
        </Card>
        <Card className="p-4">
          <div className="text-xs" style={{ color: "var(--text-muted)" }}>Expected (weighted)</div>
          <div data-testid="pipeline-expected" className="mono text-xl font-semibold" style={{ color: "var(--accent-gold)" }}>{usd(s.totals.expectedCents)}</div>
        </Card>
        <Card className="p-4">
          <div className="text-xs" style={{ color: "var(--text-muted)" }}>At-risk</div>
          <div className="mono text-xl font-semibold" style={{ color: s.totals.atRiskCents > 0 ? "var(--status-error)" : undefined }}>{usd(s.totals.atRiskCents)}</div>
        </Card>
        <Card className="p-4">
          <div className="text-xs" style={{ color: "var(--text-muted)" }}>Avg cycle</div>
          <div className="mono text-xl font-semibold">{s.totals.avgCycleDays}d</div>
        </Card>
      </div>
      <Card className="mt-4 p-4">
        <div className="space-y-2">
          {s.stages.filter((st) => st.grossCents > 0).map((st) => (
            <div key={st.stage} className="flex items-center gap-3">
              <div className="mono w-24 text-xs uppercase tracking-wider" style={{ color: "var(--text-body)" }}>{st.stage}</div>
              <div className="relative h-3 flex-1 overflow-hidden rounded" style={{ background: "var(--surface-panel)" }}>
                <div
                  className="absolute inset-y-0 left-0 rounded"
                  style={{
                    width: `${st.grossCents > 0 ? Math.round((st.expectedCents / st.grossCents) * 100) : 0}%`,
                    background: "var(--accent-gold)",
                  }}
                />
              </div>
              <div className="mono w-44 text-right text-xs" style={{ color: "var(--text-faint)" }}>
                {usd(st.grossCents)} → {usd(st.expectedCents)} · {st.probability}%
              </div>
              <TrendBadge pct={st.wowPct} />
            </div>
          ))}
        </div>
        <p className="mt-2 text-xs" style={{ color: "var(--text-faint)" }}>
          Week-over-week is reconstructed from stage history at current values — directional, not exact.
        </p>
      </Card>
    </div>
  );
}
