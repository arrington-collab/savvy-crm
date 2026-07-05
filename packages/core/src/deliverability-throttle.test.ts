import { describe, it, expect } from "vitest";
import { shouldThrottleOutbound, MIN_SAMPLE } from "./deliverability-throttle";

describe("shouldThrottleOutbound", () => {
  it("does not throttle below the minimum sample", () => {
    expect(shouldThrottleOutbound({ delivered: 1, failed: 9, undelivered: 0 })).toBe(false); // 10 < MIN_SAMPLE
  });
  it("throttles when rate below floor with enough sample", () => {
    expect(shouldThrottleOutbound({ delivered: 10, failed: 15, undelivered: 5 })).toBe(true); // 30 samples, 33%
  });
  it("does not throttle a healthy rate", () => {
    expect(shouldThrottleOutbound({ delivered: 95, failed: 3, undelivered: 2 })).toBe(false);
  });
});
