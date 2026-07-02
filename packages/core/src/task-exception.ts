import type { TaskHealthStatus, EvidenceStatus } from "./enums";

/**
 * Scoreboard exceptions — computed vectors (the #82 pattern: state-derived, no
 * marker columns). An unhealthy (amber/red) task IS an open exception; when it
 * recovers to green the exception simply disappears. Pure so the classification
 * + ranking is unit-tested independent of the DB.
 */
export type TaskExceptionKind = "task_regression" | "task_stale" | "verification_mismatch";
export type TaskExceptionSeverity = "high" | "medium";

export interface TaskExceptionInput {
  taskId: number;
  taskName: string;
  status: TaskHealthStatus;
  latestVerification: EvidenceStatus | null;
  ledgerExceptionCount: number; // done-but-wrong rows (task_health.open_exception_count)
  estFounderMinutes: number;
}

export interface TaskException {
  taskId: number;
  kind: TaskExceptionKind;
  severity: TaskExceptionSeverity;
  title: string;
  detail: string;
  estFounderMinutes: number;
}

function classify(i: TaskExceptionInput): { kind: TaskExceptionKind; severity: TaskExceptionSeverity; detail: string } {
  if (i.ledgerExceptionCount > 0) {
    return { kind: "verification_mismatch", severity: "high", detail: `${i.ledgerExceptionCount} done-but-wrong` };
  }
  if (i.latestVerification === "stale") {
    return { kind: "task_stale", severity: "medium", detail: "verification stale (didn't run when expected)" };
  }
  return { kind: "task_regression", severity: i.status === "red" ? "high" : "medium", detail: `health ${i.status}` };
}

/**
 * Builds the ranked scoreboard exception worklist from per-task health state.
 * Only amber/red tasks surface. Ranked high-severity first, then by
 * est_founder_minutes descending (the biggest manual burden gets attention
 * first — that ordering is the automation roadmap).
 */
export function buildTaskExceptions(inputs: TaskExceptionInput[]): TaskException[] {
  const items = inputs
    .filter((i) => i.status === "amber" || i.status === "red")
    .map((i) => {
      const { kind, severity, detail } = classify(i);
      return { taskId: i.taskId, kind, severity, title: i.taskName, detail, estFounderMinutes: i.estFounderMinutes };
    });

  const sevRank = (s: TaskExceptionSeverity) => (s === "high" ? 0 : 1);
  items.sort((a, b) => sevRank(a.severity) - sevRank(b.severity) || b.estFounderMinutes - a.estFounderMinutes);
  return items;
}
