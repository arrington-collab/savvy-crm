"use client";

import { useTransition } from "react";
import { groupLedgerByPhase, currentPhase, ledgerGlyph, isManual } from "@savvy/core";
import type { JobLedgerRow } from "@savvy/db";
import { Checkbox } from "@/components/ui/checkbox";
import { AgentAvatar } from "@/components/cockpit/AgentAvatar";
import { resolveAgent } from "@/lib/agents";
import { completeManualTask } from "@/lib/job-ledger-actions";

// job_task status → cockpit token, mirrors JobLedgerCard's palette so the tab
// and the (still-rendered) ledger card read as one system.
function statusColor(status: string): string {
  if (status === "verified") return "var(--status-ok)";
  if (status === "exception" || status === "failed") return "var(--status-error)";
  if (status === "done") return "var(--accent-gold)";
  if (status === "blocked") return "var(--status-skip)";
  return "var(--text-faint)";
}

function LedgerRowItem({
  row,
  jobId,
  nameById,
}: {
  row: JobLedgerRow;
  jobId: string;
  nameById: Map<number, string>;
}) {
  const [pending, startTransition] = useTransition();
  const glyph = ledgerGlyph(row.status as Parameters<typeof ledgerGlyph>[0], row.blockedBy).glyph;
  const done = row.status === "done" || row.status === "verified";
  // Manual-mode checkbox only for job-scoped rows — lead-origin rows are
  // read-only history carried from before conversion, never editable here.
  const manual = isManual(row.mode) && row.origin === "job";

  return (
    <div
      data-testid="task-row"
      data-task-status={row.status}
      data-origin={row.origin}
      className="flex items-center gap-3 rounded-md border border-border px-3 py-2"
    >
      {manual ? (
        <Checkbox
          checked={done}
          disabled={pending}
          aria-label={`Mark "${row.name}" complete`}
          onChange={(e) => {
            const next = e.target.checked;
            startTransition(async () => {
              await completeManualTask(jobId, row.taskId, next);
            });
          }}
        />
      ) : (
        <span className="w-4 shrink-0 text-center" style={{ color: statusColor(row.status) }} aria-hidden>
          {glyph}
        </span>
      )}
      {row.owner ? <AgentAvatar persona={resolveAgent({ agent: row.owner }).persona} size="sm" /> : null}
      <span className="min-w-0 flex-1">
        <span
          className={done ? "block truncate text-sm text-muted-foreground line-through" : "block truncate text-sm"}
          style={done ? undefined : { color: "var(--text-body)" }}
        >
          {row.name}
        </span>
        {row.blockedBy.length > 0 ? (
          <span className="mono text-[10px]" style={{ color: "var(--status-skip)" }} data-testid="ledger-blocked-by">
            blocked by {row.blockedBy.map((b) => nameById.get(b) ?? `#${b}`).join(", ")}
          </span>
        ) : null}
      </span>
      {row.evidence ? (
        row.evidence.url ? (
          <a
            href={row.evidence.url}
            target="_blank"
            rel="noreferrer"
            className="mono truncate text-[11px] hover:underline"
            style={{ color: "var(--accent-deep)" }}
            title={`${row.evidence.type}:${row.evidence.ref}`}
            data-testid="ledger-evidence"
          >
            {row.evidence.type}:{row.evidence.ref}
          </a>
        ) : (
          <span
            className="mono truncate text-[11px]"
            style={{ color: "var(--accent-deep)" }}
            title={`${row.evidence.type}:${row.evidence.ref}`}
            data-testid="ledger-evidence"
          >
            {row.evidence.type}:{row.evidence.ref}
          </span>
        )
      ) : null}
    </div>
  );
}

/**
 * The Tasks tab: the evidence-driven registry ledger, grouped by phase. Manual
 * tasks (job-scoped) get a checkbox wired to `completeManualTask`; every other
 * row (auto/assisted, or lead-origin history) is read-only — a glyph, owner
 * avatar, and evidence citation, never a click target. Collapsed (fully
 * terminal) phases start closed except the current phase.
 */
export function LedgerTab({ rows, jobId }: { rows: JobLedgerRow[]; jobId: string }) {
  const groups = groupLedgerByPhase(rows);
  const active = currentPhase(groups);
  const nameById = new Map(rows.map((r) => [r.taskId, r.name]));

  if (groups.length === 0) {
    return <p className="text-sm text-muted-foreground">No ledger tasks yet.</p>;
  }

  return (
    <div className="space-y-4">
      {groups.map((group) => {
        const header = (
          <h3 className="eyebrow flex items-center justify-between gap-2">
            <span>Phase {group.phase}</span>
            <span className="mono text-[11px]" style={{ color: "var(--text-faint)" }}>
              {group.done}/{group.total} ✓
            </span>
          </h3>
        );
        const body = (
          <div className="mt-2 space-y-2">
            {group.rows.map((row) => (
              <LedgerRowItem key={row.taskId} row={row} jobId={jobId} nameById={nameById} />
            ))}
          </div>
        );

        if (group.collapsed) {
          return (
            <section key={group.phase} data-testid="ledger-phase" className="space-y-1">
              <details open={group.phase === active}>
                <summary className="cursor-pointer list-none">{header}</summary>
                {body}
              </details>
            </section>
          );
        }

        return (
          <section key={group.phase} data-testid="ledger-phase" className="space-y-1">
            {header}
            {body}
          </section>
        );
      })}
    </div>
  );
}
