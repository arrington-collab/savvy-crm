import { describe, expect, it } from "vitest";
import { parseCityFromAddress, formatCountyLabel, normalizeAddress, expandAddressForSpeech } from "./address.js";

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
  it("lowercases, trims, and collapses whitespace", () => {
    expect(normalizeAddress("  123   Main   St  ")).toBe("123 main st");
  });
  it("standardizes common suffix abbreviations", () => {
    expect(normalizeAddress("123 Main Street")).toBe("123 main st");
    expect(normalizeAddress("5 Oak Avenue")).toBe("5 oak ave");
    expect(normalizeAddress("9 Elm Drive")).toBe("9 elm dr");
  });
  it("strips punctuation so equivalent addresses match", () => {
    expect(normalizeAddress("123 Main St.")).toBe(normalizeAddress("123 Main Street"));
  });
});

describe("expandAddressForSpeech", () => {
  it("expands directionals and street suffixes for TTS", () => {
    expect(expandAddressForSpeech("1542 E Mountain View Rd")).toBe("1542 East Mountain View Road");
  });
  it("handles a trailing period and other suffixes", () => {
    expect(expandAddressForSpeech("45 N Oak Ave., Phoenix AZ")).toBe("45 North Oak Avenue, Phoenix AZ");
  });
  it("leaves numbers and ordinary words untouched", () => {
    expect(expandAddressForSpeech("100 Main Boulevard")).toBe("100 Main Boulevard");
  });
  it("returns empty string for nullish input", () => {
    expect(expandAddressForSpeech(null)).toBe("");
  });
});
