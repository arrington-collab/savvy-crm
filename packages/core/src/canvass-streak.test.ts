import { describe, expect, it } from "vitest";
import { currentStreak, bestStreak } from "./canvass-streak";

// Phoenix = UTC-7. A knock at 15:00Z is 08:00 local same day.
const at = (isoLocalDate: string) => new Date(`${isoLocalDate}T15:00:00Z`);
const TZ = "America/Phoenix";
const NOW = new Date("2026-07-12T15:00:00Z"); // local 2026-07-12

describe("currentStreak", () => {
  it("counts consecutive local days ending today", () => {
    expect(currentStreak([at("2026-07-12"), at("2026-07-11"), at("2026-07-10")], TZ, NOW)).toBe(3);
  });
  it("still counts if the last knock was yesterday (grace, not yet knocked today)", () => {
    expect(currentStreak([at("2026-07-11"), at("2026-07-10")], TZ, NOW)).toBe(2);
  });
  it("is 0 when the last knock is older than yesterday", () => {
    expect(currentStreak([at("2026-07-09")], TZ, NOW)).toBe(0);
  });
  it("is 0 for no knocks", () => {
    expect(currentStreak([], TZ, NOW)).toBe(0);
  });
});

describe("bestStreak", () => {
  it("returns the longest run of consecutive local days", () => {
    const times = [at("2026-07-01"), at("2026-07-02"), at("2026-07-03"), at("2026-07-06"), at("2026-07-07")];
    expect(bestStreak(times, TZ)).toBe(3);
  });
});
