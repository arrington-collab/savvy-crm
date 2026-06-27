// Pure real-time job-margin math (no I/O). Revenue is the job's value
// (valueFinal ?? valueEstimate); cost is what's recorded so far (job.costCents).
// Margin sharpens as more cost inputs (materials, labor) get modeled.

export type JobMargin = {
  revenueCents: number;
  costCents: number;
  marginCents: number;
  marginPct: number | null; // null when there's no revenue basis
  costKnown: boolean; // false when no cost has been recorded yet
};

export function computeJobMargin(input: { revenueCents: number | null; costCents: number | null }): JobMargin {
  const revenueCents = input.revenueCents ?? 0;
  const costCents = input.costCents ?? 0;
  const marginCents = revenueCents - costCents;
  const marginPct = revenueCents > 0 ? Math.round((marginCents / revenueCents) * 100) : null;
  return { revenueCents, costCents, marginCents, marginPct, costKnown: input.costCents != null };
}
