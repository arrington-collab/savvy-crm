import type { JobStage, JobType } from "./enums";
import type { JobsConfig } from "./jobs-config";

const DAY = 86_400_000;

export type JobHealthSignals = {
  stage: JobStage;
  stageEnteredAt: Date;
  type: JobType;
  approvedAt: Date | null;
  hasPastDueInvoice: boolean;
};

export type JobHealth = { stuck: boolean; late: boolean; reasons: string[] };

export function deriveJobHealth(s: JobHealthSignals, config: JobsConfig, now: Date): JobHealth {
  // Terminal stages are done — never carry health flags
  if (s.stage === "complete" || s.stage === "lost") {
    return { stuck: false, late: false, reasons: [] };
  }

  const reasons: string[] = [];

  // stuck: only for stages with a configured threshold (terminal stages omitted)
  const threshold = (config.stageThresholds as Record<string, number>)[s.stage];
  const daysInStage = Math.floor((now.getTime() - s.stageEnteredAt.getTime()) / DAY);
  const stuck = threshold != null && daysInStage > threshold;
  if (stuck) reasons.push(`stuck ${daysInStage}d in ${s.stage} (>${threshold})`);

  // late: past expected completion (approved + buildSla) OR a past-due invoice
  let late = false;
  if (s.approvedAt) {
    const dueMs = s.approvedAt.getTime() + config.buildSlaDays[s.type] * DAY;
    if (now.getTime() > dueMs) {
      late = true;
      reasons.push(`past expected completion by ${Math.floor((now.getTime() - dueMs) / DAY)}d`);
    }
  }
  if (s.hasPastDueInvoice) {
    late = true;
    reasons.push("invoice past due");
  }

  return { stuck, late, reasons };
}
