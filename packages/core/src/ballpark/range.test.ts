import { describe, it, expect } from "vitest";
import { ballparkRange, perSquareFromPriceBook, subjectToInspectionLine } from "./range";
import { parseBallparkConfig } from "./config";
import { DEFAULT_PRICE_BOOK } from "../price-book";

const sell = perSquareFromPriceBook(DEFAULT_PRICE_BOOK); // { sellCents: 27500, costCents: 22775 }
const on = parseBallparkConfig({ enabled: true });

describe("perSquareFromPriceBook", () => {
  it("sums only the per-square sell and cost items", () => {
    expect(sell).toEqual({ sellCents: 27500, costCents: 22775 });
  });
});

describe("ballparkRange", () => {
  it("returns a margin-floored range with confidence from a measured size", () => {
    const r = ballparkRange({ size: { squares: 25, basis: "measured" }, sell, config: on, isClaim: false });
    // good=687500, low_raw=618750 clamps up to margin floor 683250; high=859375×1.1=945313
    expect(r).toEqual({ lowCents: 683250, highCents: 945313, confidence: "high", basis: "measured roof" });
  });

  it("never quotes on an insurance-claim intent", () => {
    expect(ballparkRange({ size: { squares: 25, basis: "measured" }, sell, config: on, isClaim: true })).toBeNull();
  });

  it("returns null when the feature is disabled", () => {
    const off = parseBallparkConfig({ enabled: false });
    expect(ballparkRange({ size: { squares: 25, basis: "measured" }, sell, config: off, isClaim: false })).toBeNull();
  });

  it("returns null below the confidence floor, and quotes once the floor allows it", () => {
    // default floor = assessor; a footprint basis is below it
    expect(ballparkRange({ size: { squares: 25, basis: "footprint" }, sell, config: on, isClaim: false })).toBeNull();
    const loose = parseBallparkConfig({ enabled: true, confidenceFloor: "footprint" });
    const r = ballparkRange({ size: { squares: 25, basis: "footprint" }, sell, config: loose, isClaim: false });
    expect(r?.confidence).toBe("low");
    expect(r?.basis).toBe("footprint estimate");
  });

  it("returns null with no size", () => {
    expect(ballparkRange({ size: null, sell, config: on, isClaim: false })).toBeNull();
  });

  it("always orders low below high", () => {
    const r = ballparkRange({ size: { squares: 18, basis: "assessor" }, sell, config: on, isClaim: false });
    expect(r!.lowCents).toBeLessThan(r!.highCents);
    expect(r!.confidence).toBe("medium");
  });
});

describe("subjectToInspectionLine", () => {
  it("renders the mandated range + free-inspection framing", () => {
    expect(subjectToInspectionLine(683250, 945313)).toBe(
      "typically runs $6,833–$9,453 — the exact number comes from a free inspection",
    );
  });
});
