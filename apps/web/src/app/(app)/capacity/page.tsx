import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { getCapacityView } from "@/lib/capacity-queries";

const STATUS_COLOR: Record<string, string> = {
  over: "var(--color-destructive, #dc2626)",
  high: "var(--accent-gold)",
  ok: "var(--accent-gold)",
  free: "var(--text-faint)",
};

function hrs(min: number): string {
  return `${Math.round(min / 60)}h`;
}

export default async function CapacityPage() {
  const view = await getCapacityView();
  return (
    <div className="space-y-6" data-testid="capacity-page">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Capacity</h1>
          <p className="text-xs" style={{ color: "var(--text-faint)" }}>Next {view.windowDays} days</p>
        </div>
        <div className="text-right">
          <div className="mono text-2xl font-semibold text-accent-gold" data-testid="team-utilization">{view.teamUtilizationPct}%</div>
          <div className="text-xs" style={{ color: "var(--text-faint)" }}>{view.overCount} overbooked</div>
        </div>
      </div>

      {view.crewDemand.recommendAnotherCrew && (
        <div
          data-testid="need-another-crew"
          className="rounded-md border p-3 text-sm"
          style={{ borderColor: "var(--color-destructive, #dc2626)", color: "var(--color-destructive, #dc2626)" }}
        >
          <span className="font-semibold">You need another crew.</span>{" "}
          {view.crewDemand.pendingInstalls} jobs are awaiting install but your {view.crewDemand.crewCount}{" "}
          {view.crewDemand.crewCount === 1 ? "crew" : "crews"} can only build ~{view.crewDemand.buildCapacity} in the next{" "}
          {view.windowDays} days — add {view.crewDemand.suggestedCrews}{" "}
          {view.crewDemand.suggestedCrews === 1 ? "crew" : "crews"} to keep up.
        </div>
      )}

      <Card>
        <CardHeader><CardTitle>Rep load</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          {view.reps.length === 0 && (
            <p className="text-sm" style={{ color: "var(--text-faint)" }} data-testid="capacity-empty">No assignable reps yet.</p>
          )}
          {view.reps.map((r) => (
            <div key={r.userId} className="space-y-1" data-testid="capacity-rep" data-status={r.status}>
              <div className="flex items-center justify-between text-sm">
                <span className="font-medium">{r.name}</span>
                <span className="mono text-xs" style={{ color: "var(--text-faint)" }}>
                  {hrs(r.scheduledMin)} of {hrs(r.availableMin)} · {r.apptCount} appts · <span data-testid="rep-utilization">{r.utilizationPct}%</span>
                </span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full" style={{ background: "var(--surface-2, rgba(255,255,255,0.06))" }}>
                <div
                  className="h-full rounded-full"
                  style={{ width: `${Math.min(100, r.utilizationPct)}%`, background: STATUS_COLOR[r.status] }}
                />
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card data-testid="crew-capacity">
        <CardHeader><CardTitle>Crew load</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          {view.crews.crews.length === 0 && (
            <p className="text-sm" style={{ color: "var(--text-faint)" }} data-testid="crew-capacity-empty">No active crews yet.</p>
          )}
          {view.crews.crews.map((c) => (
            <div key={c.crewId} className="space-y-1" data-testid="crew-capacity-row" data-status={c.status}>
              <div className="flex items-center justify-between text-sm">
                <span className="font-medium">{c.name}</span>
                <span className="mono text-xs" style={{ color: "var(--text-faint)" }}>
                  {hrs(c.scheduledMin)} of {hrs(c.availableMin)} · {c.apptCount} appts · <span data-testid="crew-utilization">{c.utilizationPct}%</span>
                </span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full" style={{ background: "var(--surface-2, rgba(255,255,255,0.06))" }}>
                <div
                  className="h-full rounded-full"
                  style={{ width: `${Math.min(100, c.utilizationPct)}%`, background: STATUS_COLOR[c.status] }}
                />
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
