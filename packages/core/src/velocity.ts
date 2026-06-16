export interface StageEvent { jobId: string; toStage: string; enteredAt: Date }

const DAY = 86_400_000;

/** Avg days spent in each stage (time from entering it to entering the next), + overall cycle time. */
export function computeVelocity(events: StageEvent[]): { perStageAvgDays: Record<string, number>; cycleTimeDays: number } {
  if (events.length === 0) return { perStageAvgDays: {}, cycleTimeDays: 0 };

  const byJob = new Map<string, StageEvent[]>();
  for (const e of events) {
    const arr = byJob.get(e.jobId) ?? [];
    arr.push(e);
    byJob.set(e.jobId, arr);
  }
  const durations = new Map<string, number[]>(); // stage -> [days]
  let totalCycle = 0;
  let cycleCount = 0;
  for (const arr of byJob.values()) {
    const sorted = [...arr].sort((a, b) => a.enteredAt.getTime() - b.enteredAt.getTime());
    for (let i = 0; i < sorted.length - 1; i++) {
      const days = (sorted[i + 1]!.enteredAt.getTime() - sorted[i]!.enteredAt.getTime()) / DAY;
      const list = durations.get(sorted[i]!.toStage) ?? [];
      list.push(days);
      durations.set(sorted[i]!.toStage, list);
    }
    if (sorted.length >= 2) {
      totalCycle += (sorted.at(-1)!.enteredAt.getTime() - sorted[0]!.enteredAt.getTime()) / DAY;
      cycleCount++;
    }
  }
  const perStageAvgDays: Record<string, number> = {};
  for (const [stage, list] of durations) perStageAvgDays[stage] = list.reduce((s, d) => s + d, 0) / list.length;
  return { perStageAvgDays, cycleTimeDays: cycleCount ? totalCycle / cycleCount : 0 };
}
