import { describe, it, expect } from "vitest";
import { sumCardValues } from "./pipeline-metrics";

describe("sumCardValues", () => {
  it("sums valueEstimate across cards, treating null as 0", () => {
    expect(sumCardValues([{ valueEstimate: 1000 }, { valueEstimate: null }, { valueEstimate: 2500 }])).toBe(3500);
  });
  it("returns 0 for an empty list", () => {
    expect(sumCardValues([])).toBe(0);
  });
});
