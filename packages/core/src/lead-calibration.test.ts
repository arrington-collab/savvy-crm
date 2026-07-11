import { describe, it, expect } from "vitest";
import { computeCalibration, buildCalibrationLine, CALIBRATION_MIN_RESOLVED } from "./lead-calibration";
import type { CalibrationInput } from "./lead-calibration";

const many = (n: number, band: CalibrationInput["band"], outcome: CalibrationInput["outcome"]): CalibrationInput[] =>
  Array.from({ length: n }, () => ({ band, outcome }));

describe("computeCalibration — slice 5 calibration report (no ML)", () => {
  it("reports insufficient data below the resolved-lead threshold", () => {
    const r = computeCalibration([...many(3, "hot", "won")]);
    expect(r.status).toBe("insufficient");
    if (r.status === "insufficient") {
      expect(r.n).toBe(3);
      expect(r.message).toBe("insufficient data — n=3");
    }
  });

  it("threshold is 50 resolved leads", () => {
    expect(CALIBRATION_MIN_RESOLVED).toBe(50);
    expect(computeCalibration(many(49, "hot", "won")).status).toBe("insufficient");
    expect(computeCalibration(many(50, "hot", "won")).status).toBe("active");
  });

  it("buckets outcomes per band and computes a won-rate once active", () => {
    const leads = [
      ...many(20, "hot", "won"), ...many(5, "hot", "lost"),   // hot: 25 total, 0.8 won
      ...many(10, "warm", "won"), ...many(10, "warm", "lost"), // warm: 20 total, 0.5 won
      ...many(2, "cold", "won"), ...many(8, "cold", "lost"),   // cold: 10 total, 0.2 won
    ];
    const r = computeCalibration(leads);
    expect(r.status).toBe("active");
    if (r.status === "active") {
      expect(r.n).toBe(55);
      expect(r.bands.hot).toMatchObject({ won: 20, lost: 5, total: 25 });
      expect(r.bands.hot.wonRate).toBeCloseTo(0.8, 10);
      expect(r.bands.warm.wonRate).toBeCloseTo(0.5, 10);
      expect(r.bands.cold.wonRate).toBeCloseTo(0.2, 10);
      expect(r.bands.cool).toMatchObject({ total: 0, wonRate: 0 });
    }
  });

  it("counts booked as its own outcome (not won/lost)", () => {
    const leads = [...many(30, "warm", "booked"), ...many(25, "warm", "won")];
    const r = computeCalibration(leads);
    if (r.status === "active") {
      expect(r.bands.warm).toMatchObject({ booked: 30, won: 25, lost: 0, total: 55 });
      expect(r.bands.warm.wonRate).toBeCloseTo(25 / 55, 10);
    }
  });
});

describe("buildCalibrationLine — digest surfacing (only when active)", () => {
  it("returns null while insufficient (nothing to surface)", () => {
    expect(buildCalibrationLine(computeCalibration(many(10, "hot", "won")))).toBeNull();
  });

  it("summarizes won-rate per populated band once active", () => {
    const leads = [
      ...many(20, "hot", "won"), ...many(5, "hot", "lost"),   // 0.8
      ...many(10, "warm", "won"), ...many(10, "warm", "lost"), // 0.5
      ...many(2, "cold", "won"), ...many(8, "cold", "lost"),   // 0.2
    ];
    const line = buildCalibrationLine(computeCalibration(leads));
    // cool has no leads → omitted; bands stay in hot→cold order.
    expect(line).toBe("Lead-score calibration (n=55): Hot 80% · Warm 50% · Cold 20% won-rate");
  });
});
