import { describe, expect, it } from "vitest";
import { parseCityFromAddress } from "./address.js";

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
