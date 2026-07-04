/**
 * Money screen pure logic: AR aging ladder (0-30 / 31-60 / 61+) and a summary of
 * the nightly proof-of-correctness runs. Kept pure so the bucketing + pass/fail
 * math is unit-tested; the /money page fetches rows and renders these.
 */
const DAY_MS = 86_400_000;

export type AgingInput = {
  openInvoices: { amountDueCents: number; amountPaidCents: number; dueAt: Date | null }[];
  now: Date;
};

export type AgingBucket = { cents: number; count: number };
export type ArAging = {
  current: AgingBucket; // due within 30 days or not yet due
  d31_60: AgingBucket;
  d61plus: AgingBucket;
  totalCents: number;
};

function empty(): AgingBucket {
  return { cents: 0, count: 0 };
}

export function bucketArAging(input: AgingInput): ArAging {
  const current = empty(), d31_60 = empty(), d61plus = empty();
  for (const inv of input.openInvoices) {
    const outstanding = Math.max(0, inv.amountDueCents - inv.amountPaidCents);
    if (outstanding === 0) continue;
    // Age in days past due; null due date or not-yet-due counts as current.
    const ageDays = inv.dueAt ? Math.floor((input.now.getTime() - inv.dueAt.getTime()) / DAY_MS) : 0;
    const bucket = ageDays > 60 ? d61plus : ageDays > 30 ? d31_60 : current;
    bucket.cents += outstanding;
    bucket.count += 1;
  }
  return { current, d31_60, d61plus, totalCents: current.cents + d31_60.cents + d61plus.cents };
}

export type VerificationRunLite = { checkKey: string; status: "pass" | "fail" | "stale" | "skip" };
export type VerificationSummary = {
  total: number;
  passed: number;
  failed: number;
  stale: number;
  skipped: number;
  allGreen: boolean; // proven: at least one run and zero failures
};

export function summarizeVerification(runs: VerificationRunLite[]): VerificationSummary {
  const passed = runs.filter((r) => r.status === "pass").length;
  const failed = runs.filter((r) => r.status === "fail").length;
  const stale = runs.filter((r) => r.status === "stale").length;
  const skipped = runs.filter((r) => r.status === "skip").length;
  return { total: runs.length, passed, failed, stale, skipped, allGreen: runs.length > 0 && failed === 0 };
}
