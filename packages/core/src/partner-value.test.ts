import { describe, it, expect } from "vitest";
import { parsePartnerLedgerConfig } from "./partner-ledger";
import { assignPartnerGrade, funnelConversions, medianDays, rollupByClass } from "./partner-value";

describe("partner ledger config — grade thresholds (Library config, not code)", () => {
  it("defaults: A needs net > $5k and a win; C needs 5+ referrals with 0 wins", () => {
    const cfg = parsePartnerLedgerConfig(undefined);
    expect(cfg.inspectionStandardCostCents).toBe(20000); // slice 2 default preserved
    expect(cfg.gradeANetCentsMin).toBe(500000);
    expect(cfg.gradeCMinReferrals).toBe(5);
  });

  it("tenant overrides parse; junk falls back per-field", () => {
    const cfg = parsePartnerLedgerConfig({ gradeANetCentsMin: 1000000, gradeCMinReferrals: "junk" });
    expect(cfg.gradeANetCentsMin).toBe(1000000);
    expect(cfg.gradeCMinReferrals).toBe(5);
  });
});

describe("assignPartnerGrade", () => {
  const cfg = parsePartnerLedgerConfig(undefined);

  it("A = net over threshold AND at least one win", () => {
    expect(assignPartnerGrade({ netCents: 600000, wins: 1, sent: 3 }, cfg)).toBe("A");
  });

  it("big net without a win is NOT an A", () => {
    expect(assignPartnerGrade({ netCents: 900000, wins: 0, sent: 2 }, cfg)).toBe("B");
  });

  it("C = enough referrals with zero wins", () => {
    expect(assignPartnerGrade({ netCents: -40000, wins: 0, sent: 5 }, cfg)).toBe("C");
  });

  it("few referrals with no wins yet is a B (too early to judge)", () => {
    expect(assignPartnerGrade({ netCents: -20000, wins: 0, sent: 2 }, cfg)).toBe("B");
  });

  it("a win with modest net is a B", () => {
    expect(assignPartnerGrade({ netCents: 100000, wins: 1, sent: 6 }, cfg)).toBe("B");
  });
});

describe("funnelConversions", () => {
  it("computes stage-over-sent percentages", () => {
    expect(funnelConversions({ sent: 10, inspected: 6, estimated: 4, won: 2 })).toEqual({
      inspectedPct: 60, estimatedPct: 40, wonPct: 20,
    });
  });
  it("zero sent → nulls, never NaN", () => {
    expect(funnelConversions({ sent: 0, inspected: 0, estimated: 0, won: 0 })).toEqual({
      inspectedPct: null, estimatedPct: null, wonPct: null,
    });
  });
});

describe("medianDays", () => {
  it("odd and even counts", () => {
    expect(medianDays([10, 2, 7])).toBe(7);
    expect(medianDays([2, 10, 4, 8])).toBe(6);
  });
  it("empty → null", () => {
    expect(medianDays([])).toBe(null);
  });
});

describe("rollupByClass", () => {
  it("sums per-class and exposes the realtor-vs-insurance gap", () => {
    const rows = [
      { class: "realtor", sent: 10, won: 1, collectedGmCents: 100000, cost12moCents: 80000, netCents: 20000 },
      { class: "realtor", sent: 6, won: 0, collectedGmCents: 0, cost12moCents: 40000, netCents: -40000 },
      { class: "insurance_agent", sent: 4, won: 3, collectedGmCents: 900000, cost12moCents: 50000, netCents: 850000 },
    ];
    const roll = rollupByClass(rows);
    expect(roll).toEqual([
      { class: "insurance_agent", partners: 1, sent: 4, won: 3, collectedGmCents: 900000, cost12moCents: 50000, netCents: 850000 },
      { class: "realtor", partners: 2, sent: 16, won: 1, collectedGmCents: 100000, cost12moCents: 120000, netCents: -20000 },
    ]); // sorted by net desc
  });
});
