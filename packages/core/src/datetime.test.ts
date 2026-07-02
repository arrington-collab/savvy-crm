import { describe, it, expect } from "vitest";
import { formatSlotLabel } from "./datetime";

// Dates are built in UTC and formatted in a fixed IANA zone (America/Phoenix,
// UTC-7, no DST) so the assertions are byte-identical in any runner timezone —
// the same property that makes the output hydration-safe in the browser.
const TZ = "America/Phoenix";
describe("formatSlotLabel", () => {
  it("labels a slot later today as Today + 12h time without seconds", () => {
    const now = new Date("2026-06-30T16:00:00Z"); // 9:00 AM Phoenix, Tue Jun 30
    const start = new Date("2026-06-30T21:00:00Z"); // 2:00 PM Phoenix same day
    expect(formatSlotLabel(start, now, TZ)).toBe("Today, 2:00 PM");
  });

  it("labels the next calendar day as Tomorrow", () => {
    const now = new Date("2026-06-30T16:00:00Z"); // 9:00 AM Phoenix Jun 30
    const start = new Date("2026-07-01T15:00:00Z"); // 8:00 AM Phoenix Jul 1
    expect(formatSlotLabel(start, now, TZ)).toBe("Tomorrow, 8:00 AM");
  });

  it("labels further-out slots with weekday + month + day", () => {
    const now = new Date("2026-06-30T16:00:00Z"); // Tue Jun 30 Phoenix
    const start = new Date("2026-07-02T16:30:00Z"); // Thu Jul 2, 9:30 AM Phoenix
    expect(formatSlotLabel(start, now, TZ)).toBe("Thu, Jul 2, 9:30 AM");
  });

  it("pads minutes to two digits", () => {
    const now = new Date("2026-06-30T16:00:00Z");
    const start = new Date("2026-06-30T21:05:00Z"); // 2:05 PM Phoenix
    expect(formatSlotLabel(start, now, TZ)).toBe("Today, 2:05 PM");
  });

  it("is timezone-explicit: same instant renders in the given zone, not the ambient one", () => {
    const now = new Date("2026-06-30T16:00:00Z");
    const start = new Date("2026-07-01T04:30:00Z"); // 9:30 PM Phoenix Jun 30 (still 'Today')
    expect(formatSlotLabel(start, now, TZ)).toBe("Today, 9:30 PM");
  });
});
