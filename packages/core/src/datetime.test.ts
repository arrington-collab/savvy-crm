import { describe, it, expect } from "vitest";
import { formatSlotLabel } from "./datetime";

// Dates are built with the local Date constructor so the assertions hold in any
// runner timezone (now + start share the same local frame of reference).
describe("formatSlotLabel", () => {
  it("labels a slot later today as Today + 12h time without seconds", () => {
    const now = new Date(2026, 5, 30, 9, 0); // Tue Jun 30 2026, 9:00 AM
    const start = new Date(2026, 5, 30, 14, 0); // 2:00 PM same day
    expect(formatSlotLabel(start, now)).toBe("Today, 2:00 PM");
  });

  it("labels the next calendar day as Tomorrow", () => {
    const now = new Date(2026, 5, 30, 9, 0);
    const start = new Date(2026, 6, 1, 8, 0); // Jul 1, 8:00 AM
    expect(formatSlotLabel(start, now)).toBe("Tomorrow, 8:00 AM");
  });

  it("labels further-out slots with weekday + month + day", () => {
    const now = new Date(2026, 5, 30, 9, 0); // Tue Jun 30
    const start = new Date(2026, 6, 2, 9, 30); // Thu Jul 2, 9:30 AM
    expect(formatSlotLabel(start, now)).toBe("Thu, Jul 2, 9:30 AM");
  });

  it("pads minutes to two digits", () => {
    const now = new Date(2026, 5, 30, 9, 0);
    const start = new Date(2026, 5, 30, 14, 5);
    expect(formatSlotLabel(start, now)).toBe("Today, 2:05 PM");
  });
});
