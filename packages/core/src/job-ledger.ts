/**
 * Job Ledger progress for the job-detail ledger section. Pure so the "N of M
 * complete" + progress-bar math is unit-tested. Complete = a task that's been
 * done or verified; exceptions and in-progress work don't count.
 */
export type LedgerProgressRow = { status: string };
export type LedgerProgress = { total: number; complete: number; pct: number };

export function summarizeLedgerProgress(rows: LedgerProgressRow[]): LedgerProgress {
  const total = rows.length;
  const complete = rows.filter((r) => r.status === "done" || r.status === "verified").length;
  return { total, complete, pct: total ? Math.round((complete / total) * 100) : 0 };
}
