import { Card } from "@/components/ui/card";
import { getPipelineCounts, getRecentAgentRuns, getVelocity, getRepPerformance } from "@/lib/dashboard-queries";
import { getOnboardingStatus } from "@/lib/onboarding-queries";
import { MetricCard } from "@/components/cockpit/MetricCard";
import { AgentAvatar } from "@/components/cockpit/AgentAvatar";
import { resolveAgent, agentLabel } from "@/lib/agents";
import { AGENT, isOnboardingComplete } from "@savvy/core";
import { OnboardingChecklist } from "@/components/onboarding/OnboardingChecklist";

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
function statusColor(status: string | undefined): string {
  if (status === "error") return "var(--status-error)";
  if (status === "skipped") return "var(--status-skip)";
  if (status === "ok") return "var(--status-ok)";
  return "var(--text-faint)";
}

const STAGE_DOT: Record<string, string> = {
  lead: "var(--agent-sage)", inspected: "var(--agent-scout)", estimate: "var(--agent-vera)",
  approved: "var(--agent-milo)", production: "var(--agent-milo)",
};

export default async function DashboardPage() {
  const [pipeline, runs, velocity, repPerf, onboarding] = await Promise.all([
    getPipelineCounts(),
    getRecentAgentRuns(),
    getVelocity(),
    getRepPerformance(),
    getOnboardingStatus(),
  ]);
  const showChecklist = !onboarding.state.dismissed && !isOnboardingComplete(onboarding.steps);
  const activeStages = ["lead", "inspected", "estimate", "approved", "production"] as const;

  // CREW HEALTH — latest run per service (runs are newest-first).
  const latestByAgent = new Map<string, (typeof runs)[number]>();
  for (const r of runs) if (!latestByAgent.has(r.agent)) latestByAgent.set(r.agent, r);
  const activeAgents = new Set(runs.map((r) => r.agent)).size;

  return (
    <div className="space-y-6">
      {showChecklist && <OnboardingChecklist steps={onboarding.steps} />}
      <div>
        <div className="eyebrow">Operations</div>
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <MetricCard label="Total jobs" value={pipeline.total} testId="metric-total" />
        <MetricCard label="In production" value={pipeline.byStage.production} />
        <MetricCard label="New leads" value={pipeline.byStage.lead} />
        <MetricCard label="Approved" value={pipeline.byStage.approved} />
      </div>

      <div>
        <h2 className="eyebrow mb-2">Pipeline</h2>
        <div className="flex gap-2" data-testid="pipeline">
          {activeStages.map((s) => (
            <Card key={s} className="flex-1 p-3">
              <div className="mono flex items-center gap-1.5 text-[11px] uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: STAGE_DOT[s] ?? "var(--text-faint)" }} />
                {s}
              </div>
              <div className="mt-1 text-xl font-semibold" data-testid={`stage-${s}`}>{pipeline.byStage[s]}</div>
            </Card>
          ))}
        </div>
      </div>

      <Card className="p-4" data-testid="velocity-card">
        <h2 className="eyebrow mb-3">Pipeline Velocity</h2>
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
        <h2 className="eyebrow mb-2">Rep &amp; Team Performance</h2>
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

      {/* CREW HEALTH */}
      <div data-testid="agent-strip">
        <div className="mb-2 flex items-baseline justify-between">
          <h2 className="eyebrow">Crew Health</h2>
          <span className="mono text-[11px]" style={{ color: "var(--text-muted)" }}>{activeAgents}/5 active</span>
        </div>
        <Card className="p-0">
          <ul>
            {AGENT.map((agent, i) => {
              const latest = latestByAgent.get(agent);
              const resolved = resolveAgent({ agent, taskKey: latest?.taskKey ?? null });
              const deferred = agent === "claims";
              return (
                <li key={agent} className="flex items-center gap-3 px-4 py-2.5 text-sm" style={{ background: i % 2 ? "var(--surface-panel)" : "transparent" }}>
                  <AgentAvatar persona={resolved.persona} size="sm" dimmed={deferred} />
                  <span style={{ color: deferred ? "var(--text-faint)" : "var(--text-body)" }}>{agentLabel(resolved)}</span>
                  {deferred ? <span className="eyebrow" style={{ fontSize: "0.55rem" }}>deferred</span> : null}
                  <span className="ml-auto flex items-center gap-3">
                    {latest?.modelUsed ? <span className="mono text-[11px]" style={{ color: "var(--text-faint)" }}>{latest.modelUsed}</span> : null}
                    <span className="mono text-[11px]" style={{ color: "var(--text-faint)" }}>{latest ? ago(latest.startedAt) : "idle"}</span>
                    <span className="h-2 w-2 rounded-full" style={{ background: statusColor(latest?.status), boxShadow: latest && !deferred ? `0 0 8px ${statusColor(latest.status)}` : "none" }} />
                  </span>
                </li>
              );
            })}
          </ul>
        </Card>
      </div>
    </div>
  );
}
