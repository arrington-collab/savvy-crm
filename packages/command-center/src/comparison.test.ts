import { it, expect } from "vitest";
import { compareMetrics } from "./comparison";
import { emptyMetrics } from "./metrics";

function withLeads(date: string, leads: number, contractCents = 0, cashCents = 0) {
  const m = emptyMetrics(date);
  m.topLine.leadsTotal = leads;
  m.topLine.contractValueCents = contractCents;
  m.money.cashCollectedCents = cashCents;
  return m;
}

it("computes vs-yesterday and vs-trailing-7-average", () => {
  const today = withLeads("2026-07-08", 10, 5_000_00, 4_000_00);
  const yest = withLeads("2026-07-07", 6);
  const trailing = [1, 2, 3, 4, 5, 6, 7].map((d) => withLeads(`2026-07-0${d}`, 0, 3_000_00, 2_000_00));
  const c = compareMetrics(today, yest, trailing);
  expect(c.leadsTotalVsYesterday).toBe(4);
  expect(c.contractValueVsTrailing7).toBe(5_000_00 - 3_000_00); // today − avg(3_000_00)
  expect(c.cashCollectedVsTrailing7).toBe(4_000_00 - 2_000_00);
});

it("returns null deltas when history is missing (no crash)", () => {
  const c = compareMetrics(withLeads("2026-07-01", 5), null, []);
  expect(c.leadsTotalVsYesterday).toBeNull();
  expect(c.contractValueVsTrailing7).toBeNull();
});
