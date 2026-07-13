import { describe, it, expect } from "vitest";
import { computeBallparkCalibration } from "./calibration";

const pair = (est: number) => ({ lowCents: 600000, highCents: 900000, estimateCents: est });

describe("computeBallparkCalibration", () => {
  it("reports insufficient data below 20 pairs", () => {
    const r = computeBallparkCalibration([pair(700000), pair(1000000)]);
    expect(r).toEqual({ status: "insufficient", n: 2, report: "insufficient data — n=2" });
  });

  it("computes an inclusive hit-rate at or above 20 pairs", () => {
    // 20 pairs: 15 inside [600k,900k] (incl. boundaries), 5 outside.
    const inside = Array.from({ length: 13 }, () => pair(750000));
    const boundaries = [pair(600000), pair(900000)]; // inclusive → count as hits
    const outside = Array.from({ length: 5 }, () => pair(950000));
    const r = computeBallparkCalibration([...inside, ...boundaries, ...outside]);
    if (r.status !== "active") throw new Error("expected active status");
    expect(r.n).toBe(20);
    expect(r.hitRate).toBeCloseTo(0.75, 5);
    expect(r.report).toContain("75%");
    expect(r.report).toContain("n=20");
  });
});
