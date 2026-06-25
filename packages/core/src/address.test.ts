import { describe, expect, it } from "vitest";
import { parseCityFromAddress, formatCountyLabel, normalizeAddress } from "./address.js";

describe("parseCityFromAddress", () => {
  it("extracts the city before STATE ZIP", () => {
    expect(parseCityFromAddress("123 Main St, Mesa AZ 85201")).toBe("Mesa");
  });
  it("handles a comma between city and state", () => {
    expect(parseCityFromAddress("45 Oak Ave, Phoenix, AZ 85003")).toBe("Phoenix");
  });
  it("handles a multi-word city", () => {
    expect(parseCityFromAddress("9 Hill Rd, San Tan Valley AZ 85140")).toBe("San Tan Valley");
  });
  it("trims whitespace", () => {
    expect(parseCityFromAddress("1 A St,  Tempe  AZ 85281")).toBe("Tempe");
  });
  it("returns null when there is no comma", () => {
    expect(parseCityFromAddress("unknown")).toBeNull();
  });
  it("returns null for an empty string", () => {
    expect(parseCityFromAddress("")).toBeNull();
  });
  it("returns null when the segment has no state/zip tail", () => {
    expect(parseCityFromAddress("123 Main St, Apt 4")).toBeNull();
  });
});

describe("formatCountyLabel", () => {
  it("appends 'County' when the value lacks it (StormProof style)", () => {
    expect(formatCountyLabel("Maricopa")).toBe("Maricopa County");
  });
  it("does NOT double up when the value already ends with 'County' (Google style)", () => {
    expect(formatCountyLabel("Maricopa County")).toBe("Maricopa County");
  });
  it("detects an existing suffix case-insensitively and preserves the original", () => {
    expect(formatCountyLabel("maricopa county")).toBe("maricopa county");
  });
  it("trims surrounding whitespace", () => {
    expect(formatCountyLabel("  Pima  ")).toBe("Pima County");
  });
  it("returns null for null/empty/whitespace", () => {
    expect(formatCountyLabel(null)).toBeNull();
    expect(formatCountyLabel("")).toBeNull();
    expect(formatCountyLabel("   ")).toBeNull();
  });
});

describe("normalizeAddress", () => {
  it("lowercases, strips punctuation, and collapses whitespace", () => {
    expect(normalizeAddress("123 Main St., Mesa, AZ  85201")).toBe("123 main st mesa az 85201");
  });
  it("treats casing/spacing variants as equal", () => {
    expect(normalizeAddress("123  MAIN st")).toBe(normalizeAddress("123 Main St"));
  });
  it("returns empty string for null/undefined", () => {
    expect(normalizeAddress(null)).toBe("");
    expect(normalizeAddress(undefined)).toBe("");
  });
  it("Unicode-folds accented characters to ASCII (e.g. Cañon → canon)", () => {
    expect(normalizeAddress("Cañon Rd")).toContain("canon");
  });
});
