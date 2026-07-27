import { test, expect, describe, it } from "vitest";
import { hourInTimeZone, tenantsDueAtHour, dayOfMonthInTimeZone, isoWeekdayInTimeZone, priorMonthKeyInTimeZone, instantAtLocalHourOnDayOf, instantAtLocalTimeOnDate, addCalendarDays, startOfLocalDayInTimeZone, dateKeyInTimeZone } from "./tz";

describe("addCalendarDays", () => {
  it("adds days with month + year wrap and negative steps", () => {
    expect(addCalendarDays("2026-07-15", 1)).toBe("2026-07-16");
    expect(addCalendarDays("2026-07-31", 1)).toBe("2026-08-01");
    expect(addCalendarDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addCalendarDays("2026-03-01", -1)).toBe("2026-02-28");
  });
});

describe("startOfLocalDayInTimeZone", () => {
  it("returns the UTC instant of local midnight (Phoenix, UTC-7)", () => {
    expect(startOfLocalDayInTimeZone("2026-07-15", "America/Phoenix").toISOString()).toBe("2026-07-15T07:00:00.000Z");
  });
  it("is DST-correct (New York, summer UTC-4)", () => {
    expect(startOfLocalDayInTimeZone("2026-07-15", "America/New_York").toISOString()).toBe("2026-07-15T04:00:00.000Z");
  });
});

// Phoenix is UTC-7 year-round (no DST); Denver is UTC-6 in July (MDT).
test("returns the local hour (0-23) for the given IANA zone", () => {
  const noonUtc = new Date("2026-07-02T11:00:00Z");
  expect(hourInTimeZone(noonUtc, "America/Phoenix")).toBe(4); // 11:00Z - 7 = 04:00
  expect(hourInTimeZone(noonUtc, "America/Denver")).toBe(5); // 11:00Z - 6 (MDT) = 05:00
});

test("normalizes midnight to 0, not 24", () => {
  const midnightPhx = new Date("2026-07-02T07:00:00Z"); // 00:00 in Phoenix
  expect(hourInTimeZone(midnightPhx, "America/Phoenix")).toBe(0);
});

test("tenantsDueAtHour selects only tenants whose local hour matches (one hourly tick)", () => {
  const noonUtc = new Date("2026-07-02T11:00:00Z"); // 04:00 Phoenix, 05:00 Denver
  const tenants = [
    { id: "a", timezone: "America/Phoenix" },
    { id: "b", timezone: "America/Denver" },
    { id: "c", timezone: "America/Phoenix" },
  ];
  expect(tenantsDueAtHour(tenants, noonUtc, 4).map((t) => t.id)).toEqual(["a", "c"]);
  expect(tenantsDueAtHour(tenants, noonUtc, 5).map((t) => t.id)).toEqual(["b"]);
  expect(tenantsDueAtHour(tenants, noonUtc, 3)).toEqual([]);
});

test("dayOfMonthInTimeZone returns the local day, respecting the midnight boundary", () => {
  expect(dayOfMonthInTimeZone(new Date("2026-07-01T13:00:00Z"), "America/Phoenix")).toBe(1); // 06:00 Jul 1 local
  expect(dayOfMonthInTimeZone(new Date("2026-07-01T06:00:00Z"), "America/Phoenix")).toBe(30); // 23:00 Jun 30 local
});

describe("isoWeekdayInTimeZone", () => {
  it("returns the ISO weekday (1=Mon..7=Sun) for the given IANA zone", () => {
    // 2026-07-06 is a Monday; 13:00Z is 06:00 Phoenix (UTC-7), same local day.
    expect(isoWeekdayInTimeZone(new Date("2026-07-06T13:00:00Z"), "America/Phoenix")).toBe(1);
    // 2026-07-05 is a Sunday.
    expect(isoWeekdayInTimeZone(new Date("2026-07-05T13:00:00Z"), "America/Phoenix")).toBe(7);
  });

  it("respects the local-day boundary, not the UTC day", () => {
    // 05:00Z Monday July 6 is still 22:00 Sunday July 5 in Phoenix (UTC-7).
    expect(isoWeekdayInTimeZone(new Date("2026-07-06T05:00:00Z"), "America/Phoenix")).toBe(7);
  });
});

test("priorMonthKeyInTimeZone keys off the tenant's LOCAL month, not UTC", () => {
  expect(priorMonthKeyInTimeZone(new Date("2026-07-01T13:00:00Z"), "America/Phoenix")).toBe("2026-06"); // local July -> prior June
  expect(priorMonthKeyInTimeZone(new Date("2026-01-01T13:00:00Z"), "America/Phoenix")).toBe("2025-12"); // year wrap
  expect(priorMonthKeyInTimeZone(new Date("2026-07-01T02:00:00Z"), "America/Phoenix")).toBe("2026-05"); // UTC=July but local=Jun 30 -> prior May
});

describe("instantAtLocalHourOnDayOf", () => {
  it("returns the instant at the given local hour on the anchor's local day", () => {
    // 2026-07-15 15:00 UTC == 08:00 Phoenix (UTC-7), same local day.
    const anchor = new Date("2026-07-15T15:00:00Z");
    const r = instantAtLocalHourOnDayOf(anchor, "America/Phoenix", 18);
    expect(hourInTimeZone(r, "America/Phoenix")).toBe(18);
    expect(r.toISOString()).toBe("2026-07-16T01:00:00.000Z"); // 18:00 Phoenix == 01:00Z next day
  });

  it("resolves the local day from the timezone, not UTC", () => {
    // 2026-07-16 03:00 UTC is still 2026-07-15 20:00 Phoenix → local day is the 15th.
    const anchor = new Date("2026-07-16T03:00:00Z");
    const r = instantAtLocalHourOnDayOf(anchor, "America/Phoenix", 7);
    expect(hourInTimeZone(r, "America/Phoenix")).toBe(7);
    expect(r.toISOString()).toBe("2026-07-15T14:00:00.000Z"); // 07:00 Phoenix == 14:00Z, the 15th
  });

  it("handles a DST timezone (America/New_York, summer = UTC-4)", () => {
    const anchor = new Date("2026-07-15T12:00:00Z"); // 08:00 EDT
    const r = instantAtLocalHourOnDayOf(anchor, "America/New_York", 18);
    expect(hourInTimeZone(r, "America/New_York")).toBe(18);
    expect(r.toISOString()).toBe("2026-07-15T22:00:00.000Z"); // 18:00 EDT == 22:00Z
  });
});

it("places the source wall-clock time onto a different calendar day", () => {
  const tz = "America/Phoenix";
  // A source instant whose Phoenix wall-clock time is 09:30 on 2026-07-06.
  const source = instantAtLocalTimeOnDate("2026-07-06", new Date("2026-01-01T16:30:00Z"), tz);
  const moved = instantAtLocalTimeOnDate("2026-07-13", source, tz);
  // moved must read 09:30 local on 2026-07-13
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(moved);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  expect(`${get("year")}-${get("month")}-${get("day")}`).toBe("2026-07-13");
  expect(`${get("hour")}:${get("minute")}`).toBe("09:30");
});

describe("dateKeyInTimeZone", () => {
  it("returns the LOCAL calendar day, not the UTC day (the EOD report bug)", () => {
    // 01:30 UTC = 6:30 PM the PREVIOUS day in Phoenix (UTC-7)
    const lateEveningPhx = new Date("2026-07-12T01:30:00Z");
    expect(dateKeyInTimeZone(lateEveningPhx, "America/Phoenix")).toBe("2026-07-11");
    expect(dateKeyInTimeZone(lateEveningPhx, "UTC")).toBe("2026-07-12");
    // midday agrees
    expect(dateKeyInTimeZone(new Date("2026-07-09T19:00:00Z"), "America/Phoenix")).toBe("2026-07-09");
  });
});
