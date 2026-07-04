/**
 * Month-to-date gross margin from job actuals. Pure; the Money KPI query passes
 * this period's invoiced jobs. Jobs with unknown cost are excluded so GM reflects
 * only jobs whose cost is real. Null (no known-cost jobs) → the page renders "—".
 */
export function computeMtdGrossMargin(jobs: { revenueCents: number; costCents: number | null }[]): number | null {
  const known = jobs.filter((j) => j.costCents != null);
  if (known.length === 0) return null;
  const revenue = known.reduce((a, j) => a + j.revenueCents, 0);
  const cost = known.reduce((a, j) => a + (j.costCents ?? 0), 0);
  if (revenue === 0) return null;
  return Math.round(((revenue - cost) / revenue) * 100);
}
