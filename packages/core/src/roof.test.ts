import { describe, it, expect } from "vitest";
import {
  effectiveRoofAge,
  canEnrichmentWriteReplacement,
  roofYearGapFill,
  formatRoofTypeLabel,
  ROOF_REPLACEMENT_SOURCE_VALUES,
} from "./roof";

const NOW = new Date("2026-07-09T00:00:00Z");

describe("effectiveRoofAge", () => {
  it("uses years since replacement when a replacement date is present", () => {
    expect(effectiveRoofAge({ lastRoofReplacementAt: "2015-06-01", yearBuilt: 1990 }, NOW)).toBe(11);
  });
  it("falls back to years since year_built when no replacement", () => {
    expect(effectiveRoofAge({ lastRoofReplacementAt: null, yearBuilt: 1990 }, NOW)).toBe(36);
  });
  it("is null when neither is known", () => {
    expect(effectiveRoofAge({ lastRoofReplacementAt: null, yearBuilt: null }, NOW)).toBeNull();
  });
});

describe("canEnrichmentWriteReplacement", () => {
  it("blocks enrichment from overwriting an owner_reported replacement", () => {
    expect(canEnrichmentWriteReplacement("owner_reported", "assessor")).toBe(false);
    expect(canEnrichmentWriteReplacement("owner_reported", "permit")).toBe(false);
  });
  it("allows writing when nothing is stored", () => {
    expect(canEnrichmentWriteReplacement(null, "assessor")).toBe(true);
  });
  it("allows a higher-precedence source to overwrite a lower one", () => {
    expect(canEnrichmentWriteReplacement("assessor", "permit")).toBe(true);
    expect(canEnrichmentWriteReplacement("permit", "assessor")).toBe(false);
  });
});

describe("roofYearGapFill", () => {
  it("preserves an existing (owner-edited) roof type / year — gap-fill only", () => {
    expect(
      roofYearGapFill({ roofType: "tile", yearBuilt: 2001 }, { roofType: "asphalt_shingle", yearBuilt: 1995 }),
    ).toEqual({});
  });
  it("fills only the null fields", () => {
    expect(
      roofYearGapFill({ roofType: null, yearBuilt: 2001 }, { roofType: "metal", yearBuilt: 1995 }),
    ).toEqual({ roofType: "metal" });
  });
});

describe("ROOF_REPLACEMENT_SOURCE_VALUES", () => {
  it("is the owner/permit/assessor vocabulary", () => {
    expect(ROOF_REPLACEMENT_SOURCE_VALUES).toEqual(["owner_reported", "permit", "assessor"]);
  });
});

describe("formatRoofTypeLabel", () => {
  it("maps each enum value to its human-readable label", () => {
    expect(formatRoofTypeLabel("asphalt_shingle")).toBe("Asphalt shingle");
    expect(formatRoofTypeLabel("tile")).toBe("Tile");
    expect(formatRoofTypeLabel("metal")).toBe("Metal");
    expect(formatRoofTypeLabel("flat_foam")).toBe("Flat-foam");
    expect(formatRoofTypeLabel("other")).toBe("Other");
  });
  it("returns null for null/undefined", () => {
    expect(formatRoofTypeLabel(null)).toBeNull();
    expect(formatRoofTypeLabel(undefined)).toBeNull();
  });
  it("falls back to the raw value for an unknown/legacy roof type", () => {
    expect(formatRoofTypeLabel("thatch")).toBe("thatch");
  });
});
