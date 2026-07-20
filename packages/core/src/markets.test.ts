import { describe, it, expect } from "vitest";
import { parseMarkets } from "./markets";

describe("parseMarkets", () => {
  it("defaults to no markets", () => {
    expect(parseMarkets(undefined)).toEqual([]);
    expect(parseMarkets(null)).toEqual([]);
    expect(parseMarkets("AZ")).toEqual([]);
    expect(parseMarkets({})).toEqual([]);
  });

  it("accepts labeled IANA timezones", () => {
    expect(
      parseMarkets([
        { label: "AZ", timezone: "America/Phoenix" },
        { label: "CO", timezone: "America/Denver" },
      ]),
    ).toEqual([
      { label: "AZ", timezone: "America/Phoenix" },
      { label: "CO", timezone: "America/Denver" },
    ]);
  });

  it("drops entries with invalid timezones or empty labels (hostile settings input)", () => {
    expect(
      parseMarkets([
        { label: "AZ", timezone: "America/Nowhere" },
        { label: "", timezone: "America/Denver" },
        { label: "OK", timezone: "America/Chicago" },
        { label: 42, timezone: "America/Denver" },
        "junk",
      ]),
    ).toEqual([{ label: "OK", timezone: "America/Chicago" }]);
  });

  it("trims and caps labels; caps the list at 6 markets", () => {
    expect(parseMarkets([{ label: "  Phoenix Metro Area West  ", timezone: "America/Phoenix" }])).toEqual([
      { label: "Phoenix Metro", timezone: "America/Phoenix" },
    ]);
    const many = Array.from({ length: 9 }, (_, i) => ({ label: `M${i}`, timezone: "America/Denver" }));
    expect(parseMarkets(many)).toHaveLength(6);
  });
});
