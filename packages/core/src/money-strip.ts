/**
 * Money strip for the Today operator console — the four headline money KPIs.
 * Pure so the aging + per-job math is unit-tested; the page just fetches rows
 * and renders this. AR outstanding + aging come from open invoices, cash-week
 * is summed in SQL and passed through, founder-minutes-per-job comes from the
 * nightly rollup, and gross margin stays null until estimate/invoice actuals
 * land (contract cell 14) — the page renders "—" for null metrics.
 */
const AGING_THRESHOLD_MS = 45 * 86_400_000; // "AR > 45d" bucket

export type MoneyStripInput = {
  openInvoices: { amountDueCents: number; amountPaidCents: number; dueAt: Date | null }[];
  cashCollectedWkCents: number;
  rollup: { founderMinutes30d: number; jobs30d: number } | null;
  now: Date;
};

export type MoneyStrip = {
  cashWkCents: number;
  arTotalCents: number;
  arOver45Cents: number;
  arOver45Count: number;
  founderMinPerJob: number | null; // null → render "—"
  gmMtdPct: number | null; // null in this build → render "—"
};

export function summarizeMoneyStrip(input: MoneyStripInput): MoneyStrip {
  const agedBefore = input.now.getTime() - AGING_THRESHOLD_MS;
  let arTotalCents = 0;
  let arOver45Cents = 0;
  let arOver45Count = 0;

  for (const inv of input.openInvoices) {
    const outstanding = Math.max(0, inv.amountDueCents - inv.amountPaidCents);
    if (outstanding === 0) continue;
    arTotalCents += outstanding;
    if (inv.dueAt != null && inv.dueAt.getTime() < agedBefore) {
      arOver45Cents += outstanding;
      arOver45Count += 1;
    }
  }

  const founderMinPerJob =
    input.rollup && input.rollup.jobs30d > 0
      ? Math.round(input.rollup.founderMinutes30d / input.rollup.jobs30d)
      : null;

  return {
    cashWkCents: input.cashCollectedWkCents,
    arTotalCents,
    arOver45Cents,
    arOver45Count,
    founderMinPerJob,
    gmMtdPct: null,
  };
}

/**
 * Estimated attention for the decision queue: sum of per-card estimates,
 * defaulting to 3 min/card until per-card founder-minute instrumentation lands.
 */
export function estimateDecisionMinutes(cardCount: number, perCardMinutes = 3): number {
  return cardCount * perCardMinutes;
}
