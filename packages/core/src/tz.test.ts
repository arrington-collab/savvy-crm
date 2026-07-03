import { test, expect } from "vitest";
import { hourInTimeZone, tenantsDueAtHour, dayOfMonthInTimeZone, priorMonthKeyInTimeZone } from "./tz";

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

test("priorMonthKeyInTimeZone keys off the tenant's LOCAL month, not UTC", () => {
  expect(priorMonthKeyInTimeZone(new Date("2026-07-01T13:00:00Z"), "America/Phoenix")).toBe("2026-06"); // local July -> prior June
  expect(priorMonthKeyInTimeZone(new Date("2026-01-01T13:00:00Z"), "America/Phoenix")).toBe("2025-12"); // year wrap
  expect(priorMonthKeyInTimeZone(new Date("2026-07-01T02:00:00Z"), "America/Phoenix")).toBe("2026-05"); // UTC=July but local=Jun 30 -> prior May
});
