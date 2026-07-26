import type { DailyMetrics } from "./metrics";

export interface FlashComparison {
  leadsTotalVsYesterday: number | null;
  contractValueVsTrailing7: number | null;
  cashCollectedVsTrailing7: number | null;
}

function avg(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

export function compareMetrics(
  today: DailyMetrics,
  yesterday: DailyMetrics | null,
  trailing7: DailyMetrics[],
): FlashComparison {
  const cvAvg = avg(trailing7.map((m) => m.topLine.contractValueCents));
  const cashAvg = avg(trailing7.map((m) => m.money.cashCollectedCents));
  return {
    leadsTotalVsYesterday: yesterday ? today.topLine.leadsTotal - yesterday.topLine.leadsTotal : null,
    contractValueVsTrailing7: cvAvg === null ? null : today.topLine.contractValueCents - cvAvg,
    cashCollectedVsTrailing7: cashAvg === null ? null : today.money.cashCollectedCents - cashAvg,
  };
}
