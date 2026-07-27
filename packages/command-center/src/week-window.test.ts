import { it, expect } from "vitest";
import { weekStartOf, weekDates, trailingWeekStarts, denverWeekWindow } from "./week-window";

it("weekStartOf returns the same date when given a Monday", () => {
  // 2026-07-27 is a Monday
  expect(weekStartOf("2026-07-27")).toBe("2026-07-27");
});

it("weekStartOf rolls a Sunday back to that week's Monday", () => {
  // 2026-08-02 is the Sunday of the week starting 2026-07-27
  expect(weekStartOf("2026-08-02")).toBe("2026-07-27");
});

it("weekDates returns the 7 consecutive Mon→Sun business-date strings", () => {
  expect(weekDates("2026-07-27")).toEqual([
    "2026-07-27",
    "2026-07-28",
    "2026-07-29",
    "2026-07-30",
    "2026-07-31",
    "2026-08-01",
    "2026-08-02",
  ]);
});

it("trailingWeekStarts returns n Mondays, oldest→newest, 7 days apart, including current", () => {
  const starts = trailingWeekStarts("2026-07-27", 13);
  expect(starts).toHaveLength(13);
  expect(starts[12]).toBe("2026-07-27"); // current week is last (newest)
  expect(starts[0]).toBe("2026-05-04"); // 12 weeks earlier
  for (let i = 1; i < starts.length; i++) {
    const prev = new Date(`${starts[i - 1]}T12:00:00Z`);
    const cur = new Date(`${starts[i]}T12:00:00Z`);
    expect(cur.getTime() - prev.getTime()).toBe(7 * 24 * 60 * 60 * 1000);
  }
});

it("trailingWeekStarts defaults n to 13", () => {
  expect(trailingWeekStarts("2026-07-27")).toHaveLength(13);
});

it("denverWeekWindow returns Mon 00:00 -> Sun 24:00 Denver for a normal (non-DST-boundary) week", () => {
  const { startUtc, endUtc } = denverWeekWindow("2026-07-27"); // all MDT (-6)
  expect(startUtc.toISOString()).toBe("2026-07-27T06:00:00.000Z");
  expect(endUtc.toISOString()).toBe("2026-08-03T06:00:00.000Z");
  // 7 full 24h days = 168 hours when there's no DST transition inside the week.
  expect(endUtc.getTime() - startUtc.getTime()).toBe(168 * 60 * 60 * 1000);
});

it("denverWeekWindow is DST-safe: the week spanning the Nov fall-back is 169 hours, not 168", () => {
  // US DST ends 2026-11-01 (first Sunday of November) at 2:00 AM MDT -> 1:00 AM MST.
  // The week Mon 2026-10-26 -> Sun 2026-11-01 contains that 25-hour Sunday.
  const { startUtc, endUtc } = denverWeekWindow("2026-10-26");
  // Monday 00:00 MDT (-6) = 06:00 UTC.
  expect(startUtc.toISOString()).toBe("2026-10-26T06:00:00.000Z");
  // Sunday 24:00 MST (-7) = following Monday 07:00 UTC.
  expect(endUtc.toISOString()).toBe("2026-11-02T07:00:00.000Z");
  const hours = (endUtc.getTime() - startUtc.getTime()) / (60 * 60 * 1000);
  expect(hours).toBe(169);
  expect(hours).not.toBe(168);
});
