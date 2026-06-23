import { describe, it, expect } from "vitest";
import { DEFAULT_LEAD_SOURCES, mergeLeadSources } from "./lead-sources";

describe("lead sources", () => {
  it("ships a non-empty default list including referral", () => {
    expect(DEFAULT_LEAD_SOURCES.length).toBeGreaterThan(5);
    expect(DEFAULT_LEAD_SOURCES.some((s) => s.value === "referral")).toBe(true);
  });
  it("appends custom sources, skipping case-insensitive duplicates", () => {
    const merged = mergeLeadSources(["Home Show", "REFERRAL", "Home Show"]);
    const values = merged.map((s) => s.value);
    expect(values).toContain("Home Show");
    expect(values.filter((v) => v.toLowerCase() === "home show").length).toBe(1);
    expect(values.filter((v) => v.toLowerCase() === "referral").length).toBe(1);
  });
  it("handles null/undefined custom list", () => {
    expect(mergeLeadSources(null).length).toBe(DEFAULT_LEAD_SOURCES.length);
  });
});
