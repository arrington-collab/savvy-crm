import { Card } from "@/components/ui/card";
import { getPhaseProgressForJob } from "@savvy/db";
import { getTenantId } from "@/lib/tenant";

const STATUS_DOT: Record<string, string> = {
  pending: "var(--text-faint)",
  in_progress: "var(--accent)",
  done: "var(--success, #10b981)",
  verified: "var(--success, #10b981)",
};

/** Live phase progress on the job card: "Install — 60%, on pace." Crews advance
 *  this by capturing; there are no buttons here by design. */
export async function PhaseProgressCard({ jobId }: { jobId: string }) {
  const tenantId = await getTenantId();
  const progress = await getPhaseProgressForJob({ tenantId, jobId }).catch(() => null);
  if (!progress) return null;

  const pct = Math.round((progress.done / Math.max(progress.total, 1)) * 100);
  const currentLabel = progress.current
    ? progress.phases.find((p) => p.key === progress.current!.key)?.label ?? progress.current.key
    : null;

  return (
    <Card className="p-5" data-testid="phase-progress-card">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Production</h3>
        <p className="text-sm" style={{ color: "var(--text-muted)" }} data-testid="phase-progress-line">
          {currentLabel
            ? `${currentLabel} — ${pct}%${progress.current!.onPace ? ", on pace" : ", running long"}`
            : `${progress.done}/${progress.total} phases`}
        </p>
      </div>
      <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full" style={{ backgroundColor: "var(--surface-raised, #e7e5e4)" }}>
        <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, backgroundColor: "var(--accent)" }} />
      </div>
      <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">
        {progress.phases.map((p) => (
          <li key={p.key} className="flex items-center gap-1.5 text-xs" style={{ color: "var(--text-muted)" }} data-testid={`phase-chip-${p.key}`}>
            <span aria-hidden className="h-2 w-2 rounded-full" style={{ backgroundColor: STATUS_DOT[p.status] ?? STATUS_DOT.pending }} />
            {p.label}
          </li>
        ))}
      </ul>
    </Card>
  );
}
