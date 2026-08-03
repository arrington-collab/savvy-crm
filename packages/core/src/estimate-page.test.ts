import { describe, it, expect } from "vitest";
import { buildEstimatePageModel } from "./estimate-page";
import type { TierEstimate } from "./tier-pricing";

const tier = (t: Partial<TierEstimate> & { tier: TierEstimate["tier"] }): TierEstimate => ({
  productName: "IKO Dynasty",
  manufacturer: "IKO",
  warrantyText: "IKO limited lifetime warranty.",
  recommended: false,
  lineItems: [],
  subtotalCents: 2_000_000,
  needsCosts: [],
  marginFloorViolations: [],
  wastePctUsed: 1000,
  pitchTierApplied: "0+",
  ...t,
});

const BASE = {
  companyName: "Northwind Roofing",
  customerName: "Jordan Homeowner",
  address: "12 Oak Ln, Phoenix, AZ",
  sentAt: new Date("2026-07-01T17:00:00Z"),
  createdAt: new Date("2026-06-30T17:00:00Z"),
  now: new Date("2026-07-10T17:00:00Z"),
  validityDays: 30,
  tiers: [
    tier({ tier: "good", productName: "IKO Cambridge", subtotalCents: 1_800_000 }),
    tier({ tier: "better", recommended: true }),
    tier({ tier: "best", productName: "TAMKO Titan XT", manufacturer: "TAMKO", subtotalCents: 2_400_000 }),
  ],
  lineItemKeys: ["tear-off", "ice-water-shield", "drip-edge", "ridge-vent", "underlayment"],
  licenses: [
    { state: "AZ", city: null, licenseNumber: "ROC-345678" },
    { state: "CO", city: "Denver", licenseNumber: "D-1122" },
  ],
  palettes: { good: [{ name: "Dual Black", hex: "#2b2b2b" }], better: [], best: [] },
  financingEnabled: false,
};

describe("buildEstimatePageModel", () => {
  it("computes validity from sentAt + validityDays and flags expiry", () => {
    const m = buildEstimatePageModel(BASE);
    expect(m.validUntil.toISOString().slice(0, 10)).toBe("2026-07-31");
    expect(m.expired).toBe(false);

    const expired = buildEstimatePageModel({ ...BASE, now: new Date("2026-08-02T00:00:00Z") });
    expect(expired.expired).toBe(true);
  });

  it("falls back to createdAt when the estimate was never sent", () => {
    const m = buildEstimatePageModel({ ...BASE, sentAt: null });
    expect(m.validUntil.toISOString().slice(0, 10)).toBe("2026-07-30");
  });

  it("derives what's-included rows from line items plus the always-included promises", () => {
    const m = buildEstimatePageModel(BASE);
    const keys = m.included.map((r) => r.key);
    expect(keys).toContain("tear-off");
    expect(keys).toContain("ice-water");
    expect(keys).toContain("drip-edge");
    expect(keys).toContain("ventilation");
    // always included, regardless of line items
    expect(keys).toContain("cleanup");
    expect(keys).toContain("permits");
    expect(keys).toContain("workmanship");
    // absent scope never claimed
    expect(keys).not.toContain("valley");
  });

  it("orders tiers good→better→best with bullets and the recommended badge", () => {
    const m = buildEstimatePageModel(BASE);
    expect(m.tiers.map((t) => t.tier)).toEqual(["good", "better", "best"]);
    const better = m.tiers[1]!;
    expect(better.recommended).toBe(true);
    expect(better.bullets.join(" ")).toContain("IKO");
    expect(better.colors).toEqual([]);
    expect(m.tiers[0]!.colors).toEqual([{ name: "Dual Black", hex: "#2b2b2b" }]);
  });

  it("renders trust lines from the license matrix and hides the monthly toggle while financing is dormant", () => {
    const m = buildEstimatePageModel(BASE);
    expect(m.trustLines).toContain("AZ license ROC-345678");
    expect(m.trustLines).toContain("Denver, CO license D-1122");
    expect(m.showMonthlyToggle).toBe(false);
  });
});
