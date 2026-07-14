import { describe, it, expect } from "vitest";
import { depositRequirement, acceptanceReady } from "./acceptance-gate";

describe("depositRequirement", () => {
  it("is 50% of the accepted tier total by default", () => {
    const r = depositRequirement({ totalCents: 2_000_000, depositPercentageBps: 5000, stripeConnected: true });
    expect(r).toEqual({ required: true, amountCents: 1_000_000 });
  });
  it("is waived when the tenant sets 0% (tenant-config override)", () => {
    expect(depositRequirement({ totalCents: 2_000_000, depositPercentageBps: 0, stripeConnected: true }).required).toBe(false);
  });
  it("is waived when Stripe isn't connected — acceptance must not dead-end", () => {
    expect(depositRequirement({ totalCents: 2_000_000, depositPercentageBps: 5000, stripeConnected: false }).required).toBe(false);
  });
});

describe("acceptanceReady", () => {
  const signed = new Date("2026-07-13T00:00:00Z");
  it("fires only when signed AND deposit paid (when required)", () => {
    expect(acceptanceReady({ signedAt: signed, depositPaidAt: null, depositRequired: true })).toBe(false);
    expect(acceptanceReady({ signedAt: null, depositPaidAt: signed, depositRequired: true })).toBe(false);
    expect(acceptanceReady({ signedAt: signed, depositPaidAt: signed, depositRequired: true })).toBe(true);
  });
  it("signed alone suffices when no deposit is required", () => {
    expect(acceptanceReady({ signedAt: signed, depositPaidAt: null, depositRequired: false })).toBe(true);
  });
});
