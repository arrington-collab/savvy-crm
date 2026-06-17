import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { summarizeAgentCoverage, summarizeAutomationStats } from "@savvy/core";
import { loadAgentRunWindow, loadAgentActivity } from "@/lib/command-center-queries";

export const dynamic = "force-dynamic"; // always read live, tenant-scoped data

function fmtUsd(cents: number): string {
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
}
function ago(d: Date): string {
  const mins = Math.round((Date.now() - new Date(d).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}
const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  ok: "default", running: "secondary", skipped: "outline", error: "destructive",
};

export default async function CommandCenterPage() {
  const [runWindow, activity] = await Promise.all([loadAgentRunWindow(30), loadAgentActivity(30)]);
  const now = new Date();
  const stats = summarizeAutomationStats(runWindow, now);
  const coverage = summarizeAgentCoverage(runWindow, now);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Command Center</h1>
        <p className="text-sm text-muted-foreground">What your agents are doing — live from the activity log.</p>
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Card className="p-4"><div className="text-sm text-muted-foreground">Actions (24h)</div>
          <div className="text-3xl font-semibold">{stats.last24h}</div></Card>
        <Card className="p-4"><div className="text-sm text-muted-foreground">AI spend (30d)</div>
          <div className="text-3xl font-semibold">{fmtUsd(stats.spendCents)}</div></Card>
        <Card className="p-4"><div className="text-sm text-muted-foreground">Error rate</div>
          <div className="text-3xl font-semibold">{Math.round(stats.errorRate * 100)}%</div></Card>
        <Card className="p-4"><div className="text-sm text-muted-foreground">Active agents</div>
          <div className="text-3xl font-semibold">{stats.activeAgents}/5</div></Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="p-4 lg:col-span-2">
          <h2 className="font-semibold mb-3">Agent Activity</h2>
          {activity.length === 0 ? (
            <p className="text-sm text-muted-foreground">No agent activity yet — agents run automatically on events (a new lead, an approved change order, a late invoice).</p>
          ) : (
            <ul className="divide-y">
              {activity.map((r) => (
                <li key={r.id} className="flex items-center gap-3 py-2 text-sm">
                  <Badge variant="secondary" className="capitalize">{r.agent}</Badge>
                  <span className="font-medium">{r.taskKey ?? "action"}</span>
                  <span className="text-muted-foreground">{r.target ?? "—"}</span>
                  <span className="ml-auto flex items-center gap-2">
                    {r.modelUsed ? <span className="text-xs text-muted-foreground">{r.modelUsed}</span> : null}
                    <Badge variant={STATUS_VARIANT[r.status] ?? "outline"}>{r.status}</Badge>
                    <span className="text-xs text-muted-foreground w-16 text-right">{ago(r.startedAt)}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card className="p-4">
          <h2 className="font-semibold mb-3">Agent Coverage</h2>
          <ul className="space-y-2">
            {coverage.map((c) => (
              <li key={c.agent} className="flex items-center justify-between text-sm">
                <span className="flex items-center gap-2">
                  <span className={`h-2 w-2 rounded-full ${c.total === 0 ? "bg-muted-foreground/30" : c.error > 0 ? "bg-destructive" : "bg-green-500"}`} />
                  {c.label}{c.agent === "claims" ? <span className="text-xs text-muted-foreground">(deferred)</span> : null}
                </span>
                <span className="text-muted-foreground">
                  {c.total === 0 ? "—" : `${c.total} run${c.total === 1 ? "" : "s"} · ${c.lastRunAt ? ago(c.lastRunAt) : "—"}`}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}
