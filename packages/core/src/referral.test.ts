import { describe, it, expect } from "vitest";
import { parseReferralConfig, referralFeeRequiresApproval } from "./referral";

describe("referral config", () => {
  it("defaults threshold to null (no gating)", () => {
    expect(parseReferralConfig(undefined).approvalThresholdCents).toBeNull();
    expect(parseReferralConfig({ approvalThresholdCents: 25000 }).approvalThresholdCents).toBe(25000);
  });
});
describe("referralFeeRequiresApproval", () => {
  const cfg = (t: number | null) => ({ approvalThresholdCents: t });
  it("no threshold → never requires approval (auto-approve)", () => {
    expect(referralFeeRequiresApproval(999999, cfg(null))).toBe(false);
  });
  it("over threshold requires approval; at/under does not", () => {
    expect(referralFeeRequiresApproval(30000, cfg(25000))).toBe(true);
    expect(referralFeeRequiresApproval(25000, cfg(25000))).toBe(false);
  });
});
