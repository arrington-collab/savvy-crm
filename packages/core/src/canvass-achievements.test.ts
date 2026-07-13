import { describe, expect, it } from "vitest";
import { evaluateAchievements } from "./canvass-achievements";

const TZ = "America/Phoenix";
const NOW = new Date("2026-07-12T20:00:00Z");
const mk = (over: Partial<{ outcome: string; amount: number; at: Date }> = {}) => ({
  outcome: "noanswer",
  at: new Date("2026-07-10T18:00:00Z"),
  ...over,
});

describe("evaluateAchievements", () => {
  it("awards first_sale on the first sale", () => {
    expect(evaluateAchievements({ knocks: [mk(), mk({ outcome: "sale", amount: 1000 })], tz: TZ, now: NOW })).toContain("first_sale");
    expect(evaluateAchievements({ knocks: [mk()], tz: TZ, now: NOW })).not.toContain("first_sale");
  });
  it("awards doors_100 at 100 lifetime doors", () => {
    const knocks = Array.from({ length: 100 }, () => mk());
    expect(evaluateAchievements({ knocks, tz: TZ, now: NOW })).toContain("doors_100");
    expect(evaluateAchievements({ knocks: knocks.slice(0, 99), tz: TZ, now: NOW })).not.toContain("doors_100");
  });
  it("awards hot_hand for 10 doors within a 60-minute window", () => {
    const base = Date.parse("2026-07-10T18:00:00Z");
    const knocks = Array.from({ length: 10 }, (_, i) => mk({ at: new Date(base + i * 5 * 60000) })); // 5 min apart = 45 min span
    expect(evaluateAchievements({ knocks, tz: TZ, now: NOW })).toContain("hot_hand");
  });
  it("awards early_bird for a knock before 8am local", () => {
    // 14:00Z = 07:00 Phoenix
    expect(evaluateAchievements({ knocks: [mk({ at: new Date("2026-07-10T14:00:00Z") })], tz: TZ, now: NOW })).toContain("early_bird");
    // 16:00Z = 09:00 Phoenix
    expect(evaluateAchievements({ knocks: [mk({ at: new Date("2026-07-10T16:00:00Z") })], tz: TZ, now: NOW })).not.toContain("early_bird");
  });
  it("awards rainmaker for >= $25k sales in one local day", () => {
    const knocks = [mk({ outcome: "sale", amount: 15000, at: new Date("2026-07-10T18:00:00Z") }), mk({ outcome: "sale", amount: 12000, at: new Date("2026-07-10T20:00:00Z") })];
    expect(evaluateAchievements({ knocks, tz: TZ, now: NOW })).toContain("rainmaker");
  });
});
