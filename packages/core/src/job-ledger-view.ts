import type { TaskMode, JobTaskStatus } from "./enums";

export type LedgerState = "pending" | "blocked" | "done" | "verified" | "exception" | "na";
export interface LedgerRowInput { taskId: number; phase: number; status: JobTaskStatus; blockedBy: number[]; }
export interface PhaseGroup<T extends LedgerRowInput = LedgerRowInput> {
  phase: number;
  done: number;
  total: number;
  collapsed: boolean;
  rows: T[];
}

const TERMINAL: JobTaskStatus[] = ["done", "verified", "not_applicable", "skipped"];
const isTerminal = (s: JobTaskStatus) => TERMINAL.includes(s);

export function effectiveMode(defaultMode: TaskMode, override: TaskMode | null): TaskMode {
  return override ?? defaultMode;
}
export function isManual(mode: TaskMode): boolean {
  return mode === "manual";
}
export function ledgerGlyph(status: JobTaskStatus, blockedBy: number[]): { glyph: string; state: LedgerState } {
  if (status === "verified") return { glyph: "✓", state: "verified" };
  if (status === "done") return { glyph: "✓", state: "done" };
  if (status === "exception" || status === "failed") return { glyph: "✗", state: "exception" };
  if (status === "not_applicable" || status === "skipped") return { glyph: "–", state: "na" };
  if (blockedBy.length > 0) return { glyph: "⊘", state: "blocked" };
  return { glyph: "○", state: "pending" };
}
export function groupLedgerByPhase<T extends LedgerRowInput>(rows: T[]): PhaseGroup<T>[] {
  const byPhase = new Map<number, T[]>();
  for (const r of rows) (byPhase.get(r.phase) ?? byPhase.set(r.phase, []).get(r.phase)!).push(r);
  return [...byPhase.entries()]
    .sort(([a], [b]) => a - b)
    .map(([phase, rs]) => ({
      phase,
      total: rs.length,
      done: rs.filter((r) => isTerminal(r.status)).length,
      collapsed: rs.every((r) => isTerminal(r.status)),
      rows: rs,
    }));
}
export function currentPhase<T extends LedgerRowInput>(groups: PhaseGroup<T>[]): number {
  return groups.find((g) => !g.collapsed)?.phase ?? groups.at(-1)?.phase ?? 1;
}
export function firstUnblockedIncomplete<T extends LedgerRowInput>(rows: T[]): T | null {
  return rows.find((r) => !isTerminal(r.status) && r.blockedBy.length === 0) ?? null;
}
