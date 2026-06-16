export interface RepJobRow { userId: string; name: string; stage: string; valueCents: number; daysToClose: number | null }
export interface RepSummary { userId: string; name: string; jobsAssigned: number; approved: number; totalValueCents: number; avgDaysToClose: number }

const WON_STAGES = new Set(["approved", "production", "closeout", "billing", "complete"]);

export function summarizeRepPerformance(rows: RepJobRow[]): {
  reps: RepSummary[];
  team: { jobsAssigned: number; approved: number; totalValueCents: number };
} {
  const byUser = new Map<string, RepJobRow[]>();
  for (const r of rows) {
    const arr = byUser.get(r.userId) ?? [];
    arr.push(r);
    byUser.set(r.userId, arr);
  }
  const reps: RepSummary[] = [];
  for (const [userId, arr] of byUser) {
    const won = arr.filter((r) => WON_STAGES.has(r.stage));
    const closeTimes = won.map((r) => r.daysToClose).filter((d): d is number => d != null);
    reps.push({
      userId, name: arr[0]!.name, jobsAssigned: arr.length, approved: won.length,
      totalValueCents: won.reduce((s, r) => s + r.valueCents, 0),
      avgDaysToClose: closeTimes.length ? closeTimes.reduce((s, d) => s + d, 0) / closeTimes.length : 0,
    });
  }
  reps.sort((a, b) => b.totalValueCents - a.totalValueCents);
  const team = {
    jobsAssigned: reps.reduce((s, r) => s + r.jobsAssigned, 0),
    approved: reps.reduce((s, r) => s + r.approved, 0),
    totalValueCents: reps.reduce((s, r) => s + r.totalValueCents, 0),
  };
  return { reps, team };
}
