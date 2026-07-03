import { describe, it, expect } from "vitest";
import { dHash, hammingDistance, parsePhotoQcConfig, assessPhotoQc } from "./photo-qc";

// helper: a 8x9 matrix that strictly increases left→right so every adjacent
// comparison is "left < right" → all 64 bits 0.
const ramp = () => Array.from({ length: 8 }, () => Array.from({ length: 9 }, (_, c) => c * 10));

describe("dHash", () => {
  it("produces a 16-hex-char (64-bit) string", () => {
    expect(dHash(ramp())).toMatch(/^[0-9a-f]{16}$/);
  });
  it("is identical for identical input and differs for a changed pixel", () => {
    const a = ramp();
    expect(dHash(a)).toBe(dHash(ramp()));
    const b = ramp(); b[0] = [90, 80, 70, 60, 50, 40, 30, 20, 10]; // reverse row 0 → those bits flip
    expect(dHash(b)).not.toBe(dHash(a));
  });
});

describe("hammingDistance", () => {
  it("counts differing bits between two hex hashes", () => {
    expect(hammingDistance("0000000000000000", "0000000000000000")).toBe(0);
    expect(hammingDistance("0000000000000000", "000000000000000f")).toBe(4); // 0xf = 1111
    expect(hammingDistance("ffffffffffffffff", "0000000000000000")).toBe(64);
  });
});

describe("parsePhotoQcConfig", () => {
  it("defaults enabled true, dupeMaxDistance 10", () => {
    expect(parsePhotoQcConfig(undefined)).toEqual({ enabled: true, dupeMaxDistance: 10 });
  });
  it("respects overrides", () => {
    expect(parsePhotoQcConfig({ enabled: false, dupeMaxDistance: 4 })).toEqual({ enabled: false, dupeMaxDistance: 4 });
  });
});

describe("assessPhotoQc", () => {
  it("passes a usable, on-category, unique photo", () => {
    const ok = { usable: true, quality: "ok" as const, depictsCategory: true, reason: "" };
    expect(assessPhotoQc({ vision: ok, duplicateOf: null }).flagged).toBe(false);
  });
  it("flags unusable, wrong-category, and duplicate photos with reasons", () => {
    const ok = { usable: true, quality: "ok" as const, depictsCategory: true, reason: "" };
    expect(assessPhotoQc({ vision: { ...ok, usable: false, quality: "blurry" }, duplicateOf: null }))
      .toEqual({ flagged: true, reasons: { quality: "blurry" } });
    expect(assessPhotoQc({ vision: { ...ok, depictsCategory: false }, duplicateOf: null }).reasons.wrongCategory).toBe(true);
    expect(assessPhotoQc({ vision: ok, duplicateOf: "doc-9" }).reasons.duplicateOf).toBe("doc-9");
  });
  it('maps quality "ok" + usable=false to reasons.quality="unusable"', () => {
    const ok = { usable: true, quality: "ok" as const, depictsCategory: true, reason: "" };
    expect(
      assessPhotoQc({ vision: { ...ok, usable: false }, duplicateOf: null }).reasons.quality
    ).toBe("unusable");
  });
});
