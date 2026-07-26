export interface DailyMetrics {
  businessDate: string; // YYYY-MM-DD Denver
  topLine: {
    leadsTotal: number;
    leadsBySource: Record<string, number>;
    appointmentsSet: number;
    appointmentsNoShow: number;
    contractsSigned: number;
    contractValueCents: number;
    jobsCompleted: number;
  };
  money: {
    invoicedCents: number;
    cashCollectedCents: number;
    supplementsApprovedCents: number;
    arPastDue: { d30: number; d60: number; d90: number }; // counts by bucket
  };
  speed: { medianSpeedToLeadMs: number | null; pctLeadsUnder5Min: number | null };
  quality: { reviewsPosted: number; avgStars: number | null };
  production: { estimatesApproved: number; avgMarginPct: number | null; materialOrders: number };
}

export function emptyMetrics(businessDate: string): DailyMetrics {
  return {
    businessDate,
    topLine: { leadsTotal: 0, leadsBySource: {}, appointmentsSet: 0, appointmentsNoShow: 0, contractsSigned: 0, contractValueCents: 0, jobsCompleted: 0 },
    money: { invoicedCents: 0, cashCollectedCents: 0, supplementsApprovedCents: 0, arPastDue: { d30: 0, d60: 0, d90: 0 } },
    speed: { medianSpeedToLeadMs: null, pctLeadsUnder5Min: null },
    quality: { reviewsPosted: 0, avgStars: null },
    production: { estimatesApproved: 0, avgMarginPct: null, materialOrders: 0 },
  };
}
