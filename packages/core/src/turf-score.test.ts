import { describe, it, expect } from "vitest";
import { computeTurfScore, crossesTurfThreshold, TURF_THRESHOLD } from "./turf-score";

const NOW = new Date("2026-07-17T00:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);

describe("computeTurfScore", () => {
  it("is recent completions over parcel count (full weight within 24mo)", () => {
    const completions = Array.from({ length: 5 }, () => daysAgo(100));
    expect(computeTurfScore({ completions, parcelCount: 100, now: NOW })).toBeCloseTo(0.05);
  });

  it("decays older jobs — a ~36mo-old job counts about half", () => {
    // 1095d ≈ 36mo, halfway between the 24mo full line and the 48mo zero line.
    const score = computeTurfScore({ completions: [daysAgo(1095)], parcelCount: 1, now: NOW });
    expect(score).toBeGreaterThan(0.45);
    expect(score).toBeLessThan(0.55);
  });

  it("drops jobs older than 48 months to zero weight", () => {
    expect(computeTurfScore({ completions: [daysAgo(1600)], parcelCount: 1, now: NOW })).toBe(0);
  });

  it("is zero when there are no parcels (no divide-by-zero)", () => {
    expect(computeTurfScore({ completions: [daysAgo(10)], parcelCount: 0, now: NOW })).toBe(0);
  });

  it("is zero with no completions", () => {
    expect(computeTurfScore({ completions: [], parcelCount: 50, now: NOW })).toBe(0);
  });
});

describe("crossesTurfThreshold", () => {
  it("defaults to the 5% momentum line", () => {
    expect(TURF_THRESHOLD).toBe(0.05);
    expect(crossesTurfThreshold(0.05)).toBe(true);
    expect(crossesTurfThreshold(0.049)).toBe(false);
  });

  it("honors a per-tenant threshold", () => {
    expect(crossesTurfThreshold(0.08, 0.1)).toBe(false);
    expect(crossesTurfThreshold(0.12, 0.1)).toBe(true);
  });
});
