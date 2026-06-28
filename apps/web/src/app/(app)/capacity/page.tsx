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
    </div>
  );
}
