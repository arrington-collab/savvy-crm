import { describe, it, expect } from "vitest";
import { isWithinQuietHours, nextAllowedSendTime } from "./quiet-hours";

const QH = { startHour: 21, endHour: 8 }; // quiet 21:00–08:00 local

describe("isWithinQuietHours", () => {
  it("is quiet at 23:00 and 06:00, awake at noon", () => {
    expect(isWithinQuietHours(new Date("2026-06-10T23:00:00-07:00"), "America/Phoenix", QH)).toBe(true);
    expect(isWithinQuietHours(new Date("2026-06-10T06:00:00-07:00"), "America/Phoenix", QH)).toBe(true);
    expect(isWithinQuietHours(new Date("2026-06-10T12:00:00-07:00"), "America/Phoenix", QH)).toBe(false);
  });

  it("nextAllowedSendTime returns input when already awake", () => {
    const t = new Date("2026-06-10T12:00:00-07:00");
    expect(nextAllowedSendTime(t, "America/Phoenix", QH).getTime()).toBe(t.getTime());
  });

  it("nextAllowedSendTime jumps past quiet hours", () => {
    const t = new Date("2026-06-10T23:00:00-07:00");
    const next = nextAllowedSendTime(t, "America/Phoenix", QH);
    expect(isWithinQuietHours(next, "America/Phoenix", QH)).toBe(false);
    expect(next.getTime()).toBeGreaterThan(t.getTime());
  });
});
