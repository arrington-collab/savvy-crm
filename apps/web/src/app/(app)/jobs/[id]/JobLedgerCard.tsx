import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import type { JobLedgerRow } from "@savvy/db";

// job_task status → cockpit token. verified=proven green, done=claimed (gold),
// exception=red, blocked/pending=faint.
function statusColor(status: string): string {
  if (status === "verified") return "var(--status-ok)";
  if (status === "exception") return "var(--status-error)";
  if (status === "done") return "var(--accent-gold)";
  if (status === "blocked") return "var(--status-skip)";
  return "var(--text-faint)";
}

// task_health status → dot color.
function healthColor(status: string | null): string {
  if (status === "green") return "var(--status-ok)";
  if (status === "amber") return "var(--status-skip)";
  if (status === "red") return "var(--status-error)";
  return "var(--text-faint)"; // gray / unscored
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

/**
 * The Job Ledger (read-only): the registry tasks instantiated for this job with
 * their claimed/verified status, evidence refs, and scoreboard health. The
 * proof surface for "is X done?" — every row cites a job_task, not model memory.
 */
export function JobLedgerCard({ rows }: { rows: JobLedgerRow[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Job Ledger</CardTitle>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-sm" style={{ color: "var(--text-faint)" }}>
            No ledger tasks yet — registry tasks are instantiated when the job is created.
          </p>
        ) : (
          <ul className="space-y-1">
            {rows.map((r) => (
              <li
                key={r.taskId}
                className="flex items-center gap-3 rounded-lg px-2 py-2 text-sm"
                style={{ borderBottom: "1px solid var(--border-panel)" }}
              >
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  title={`health: ${r.healthStatus ?? "unscored"}`}
                  style={{ background: healthColor(r.healthStatus) }}
                />
                <span className="mono w-10 shrink-0 text-[11px]" style={{ color: "var(--text-faint)" }}>
                  P{r.phase}
                </span>
                <span className="min-w-0 flex-1 truncate" style={{ color: "var(--text-body)" }}>
                  {r.name}
                </span>
                {r.evidence ? (
                  <span className="mono truncate text-[11px]" style={{ color: "var(--accent-deep)" }} title={`${r.evidence.type}:${r.evidence.ref}`}>
                    {r.evidence.type}:{r.evidence.ref}
                  </span>
                ) : null}
                {r.owner ? (
                  <span className="mono hidden text-[11px] sm:inline" style={{ color: "var(--text-faint)" }}>
                    {r.owner}
                  </span>
                ) : null}
                <StatusPill status={r.status} />
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
