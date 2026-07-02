import { Card } from "@/components/ui/card";
import { summarizeAgentCoverage, summarizeAutomationStats } from "@savvy/core";
import { loadAgentRunWindow, loadAgentActivity } from "@/lib/command-center-queries";
import { loadTenantRollup } from "@/lib/scoreboard-queries";
import { resolveAgent, agentLabel } from "@/lib/agents";
import { AgentAvatar } from "@/components/cockpit/AgentAvatar";
import { SageCore } from "@/components/cockpit/SageCore";
import { MetricCard } from "@/components/cockpit/MetricCard";
import { CoverageMap } from "@/components/cockpit/CoverageMap";
import { CommandCenterAskSage } from "@/components/cockpit/CommandCenterAskSage";
import { PipelineSummaryPanel } from "./PipelineSummaryPanel";

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

// status → cockpit token (ok=green, skipped=amber, error=red, else faint)
function statusColor(status: string): string {
  if (status === "error") return "var(--status-error)";
  if (status === "skipped") return "var(--status-skip)";
  if (status === "ok") return "var(--status-ok)";
  return "var(--text-faint)";
}

function StatusPill({ status }: { status: string }) {
  const c = statusColor(status);
  return (
    <span
      className="mono rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider"
      style={{ color: c, background: `color-mix(in srgb, ${c} 14%, transparent)`, border: `1px solid color-mix(in srgb, ${c} 35%, transparent)` }}
    >
      {status}
    </span>
  );
}

export default async function CommandCenterPage() {
  const [runWindow, activity, rollup] = await Promise.all([loadAgentRunWindow(30), loadAgentActivity(30), loadTenantRollup()]);
  const now = new Date();
  const stats = summarizeAutomationStats(runWindow, now);
  const coverage = summarizeAgentCoverage(runWindow, now);
  const skips24 = activity.filter((r) => r.status === "skipped").length;
  const errs = activity.filter((r) => r.status === "error").length;

  return (
    <div className="space-y-6">
      {/* Pipeline (weighted) — async server component */}
      <PipelineSummaryPanel />
      <CommandCenterAskSage activity={activity} coverage={coverage} spendCents={stats.spendCents} />
      <div>
        <div className="eyebrow">Telemetry</div>
        <h1 className="text-2xl font-semibold tracking-tight">Command Center</h1>
        <p className="text-sm" style={{ color: "var(--text-muted)" }}>
          What your agents are doing — live from the activity log.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <MetricCard label="Actions · 24h" value={String(stats.last24h)} />
        <MetricCard label="AI spend · 30d" value={fmtUsd(stats.spendCents)} />
        <MetricCard label="Error rate" value={`${Math.round(stats.errorRate * 100)}%`} danger={stats.errorRate > 0} />
        <MetricCard label="Active agents" value={`${stats.activeAgents}/5`} />
      </div>

      {/* Empire Coverage — how much of the 212-task operation is automated & proven. */}
      <CoverageMap rollup={rollup} />

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Activity */}
        <Card className="p-4 lg:col-span-2">
          <h2 className="mb-3 font-semibold">Agent Activity</h2>
          {activity.length === 0 ? (
            <p className="text-sm" style={{ color: "var(--text-faint)" }}>
              No agent activity yet — agents run automatically on events (a new lead, an approved change order, a late invoice).
            </p>
          ) : (
            <ul className="space-y-1">
              {activity.map((r) => {
                const resolved = resolveAgent(r);
                return (
                  <li
                    key={r.id}
                    className="flex items-center gap-3 rounded-lg px-2 py-2 text-sm"
                    style={{ borderBottom: "1px solid var(--border-panel)" }}
                  >
                    <AgentAvatar persona={resolved.persona} size="sm" />
                    <span className="w-40 shrink-0 truncate" style={{ color: "var(--text-body)" }}>
                      {agentLabel(resolved)}
                    </span>
                    <span className="mono truncate text-[12px]" style={{ color: "var(--accent-deep)" }}>
                      {r.taskKey ?? "action"}
                    </span>
                    <span className="truncate text-[13px]" style={{ color: "var(--text-muted)" }}>
                      {r.target ?? ""}
                    </span>
                    <span className="ml-auto flex items-center gap-2">
                      {r.error && (r.status === "skipped" || r.status === "error") ? (
                        <span className="mono text-[11px]" style={{ color: statusColor(r.status) }}>{r.error}</span>
                      ) : r.modelUsed ? (
                        <span className="mono text-[11px]" style={{ color: "var(--text-faint)" }}>{r.modelUsed}</span>
                      ) : null}
                      <StatusPill status={r.status} />
                      <span className="mono w-16 text-right text-[11px]" style={{ color: "var(--text-faint)" }}>{ago(r.startedAt)}</span>
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        {/* Sage core + coverage */}
        <div className="space-y-6">
          <Card className="p-4">
            <div className="eyebrow mb-1">Orchestrator</div>
            <SageCore />
            <div className="mono mt-2 text-center text-[12px]" style={{ color: "var(--text-muted)" }}>
              {errs} errors · {skips24} skips · {stats.aiRuns} AI runs
            </div>
          </Card>

          <Card className="p-4">
            <h2 className="mb-3 font-semibold">Agent Coverage</h2>
            <ul className="space-y-2.5">
              {coverage.map((c) => {
                const resolved = resolveAgent({ agent: c.agent });
                const deferred = c.agent === "claims";
                const dot = c.total === 0 ? "var(--text-faint)" : c.error > 0 ? "var(--status-error)" : c.skipped > 0 ? "var(--status-skip)" : "var(--status-ok)";
                return (
                  <li key={c.agent} className="flex items-center gap-2.5 text-sm">
                    <AgentAvatar persona={resolved.persona} size="sm" dimmed={deferred} />
                    <span className="flex items-center gap-1.5" style={{ color: deferred ? "var(--text-faint)" : "var(--text-body)" }}>
                      {agentLabel(resolved)}
                      {deferred ? <span className="eyebrow" style={{ fontSize: "0.55rem" }}>deferred</span> : null}
                    </span>
                    <span className="ml-auto flex items-center gap-2">
                      <span className="mono text-[11px]" style={{ color: "var(--text-faint)" }}>
                        {c.total === 0 ? "—" : `${c.total} · ${c.lastRunAt ? ago(c.lastRunAt) : "—"}`}
                      </span>
                      <span className="h-2 w-2 rounded-full" style={{ background: dot, boxShadow: c.total > 0 && !deferred ? `0 0 8px ${dot}` : "none" }} />
                    </span>
                  </li>
                );
              })}
            </ul>
          </Card>
        </div>
      </div>
    </div>
  );
}
