import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { getPipelineCounts, getRecentAgentRuns, getVelocity, getRepPerformance } from "@/lib/dashboard-queries";

export const dynamic = "force-dynamic"; // always read live, tenant-scoped data

function fmtUsd(cents: number): string {
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
}

export default async function DashboardPage() {
  const [pipeline, runs, velocity, repPerf] = await Promise.all([
    getPipelineCounts(),
    getRecentAgentRuns(),
    getVelocity(),
    getRepPerformance(),
  ]);
  const activeStages = ["lead", "inspected", "estimate", "approved", "production"] as const;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Dashboard</h1>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Card className="p-4">
          <div className="text-sm text-muted-foreground">Total jobs</div>
          <div className="text-3xl font-semibold" data-testid="metric-total">{pipeline.total}</div>
        </Card>
        <Card className="p-4">
          <div className="text-sm text-muted-foreground">In production</div>
          <div className="text-3xl font-semibold">{pipeline.byStage.production}</div>
        </Card>
        <Card className="p-4">
          <div className="text-sm text-muted-foreground">New leads</div>
          <div className="text-3xl font-semibold">{pipeline.byStage.lead}</div>
        </Card>
        <Card className="p-4">
          <div className="text-sm text-muted-foreground">Approved</div>
          <div className="text-3xl font-semibold">{pipeline.byStage.approved}</div>
        </Card>
      </div>

      <div>
        <h2 className="mb-2 text-sm font-medium text-muted-foreground">Pipeline</h2>
        <div className="flex gap-2" data-testid="pipeline">
          {activeStages.map((s) => (
            <Card key={s} className="flex-1 p-3 text-center">
              <div className="text-xs capitalize text-muted-foreground">{s}</div>
              <div className="text-xl font-semibold" data-testid={`stage-${s}`}>{pipeline.byStage[s]}</div>
            </Card>
          ))}
        </div>
      </div>

      {/* Velocity card */}
      <Card className="p-4" data-testid="velocity-card">
        <h2 className="mb-3 text-sm font-medium text-muted-foreground">Pipeline Velocity</h2>
        <div className="mb-2 flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Avg cycle time</span>
          <span className="font-semibold">{velocity.cycleTimeDays.toFixed(1)} days</span>
        </div>
        {Object.keys(velocity.perStageAvgDays).length === 0 ? (
          <p className="text-sm text-muted-foreground">No stage event data yet.</p>
        ) : (
          <div className="space-y-1">
            {Object.entries(velocity.perStageAvgDays).map(([stage, days]) => (
              <div key={stage} className="flex items-center justify-between text-sm">
                <span className="capitalize text-muted-foreground">{stage}</span>
                <span className="font-medium">{(days as number).toFixed(1)} d</span>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Rep / Team performance table */}
      <div data-testid="rep-performance">
        <h2 className="mb-2 text-sm font-medium text-muted-foreground">Rep & Team Performance</h2>
        {repPerf.reps.length === 0 ? (
          <p className="text-sm text-muted-foreground">No assigned jobs yet.</p>
        ) : (
          <Card className="overflow-hidden">
            <div className="grid grid-cols-5 gap-2 px-4 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground border-b">
              <span>Rep</span>
              <span className="text-right">Assigned</span>
              <span className="text-right">Won</span>
              <span className="text-right">Value</span>
              <span className="text-right">Avg days</span>
            </div>
            {repPerf.reps.map((r) => (
              <div key={r.userId} className="grid grid-cols-5 gap-2 px-4 py-2 text-sm border-b last:border-0">
                <span className="font-medium truncate">{r.name}</span>
                <span className="text-right">{r.jobsAssigned}</span>
                <span className="text-right">{r.approved}</span>
                <span className="text-right">{fmtUsd(r.totalValueCents)}</span>
                <span className="text-right">{r.avgDaysToClose.toFixed(1)}</span>
              </div>
            ))}
            {/* Team totals */}
            <div className="grid grid-cols-5 gap-2 px-4 py-2 text-sm font-semibold border-t bg-muted/30">
              <span>Team</span>
              <span className="text-right">{repPerf.team.jobsAssigned}</span>
              <span className="text-right">{repPerf.team.approved}</span>
              <span className="text-right">{fmtUsd(repPerf.team.totalValueCents)}</span>
              <span className="text-right">—</span>
            </div>
          </Card>
        )}
      </div>

      <div>
        <h2 className="mb-2 text-sm font-medium text-muted-foreground">Agents</h2>
        <div className="flex flex-wrap gap-2" data-testid="agent-strip">
          {runs.length === 0 ? (
            <span className="text-sm text-muted-foreground">No recent runs</span>
          ) : (
            runs.map((r) => (
              <Badge key={r.id} variant={r.status === "ok" ? "default" : "destructive"}>
                {r.agent}: {r.status}{r.modelUsed ? ` (${r.modelUsed})` : ""}
              </Badge>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
