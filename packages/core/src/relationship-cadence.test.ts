import { describe, it, expect } from "vitest";
import {
  parseRelationshipCadenceConfig,
  nextHolidayDate,
  roofiversaryDate,
  DEFAULT_RELATIONSHIP_COPY,
} from "./relationship-cadence";

describe("parseRelationshipCadenceConfig", () => {
  it("defaults: enabled, Thanksgiving holiday, rubric-safe copy", () => {
    const cfg = parseRelationshipCadenceConfig(undefined);
    expect(cfg.enabled).toBe(true);
    expect(cfg.holiday).toBe("thanksgiving");
    expect(cfg.copy.checkin30d.length).toBeGreaterThan(0);
    expect(cfg.copy.roofiversary.length).toBeGreaterThan(0);
    expect(cfg.copy.holidayCard.length).toBeGreaterThan(0);
  });

  it("accepts tenant overrides (holiday + copy)", () => {
    const cfg = parseRelationshipCadenceConfig({
      holiday: "christmas",
      copy: { checkin30d: "Custom check-in {{firstName}}" },
    });
    expect(cfg.holiday).toBe("christmas");
    expect(cfg.copy.checkin30d).toBe("Custom check-in {{firstName}}");
    expect(cfg.copy.roofiversary).toBe(DEFAULT_RELATIONSHIP_COPY.roofiversary);
  });
});

describe("content rubric — every touch is gratitude, useful info, or a free offer", () => {
  it("default copy never sells: no discounts, no 'just checking in'", () => {
    for (const body of Object.values(DEFAULT_RELATIONSHIP_COPY)) {
      const lower = body.toLowerCase();
      expect(lower).not.toContain("discount");
      expect(lower).not.toContain("% off");
      expect(lower).not.toContain("just checking in");
      expect(lower).not.toContain("limited time");
    }
  });
});

describe("nextHolidayDate", () => {
  it("Thanksgiving is the 4th Thursday of November (UTC)", () => {
    // After Jan 2026 → Thanksgiving 2026 = Nov 26.
    const d = nextHolidayDate("thanksgiving", new Date("2026-01-15T00:00:00Z"));
    expect(d.toISOString().slice(0, 10)).toBe("2026-11-26");
    expect(d.getUTCDay()).toBe(4); // Thursday
  });

  it("rolls to next year when the holiday has passed", () => {
    const d = nextHolidayDate("thanksgiving", new Date("2026-12-01T00:00:00Z"));
    expect(d.toISOString().slice(0, 10)).toBe("2027-11-25");
  });

  it("christmas and new_year are fixed dates", () => {
    expect(nextHolidayDate("christmas", new Date("2026-06-01T00:00:00Z")).toISOString().slice(0, 10)).toBe("2026-12-25");
    expect(nextHolidayDate("new_year", new Date("2026-06-01T00:00:00Z")).toISOString().slice(0, 10)).toBe("2027-01-01");
  });
});

describe("roofiversaryDate", () => {
  it("adds whole years to the completion date", () => {
    const d = roofiversaryDate(new Date("2026-03-10T17:00:00Z"), 1);
    expect(d.toISOString().slice(0, 10)).toBe("2027-03-10");
  });

  it("a Feb 29 roof celebrates Feb 28 in non-leap years", () => {
    const d = roofiversaryDate(new Date("2024-02-29T12:00:00Z"), 1);
    expect(d.toISOString().slice(0, 10)).toBe("2025-02-28");
  });
});
