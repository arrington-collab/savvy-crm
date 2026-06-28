import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { AgentAvatar } from "@/components/cockpit/AgentAvatar";
import { resolveAgent } from "@/lib/agents";
import type { JobAutomationSummary } from "@savvy/core";

export function AutomationModule({ summary }: { summary: JobAutomationSummary }) {
  return (
    <Card data-testid="automation-module">
      <CardHeader><CardTitle>Automation</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <div className="mono text-3xl font-semibold text-accent-gold" data-testid="autonomy-pct">{summary.autonomyPct}%</div>
            <div className="text-xs" style={{ color: "var(--text-faint)" }}>
              {summary.full} full · {summary.partial} partial of {summary.total} tasks
            </div>
          </div>
          <div className="text-right">
            <div className="mono text-lg font-semibold" data-testid="needs-you-count">{summary.needsYouCount}</div>
            <div className="text-xs" style={{ color: "var(--text-faint)" }}>need you</div>
          </div>
        </div>

        {summary.byAgent.length > 0 && (
          <div className="space-y-2">
            {summary.byAgent.map((a) => {
              const { persona } = resolveAgent({ agent: a.agent });
              return (
                <div key={a.agent} className="flex items-center justify-between text-sm" data-testid="automation-agent-row">
                  <span className="flex items-center gap-2">
                    <AgentAvatar persona={persona} size="sm" />
                    <span style={{ color: "var(--text-muted)" }}>{a.label}</span>
                  </span>
                  <span
                    className="mono text-xs"
                    style={{ color: "var(--text-faint)" }}
                    aria-label={`${a.label}: ${a.full} full, ${a.partial} partial, ${a.manual} manual`}
                  >
                    {a.full} full · {a.partial} partial · {a.manual} manual
                  </span>
                </div>
              );
            })}
          </div>
        )}

        {summary.total === 0 && (
          <p className="text-sm" style={{ color: "var(--text-faint)" }}>No tasks yet.</p>
        )}
      </CardContent>
    </Card>
  );
}
