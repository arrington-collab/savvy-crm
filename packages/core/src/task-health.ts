import type { TaskMode, TaskHealthStatus, EvidenceStatus } from "./enums";

/**
 * The scoreboard's status rules, encoded exactly (see the Task Registry spec).
 * Pure so the nightly sweep's decision is fully unit-tested independent of the
 * DB. Status is EARNED from streaks + verification recency, never declared.
 */
export interface TaskHealthInputs {
  mode: TaskMode; // effective mode (tenant override or registry default)
  hasCheckKey: boolean;
  priorStatus: TaskHealthStatus;
  priorStreakDays: number;
  latestVerification: EvidenceStatus | null; // newest verification_run this sweep (null = never)
  consecutiveFails: number; // trailing consecutive 'fail' runs incl. the latest
  doneButWrong: boolean; // a spot-verified 'done' ledger row failed its check
  openExceptionCount: number; // open exceptions attributed to this task
  openExceptionPastSla: boolean; // any open exception older than its SLA
}

export interface TaskHealthResult {
  status: TaskHealthStatus;
  cleanStreakDays: number;
  emitsRegression: boolean; // green -> amber/red transition (never on recovery or ->gray)
}

const GREEN_STREAK_DAYS = 14;

export function computeTaskHealth(i: TaskHealthInputs): TaskHealthResult {
  // gray — not measured. Carry the streak; a mode/binding change is not a regression.
  if (i.mode === "manual" || !i.hasCheckKey) {
    return { status: "gray", cleanStreakDays: i.priorStreakDays, emitsRegression: false };
  }

  // A clean skip means "nothing to verify this window" — neutral, no streak change.
  if (i.latestVerification === "skip" && !i.doneButWrong && i.openExceptionCount === 0) {
    return { status: i.priorStatus, cleanStreakDays: i.priorStreakDays, emitsRegression: false };
  }

  const clean = i.latestVerification === "pass" && !i.doneButWrong && i.openExceptionCount === 0;
  const cleanStreakDays = clean ? i.priorStreakDays + 1 : 0;

  let status: TaskHealthStatus;
  if (i.doneButWrong || i.consecutiveFails >= 2) {
    status = "red"; // done-but-wrong or a repeated failure
  } else if (i.latestVerification === "fail" || i.latestVerification === "stale" || i.openExceptionPastSla) {
    status = "amber"; // single fail, soft-fail (stale), or an exception past SLA
  } else if (cleanStreakDays >= GREEN_STREAK_DAYS && i.openExceptionCount === 0) {
    status = "green"; // earned: long clean streak, no open exceptions, verified in window
  } else {
    status = "amber"; // warming up, unproven, or a fresh open exception
  }

  return { status, cleanStreakDays, emitsRegression: i.priorStatus === "green" && status !== "green" };
}
