import { test, expect } from "vitest";
import { hourInTimeZone } from "./tz";

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
