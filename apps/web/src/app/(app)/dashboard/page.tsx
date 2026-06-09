import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { getPipelineCounts, getRecentAgentRuns } from "@/lib/dashboard-queries";

export const dynamic = "force-dynamic"; // always read live, tenant-scoped data

export default async function DashboardPage() {
  const [pipeline, runs] = await Promise.all([getPipelineCounts(), getRecentAgentRuns()]);
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
