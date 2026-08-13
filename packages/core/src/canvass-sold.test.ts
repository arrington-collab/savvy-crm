import { describe, it, expect } from "vitest";
import {
  soldDedupeKey,
  isResidentialType,
  soldExpiresAt,
  DEFAULT_SOLD_CONFIG,
  soldConfigFrom,
} from "./canvass-sold";

describe("soldDedupeKey", () => {
  it("prefers MLS when present", () => {
    expect(soldDedupeKey({ mls: "6712345", address: "123 Main St", zip: "85001" }))
      .toBe("mls:6712345");
  });

  it("normalizes MLS case and surrounding space", () => {
    expect(soldDedupeKey({ mls: "  ab-123 ", address: "x", zip: "1" }))
      .toBe(soldDedupeKey({ mls: "AB-123", address: "y", zip: "2" }));
  });

  it("falls back to address+zip when MLS is missing or blank", () => {
    const noMls = soldDedupeKey({ mls: null, address: "123 Main St", zip: "85001" });
    const blank = soldDedupeKey({ mls: "   ", address: "123 Main St", zip: "85001" });
    expect(noMls).toBe("addr:123 MAIN ST|85001");
    expect(blank).toBe(noMls);
  });

  // The real-world case: the same house arriving from two weekly pulls with
  // cosmetically different formatting must collapse to one row.
  it("treats cosmetic address differences as the same home", () => {
    const a = soldDedupeKey({ mls: null, address: "123 Main St.", zip: "85001" });
    const b = soldDedupeKey({ mls: null, address: "  123   MAIN ST  ", zip: "85001" });
    expect(a).toBe(b);
  });

  it("keeps genuinely different homes distinct", () => {
    const a = soldDedupeKey({ mls: null, address: "123 Main St", zip: "85001" });
    const b = soldDedupeKey({ mls: null, address: "125 Main St", zip: "85001" });
    const sameStreetOtherZip = soldDedupeKey({ mls: null, address: "123 Main St", zip: "85032" });
    expect(a).not.toBe(b);
    expect(a).not.toBe(sameStreetOtherZip);
  });
});

describe("isResidentialType", () => {
  it("keeps the five residential types", () => {
    for (const t of [
      "Single Family Residential",
      "Townhouse",
      "Condo/Co-op",
      "Mobile/Manufactured Home",
      "Multi-Family (2-4 Unit)",
    ]) {
      expect(isResidentialType(t)).toBe(true);
    }
  });

  it("drops vacant land — nobody lives there to knock", () => {
    expect(isResidentialType("Vacant Land")).toBe(false);
    expect(isResidentialType("vacant land")).toBe(false);
  });

  it("drops unknown or missing types rather than guessing", () => {
    expect(isResidentialType("Commercial")).toBe(false);
    expect(isResidentialType(null)).toBe(false);
    expect(isResidentialType("")).toBe(false);
  });
});

describe("soldExpiresAt", () => {
  it("adds the configured window to the sale date", () => {
    expect(soldExpiresAt("2026-01-01", 90)).toBe("2026-04-01");
  });

  it("crosses month boundaries correctly", () => {
    expect(soldExpiresAt("2026-01-31", 1)).toBe("2026-02-01");
  });

  it("crosses year boundaries correctly", () => {
    expect(soldExpiresAt("2026-12-25", 10)).toBe("2027-01-04");
  });

  it("handles leap years", () => {
    expect(soldExpiresAt("2028-02-28", 1)).toBe("2028-02-29");
  });

  // Guards against a UTC/local drift bug shifting every expiry by a day.
  it("is stable regardless of intra-day time", () => {
    expect(soldExpiresAt("2026-06-15", 90)).toBe("2026-09-13");
  });
});

describe("soldConfigFrom", () => {
  it("defaults to Maricopa County and a 90-day window", () => {
    expect(DEFAULT_SOLD_CONFIG.regionId).toBe(220);
    expect(DEFAULT_SOLD_CONFIG.regionType).toBe(5);
    expect(DEFAULT_SOLD_CONFIG.expiryDays).toBe(90);
  });

  // Tenants without the key must stay switched off — existing roofing tenants
  // should not silently start collecting sold pins.
  it("is disabled when the tenant has no canvassSold settings", () => {
    expect(soldConfigFrom({}).enabled).toBe(false);
    expect(soldConfigFrom({ canvassSold: undefined }).enabled).toBe(false);
  });

  it("enables and merges partial tenant overrides onto the defaults", () => {
    const c = soldConfigFrom({ canvassSold: { enabled: true, expiryDays: 30 } });
    expect(c.enabled).toBe(true);
    expect(c.expiryDays).toBe(30);
    expect(c.regionId).toBe(220);
  });

  it("ignores malformed values instead of trusting them", () => {
    const c = soldConfigFrom({ canvassSold: { enabled: true, expiryDays: -5 } });
    expect(c.expiryDays).toBe(DEFAULT_SOLD_CONFIG.expiryDays);
  });
});
