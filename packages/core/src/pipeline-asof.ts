import type { JobStage } from "./enums";

export type AsOfJob = { id: string; valueEstimate: number | null; openedAt: Date };
export type AsOfEvent = { jobId: string; toStage: JobStage; enteredAt: Date };

const TERMINAL = new Set<JobStage>(["complete", "lost"]);

/**
 * Per-open-stage gross value of the pipeline as it stood at `asOf`, reconstructed
 * from stage events. Uses each job's CURRENT valueEstimate (historical value is not
 * snapshotted) — directional, not penny-exact.
 */
export function pipelineGrossAsOf(jobs: AsOfJob[], events: AsOfEvent[], asOf: Date): Record<string, number> {
  const t = asOf.getTime();
  const byJob = new Map<string, AsOfEvent[]>();
  for (const e of events) {
    if (e.enteredAt.getTime() > t) continue; // future of asOf
    const list = byJob.get(e.jobId) ?? [];
    list.push(e);
    byJob.set(e.jobId, list);
  }
  const result: Record<string, number> = {};
  for (const j of jobs) {
    if (j.openedAt.getTime() > t) continue; // didn't exist yet
    const evs = byJob.get(j.id);
    const stageAsOf: JobStage =
      evs && evs.length
        ? evs.reduce((a, b) => (b.enteredAt.getTime() >= a.enteredAt.getTime() ? b : a)).toStage
        : ("lead" as JobStage); // created but no recorded transition yet
    if (TERMINAL.has(stageAsOf)) continue;
    result[stageAsOf] = (result[stageAsOf] ?? 0) + (j.valueEstimate ?? 0);
  }
  return result;
}
