import { describe, it, expect } from "vitest";
import { summarizeMoneyStrip, estimateDecisionMinutes } from "./money-strip";

const NOW = new Date("2026-07-03T12:00:00Z");
// 45 days before NOW = 2026-05-19T12:00:00Z
const OLD_DUE = new Date("2026-05-01T00:00:00Z"); // > 45d overdue
const RECENT_DUE = new Date("2026-06-25T00:00:00Z"); // < 45d

describe("summarizeMoneyStrip", () => {
  it("sums AR outstanding as amountDue minus amountPaid, ignoring fully-paid invoices", () => {
    const s = summarizeMoneyStrip({
      openInvoices: [
        { amountDueCents: 10_000, amountPaidCents: 4_000, dueAt: RECENT_DUE }, // 6,000 outstanding
        { amountDueCents: 5_000, amountPaidCents: 5_000, dueAt: RECENT_DUE }, // paid → 0
      ],
      cashCollectedWkCents: 0,
      rollup: null,
      now: NOW,
    });
    expect(s.arTotalCents).toBe(6_000);
  });

  it("buckets only invoices due more than 45 days ago into arOver45", () => {
    const s = summarizeMoneyStrip({
      openInvoices: [
        { amountDueCents: 20_000, amountPaidCents: 0, dueAt: OLD_DUE }, // >45d
        { amountDueCents: 8_000, amountPaidCents: 0, dueAt: RECENT_DUE }, // <45d
        { amountDueCents: 3_000, amountPaidCents: 0, dueAt: null }, // no due date → not aged
      ],
      cashCollectedWkCents: 0,
      rollup: null,
      now: NOW,
    });
    expect(s.arTotalCents).toBe(31_000);
    expect(s.arOver45Cents).toBe(20_000);
    expect(s.arOver45Count).toBe(1);
  });

  it("never counts a negative outstanding balance (overpaid invoice)", () => {
    const s = summarizeMoneyStrip({
      openInvoices: [{ amountDueCents: 5_000, amountPaidCents: 7_000, dueAt: OLD_DUE }],
      cashCollectedWkCents: 0,
      rollup: null,
      now: NOW,
    });
    expect(s.arTotalCents).toBe(0);
    expect(s.arOver45Cents).toBe(0);
  });

  it("passes cash-collected-this-week straight through", () => {
    const s = summarizeMoneyStrip({
      openInvoices: [],
      cashCollectedWkCents: 41_200_00,
      rollup: null,
      now: NOW,
    });
    expect(s.cashWkCents).toBe(41_200_00);
  });

  it("derives founder-minutes-per-job from the rollup when jobs exist", () => {
    const s = summarizeMoneyStrip({
      openInvoices: [],
      cashCollectedWkCents: 0,
      rollup: { founderMinutes30d: 110, jobs30d: 10 },
      now: NOW,
    });
    expect(s.founderMinPerJob).toBe(11);
  });

  it("returns null founder-minutes-per-job when there is no rollup or zero jobs (render as —)", () => {
    expect(
      summarizeMoneyStrip({ openInvoices: [], cashCollectedWkCents: 0, rollup: null, now: NOW }).founderMinPerJob,
    ).toBeNull();
    expect(
      summarizeMoneyStrip({
        openInvoices: [],
        cashCollectedWkCents: 0,
        rollup: { founderMinutes30d: 40, jobs30d: 0 },
        now: NOW,
      }).founderMinPerJob,
    ).toBeNull();
  });

  it("leaves gross-margin null in this build (actuals land in cell 14 → render as —)", () => {
    const s = summarizeMoneyStrip({ openInvoices: [], cashCollectedWkCents: 0, rollup: null, now: NOW });
    expect(s.gmMtdPct).toBeNull();
  });
});

describe("estimateDecisionMinutes", () => {
  it("defaults to 3 minutes per card", () => {
    expect(estimateDecisionMinutes(4)).toBe(12);
  });

  it("is zero for an empty queue", () => {
    expect(estimateDecisionMinutes(0)).toBe(0);
  });

  it("honors a custom per-card estimate", () => {
    expect(estimateDecisionMinutes(5, 2)).toBe(10);
  });
});
