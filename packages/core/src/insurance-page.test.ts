import { describe, it, expect } from "vitest";
import { buildInsurancePanel, deductibleFraming, estimateTemplateVersion } from "./insurance-page";

describe("estimateTemplateVersion", () => {
  it("carrier-sourced estimates render the insurance template", () => {
    expect(estimateTemplateVersion({ source: "carrier", leadSource: null })).toBe("insurance-v1");
    expect(estimateTemplateVersion({ source: "roofr", leadSource: "insurance_agent" })).toBe("insurance-v1");
    expect(estimateTemplateVersion({ source: "roofr", leadSource: "referral" })).toBe("retail-v1");
  });
});

describe("deductibleFraming", () => {
  it("Colorado gets the SB38-explicit line", () => {
    const co = deductibleFraming(150_000, "CO")!;
    expect(co).toContain("$1,500");
    expect(co).toContain("Colorado law");
    expect(co.toLowerCase()).not.toContain("waive"); // we never even hint at it
  });
  it("other states get the honest generic framing", () => {
    const az = deductibleFraming(100_000, "AZ")!;
    expect(az).toContain("$1,000");
    expect(az).toContain("your responsibility");
  });
  it("no deductible on file → no framing line", () => {
    expect(deductibleFraming(null, "CO")).toBeNull();
  });
});

describe("buildInsurancePanel", () => {
  it("aligns scope to the claim ledger and renders upgrades as out-of-pocket add-ons", () => {
    const p = buildInsurancePanel({
      claim: { carrierName: "State Farm", claimNumber: "SF-123", rcvCents: 2_400_000, deductibleCents: 150_000 },
      state: "CO",
      upsells: [{ name: "Impact-resistant shingles", reason: "hail zone", unitPriceCents: 30000, quantity: 10 }],
    });
    expect(p).not.toBeNull();
    expect(p!.carrierLine).toContain("State Farm");
    expect(p!.approvedLine).toContain("$24,000");
    expect(p!.deductibleLine).toContain("$1,500");
    expect(p!.addOns[0]).toMatchObject({ name: "Impact-resistant shingles", totalCents: 300_000 });
  });
  it("no claim on file → no panel (the page falls back to retail scope rows)", () => {
    expect(buildInsurancePanel({ claim: null, state: "AZ", upsells: [] })).toBeNull();
  });
});
