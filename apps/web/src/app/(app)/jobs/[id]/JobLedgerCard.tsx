import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { summarizeLedgerProgress } from "@savvy/core";
import type { JobLedgerRow } from "@savvy/db";

export type LedgerTimelineItem = { kind: "stage" | "comm" | "audit"; at: string; text: string };

// job_task status → cockpit token. verified=proven green, done=claimed (gold),
// exception=red, blocked/pending=faint.
function statusColor(status: string): string {
  if (status === "verified") return "var(--status-ok)";
  if (status === "exception") return "var(--status-error)";
  if (status === "done") return "var(--accent-gold)";
  if (status === "blocked") return "var(--status-skip)";
  return "var(--text-faint)";
}
// Leading glyph mirrors the mockup: ✓ complete · ◐ exception/in-flight · ○ pending.
function statusGlyph(status: string): string {
  if (status === "verified" || status === "done") return "✓";
  if (status === "exception") return "◐";
  if (status === "blocked") return "⊘";
  return "○";
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
 * their claimed/verified status, evidence refs, blocking, and scoreboard health,
 * plus a progress bar. The proof surface for "is X done?" — every row cites a
 * job_task, not model memory. For jobs predating the registry (no instantiated
 * tasks) it falls back to the derived event timeline rather than an empty state.
 */
export function JobLedgerCard({ rows, timeline = [] }: { rows: JobLedgerRow[]; timeline?: LedgerTimelineItem[] }) {
  const progress = summarizeLedgerProgress(rows);

  return (
    <Card data-testid="job-ledger">
      <CardHeader>
        <CardTitle>Job Ledger</CardTitle>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          // Fallback: old jobs have no instantiated tasks — show the derived timeline.
          timeline.length === 0 ? (
            <p className="text-sm" style={{ color: "var(--text-faint)" }}>
              No ledger tasks or activity yet — registry tasks are instantiated when the job is created.
            </p>
          ) : (
            <div data-testid="ledger-timeline-fallback">
              <p className="mb-3 text-[12px]" style={{ color: "var(--text-faint)" }}>
                This job predates the task registry — showing its activity timeline instead.
              </p>
              <ul className="space-y-1">
                {timeline.map((t, i) => (
                  <li key={i} className="flex items-baseline gap-3 py-1.5 text-sm" style={{ borderBottom: "1px solid var(--border-panel)" }}>
                    <span className="mono w-16 shrink-0 text-[10px] uppercase" style={{ color: "var(--text-faint)" }}>{t.kind}</span>
                    <span className="min-w-0 flex-1" style={{ color: "var(--text-muted)" }}>{t.text}</span>
                    <span className="mono shrink-0 text-[10px]" style={{ color: "var(--text-faint)" }}>{new Date(t.at).toLocaleDateString()}</span>
                  </li>
                ))}
              </ul>
            </div>
          )
        ) : (
          <>
            {/* Progress */}
            <div className="mb-3">
              <div className="mb-1.5 flex items-baseline justify-between">
                <span className="mono text-[11px]" style={{ color: "var(--text-muted)" }} data-testid="ledger-progress">
                  {progress.complete} of {progress.total} complete
                </span>
                <span className="mono text-[11px] text-accent-gold">{progress.pct}%</span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full" style={{ background: "var(--border-panel)" }}>
                <div className="h-full rounded-full" style={{ width: `${progress.pct}%`, background: "var(--accent-gold)" }} />
              </div>
            </div>

            <ul className="space-y-1">
              {rows.map((r) => (
                <li key={r.taskId} className="flex items-center gap-3 rounded-lg px-2 py-2 text-sm" style={{ borderBottom: "1px solid var(--border-panel)" }} data-testid="ledger-row">
                  <span className="w-3 shrink-0 text-center" style={{ color: statusColor(r.status) }} aria-hidden>{statusGlyph(r.status)}</span>
                  <span className="mono w-8 shrink-0 text-[11px]" style={{ color: "var(--text-faint)" }}>P{r.phase}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate" style={{ color: "var(--text-body)" }}>{r.name}</span>
                    {r.blockedBy.length > 0 ? (
                      <span className="mono text-[10px]" style={{ color: "var(--status-skip)" }} data-testid="ledger-blocked-by">
                        blocked by {r.blockedBy.map((b) => `#${b}`).join(", ")}
                      </span>
                    ) : null}
                  </span>
                  {r.evidence ? (
                    r.evidence.url ? (
                      <a href={r.evidence.url} target="_blank" rel="noreferrer" className="mono truncate text-[11px] hover:underline" style={{ color: "var(--accent-deep)" }} title={`${r.evidence.type}:${r.evidence.ref}`} data-testid="ledger-evidence">
                        {r.evidence.type}:{r.evidence.ref}
                      </a>
                    ) : (
                      <span className="mono truncate text-[11px]" style={{ color: "var(--accent-deep)" }} title={`${r.evidence.type}:${r.evidence.ref}`} data-testid="ledger-evidence">
                        {r.evidence.type}:{r.evidence.ref}
                      </span>
                    )
                  ) : null}
                  {r.owner ? <span className="mono hidden text-[11px] sm:inline" style={{ color: "var(--text-faint)" }}>{r.owner}</span> : null}
                  <StatusPill status={r.status} />
                </li>
              ))}
            </ul>
          </>
        )}
      </CardContent>
    </Card>
  );
}
