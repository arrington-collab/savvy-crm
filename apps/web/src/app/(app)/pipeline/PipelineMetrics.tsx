import { Card } from "@/components/ui/card";
import { fmtUsd } from "@/lib/format";

type Velocity = { cycleTimeDays: number; perStageAvgDays: Record<string, number> };
type RepPerformance = {
  reps: { userId: string; name: string; jobsAssigned: number; approved: number; totalValueCents: number; avgDaysToClose: number }[];
  team: { jobsAssigned: number; approved: number; totalValueCents: number };
};

/**
 * Pipeline throughput metrics — cycle-time velocity + per-rep performance.
 * Re-homed here from the retired Dashboard: these are pipeline-flow numbers, so
 * they live on Pipeline. testids (velocity-card, rep-performance) are preserved.
 */
export function PipelineMetrics({ velocity, repPerf }: { velocity: Velocity; repPerf: RepPerformance }) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card className="p-4" data-testid="velocity-card">
        <h2 className="eyebrow mb-3">Pipeline velocity</h2>
        <div className="mb-2 flex items-baseline gap-2">
          <span className="text-xs" style={{ color: "var(--text-muted)" }}>Avg cycle time</span>
          <span className="mono text-lg font-semibold text-accent-gold">{velocity.cycleTimeDays.toFixed(1)}d</span>
        </div>
        {Object.keys(velocity.perStageAvgDays).length === 0 ? (
          <p className="text-sm" style={{ color: "var(--text-faint)" }}>No stage event data yet.</p>
        ) : (
          <div className="space-y-1">
            {Object.entries(velocity.perStageAvgDays).map(([stage, days]) => (
              <div key={stage} className="flex items-center justify-between text-sm">
                <span className="capitalize" style={{ color: "var(--text-muted)" }}>{stage}</span>
                <span className="mono" style={{ color: "var(--text-body)" }}>{(days as number).toFixed(1)} d</span>
              </div>
            ))}
          </div>
        )}
      </Card>

      <div data-testid="rep-performance">
        <h2 className="eyebrow mb-2">Rep &amp; team performance</h2>
        {repPerf.reps.length === 0 ? (
          <p className="text-sm" style={{ color: "var(--text-faint)" }}>No assigned jobs yet.</p>
        ) : (
          <Card className="overflow-hidden p-0">
            <div className="mono grid grid-cols-5 gap-2 px-4 py-2 text-[11px] uppercase tracking-wider" style={{ color: "var(--text-muted)", borderBottom: "1px solid var(--border-panel)" }}>
              <span>Rep</span><span className="text-right">Assigned</span><span className="text-right">Won</span><span className="text-right">Value</span><span className="text-right">Avg days</span>
            </div>
            {repPerf.reps.map((r, i) => (
              <div key={r.userId} className="grid grid-cols-5 gap-2 px-4 py-2 text-sm" style={{ background: i % 2 ? "var(--surface-panel)" : "transparent" }}>
                <span className="truncate" style={{ color: "var(--text-body)" }}>{r.name}</span>
                <span className="mono text-right">{r.jobsAssigned}</span>
                <span className="mono text-right">{r.approved}</span>
                <span className="mono text-right text-accent-gold">{fmtUsd(r.totalValueCents)}</span>
                <span className="mono text-right">{r.avgDaysToClose.toFixed(1)}</span>
              </div>
            ))}
            <div className="mono grid grid-cols-5 gap-2 px-4 py-2 text-sm font-semibold" style={{ borderTop: "1px solid var(--accent-030)", background: "var(--accent-006)" }}>
              <span>Team</span>
              <span className="text-right">{repPerf.team.jobsAssigned}</span>
              <span className="text-right">{repPerf.team.approved}</span>
              <span className="text-right text-accent-gold">{fmtUsd(repPerf.team.totalValueCents)}</span>
              <span className="text-right">—</span>
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}
