import { it, expect } from "vitest";
import { denverDayWindow, businessDateOf } from "./day-window";

it("businessDateOf buckets a late-night MT instant into the correct Denver day", () => {
  // 2026-07-02 04:30 UTC = 2026-07-01 22:30 MDT → belongs to 2026-07-01
  expect(businessDateOf("2026-07-02T04:30:00Z")).toBe("2026-07-01");
  // 2026-07-02 07:00 UTC = 2026-07-02 01:00 MDT → belongs to 2026-07-02
  expect(businessDateOf("2026-07-02T07:00:00Z")).toBe("2026-07-02");
});

it("denverDayWindow returns a 24h UTC window for a summer (MDT, -6) date", () => {
  const { startUtc, endUtc } = denverDayWindow("2026-07-01");
  expect(startUtc.toISOString()).toBe("2026-07-01T06:00:00.000Z"); // 00:00 MDT
  expect(endUtc.toISOString()).toBe("2026-07-02T06:00:00.000Z");
});

it("an instant inside the window buckets to that date; the window is half-open", () => {
  const { startUtc, endUtc } = denverDayWindow("2026-07-01");
  expect(businessDateOf(startUtc)).toBe("2026-07-01");
  expect(businessDateOf(new Date(endUtc.getTime() - 1))).toBe("2026-07-01");
  expect(businessDateOf(endUtc)).toBe("2026-07-02"); // end is exclusive
});
