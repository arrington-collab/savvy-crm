import { describe, it, expect } from "vitest";
import { bucketArAging, summarizeVerification } from "./money-aging";

const NOW = new Date("2026-07-04T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

describe("bucketArAging", () => {
  it("puts invoices due within 30 days (or not yet due) in the current bucket", () => {
    const a = bucketArAging({
      openInvoices: [
        { amountDueCents: 10_000, amountPaidCents: 0, dueAt: daysAgo(10) }, // 10d overdue
        { amountDueCents: 5_000, amountPaidCents: 0, dueAt: daysAgo(-5) }, // due in future
        { amountDueCents: 3_000, amountPaidCents: 0, dueAt: null }, // no due date
      ],
      now: NOW,
    });
    expect(a.current.cents).toBe(18_000);
    expect(a.current.count).toBe(3);
    expect(a.d31_60.cents).toBe(0);
    expect(a.d61plus.cents).toBe(0);
  });

  it("buckets 31–60 and 61+ day overdue invoices separately", () => {
    const a = bucketArAging({
      openInvoices: [
        { amountDueCents: 8_000, amountPaidCents: 0, dueAt: daysAgo(45) }, // 31–60
        { amountDueCents: 14_900, amountPaidCents: 0, dueAt: daysAgo(70) }, // 61+
      ],
      now: NOW,
    });
    expect(a.d31_60.cents).toBe(8_000);
    expect(a.d61plus.cents).toBe(14_900);
    expect(a.totalCents).toBe(22_900);
  });

  it("uses outstanding balance (due minus paid) and drops fully-paid invoices", () => {
    const a = bucketArAging({
      openInvoices: [
        { amountDueCents: 10_000, amountPaidCents: 6_000, dueAt: daysAgo(70) }, // 4,000 outstanding
        { amountDueCents: 5_000, amountPaidCents: 5_000, dueAt: daysAgo(70) }, // paid → dropped
      ],
      now: NOW,
    });
    expect(a.d61plus.cents).toBe(4_000);
    expect(a.d61plus.count).toBe(1);
    expect(a.totalCents).toBe(4_000);
  });

  it("treats the 30 and 60 day edges as the lower bucket", () => {
    const a = bucketArAging({
      openInvoices: [
        { amountDueCents: 1_000, amountPaidCents: 0, dueAt: daysAgo(30) }, // current
        { amountDueCents: 2_000, amountPaidCents: 0, dueAt: daysAgo(60) }, // 31–60
      ],
      now: NOW,
    });
    expect(a.current.cents).toBe(1_000);
    expect(a.d31_60.cents).toBe(2_000);
    expect(a.d61plus.cents).toBe(0);
  });
});

describe("summarizeVerification", () => {
  it("counts each status and flags all-green when there are no failures", () => {
    const s = summarizeVerification([
      { checkKey: "finance.invoice_math", status: "pass" },
      { checkKey: "finance.commissions", status: "pass" },
    ]);
    expect(s.total).toBe(2);
    expect(s.passed).toBe(2);
    expect(s.failed).toBe(0);
    expect(s.allGreen).toBe(true);
  });

  it("is not all-green when any check failed", () => {
    const s = summarizeVerification([
      { checkKey: "finance.invoice_math", status: "pass" },
      { checkKey: "finance.commissions", status: "fail" },
      { checkKey: "comms.no_double_send", status: "stale" },
    ]);
    expect(s.failed).toBe(1);
    expect(s.stale).toBe(1);
    expect(s.allGreen).toBe(false);
  });

  it("is not all-green with no runs at all (nothing proven yet)", () => {
    const s = summarizeVerification([]);
    expect(s.total).toBe(0);
    expect(s.allGreen).toBe(false);
  });
});
