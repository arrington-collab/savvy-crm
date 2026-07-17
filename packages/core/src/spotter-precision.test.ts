import { describe, it, expect } from "vitest";
import {
  computeSpotterPrecision,
  SPOTTER_MIN_SAMPLES,
  SPOTTER_PRECISION_FLOOR,
} from "./spotter-precision";

const sample = (tagged: string, truth: string) => ({ tagged, truth } as never);

describe("computeSpotterPrecision", () => {
  it("scores agreement between a spotter's tags and inspection ground truth", () => {
    const p = computeSpotterPrecision("Dana", [
      sample("wood_shake", "wood_shake"),
      sample("clay_tile", "clay_tile"),
      sample("clay_tile", "concrete_tile"), // wrong
    ]);
    expect(p.spotterName).toBe("Dana");
    expect(p.samples).toBe(3);
    expect(p.correct).toBe(2);
    expect(p.precision).toBeCloseTo(2 / 3);
  });

  it("raises a coaching flag for a low scorer with enough samples", () => {
    const samples = Array.from({ length: SPOTTER_MIN_SAMPLES }, (_, i) =>
      sample("clay_tile", i === 0 ? "clay_tile" : "asphalt_shingle"), // 1/5 correct = 0.2
    );
    const p = computeSpotterPrecision("Lee", samples);
    expect(p.precision).toBeLessThan(SPOTTER_PRECISION_FLOOR);
    expect(p.coachingFlag).toBe(true);
  });

  it("does not coach an accurate spotter", () => {
    const samples = Array.from({ length: SPOTTER_MIN_SAMPLES }, () => sample("metal", "metal"));
    const p = computeSpotterPrecision("Kim", samples);
    expect(p.precision).toBe(1);
    expect(p.coachingFlag).toBe(false);
  });

  it("never coaches below the minimum sample size (not enough evidence)", () => {
    const p = computeSpotterPrecision("New", [sample("clay_tile", "metal")]); // 0% but only 1 sample
    expect(p.precision).toBe(0);
    expect(p.coachingFlag).toBe(false);
  });

  it("handles a spotter with no matched samples", () => {
    const p = computeSpotterPrecision("Ghost", []);
    expect(p).toMatchObject({ samples: 0, correct: 0, precision: 0, coachingFlag: false });
  });
});
