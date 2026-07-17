import { describe, expect, it } from "vitest";
import { detectCrewGapWindows } from "./fill-gaps";
import type { SchedulingConfig } from "./scheduling";

// Mon-Fri 8-17 (540 min/day), weekend off.
const config = {
  hours: { mon: [8, 17], tue: [8, 17], wed: [8, 17], thu: [8, 17], fri: [8, 17], sat: null, sun: null },
} as unknown as SchedulingConfig;

// 2026-07-20 is a Monday.
const WEEK = ["2026-07-20", "2026-07-21", "2026-07-22", "2026-07-23", "2026-07-24"];
const crews = [{ crewId: "crew-1", name: "Alpha" }];

function loads(perDay: Record<string, number>) {
  return Object.entries(perDay).map(([civilDate, scheduledMin]) => ({
    crewId: "crew-1", name: "Alpha", civilDate, scheduledMin,
  }));
}

describe("detectCrewGapWindows", () => {
  it("fully booked crew has no gaps", () => {
    const gaps = detectCrewGapWindows({
      config, civilDates: WEEK, crews, minUtilizationPct: 60,
      loads: loads(Object.fromEntries(WEEK.map((d) => [d, 540]))),
    });
    expect(gaps).toEqual([]);
  });

  it("SPEC RED PATH: a crew with zero appointments is one gap spanning the whole window", () => {
    const gaps = detectCrewGapWindows({
      config, civilDates: WEEK, crews, minUtilizationPct: 60, loads: [],
    });
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({
      crewId: "crew-1", gapStart: "2026-07-20", gapEnd: "2026-07-24", freeMinutes: 2700,
    });
  });

  it("merges consecutive under-utilized workdays into one gap with summed free minutes", () => {
    // Wed+Thu at 50% (270/540) — under the 60% floor; rest fully booked.
    const gaps = detectCrewGapWindows({
      config, civilDates: WEEK, crews, minUtilizationPct: 60,
      loads: loads({ "2026-07-20": 540, "2026-07-21": 540, "2026-07-22": 270, "2026-07-23": 270, "2026-07-24": 540 }),
    });
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ gapStart: "2026-07-22", gapEnd: "2026-07-23", freeMinutes: 540 });
  });

  it("separate holes are separate gaps", () => {
    const gaps = detectCrewGapWindows({
      config, civilDates: WEEK, crews, minUtilizationPct: 60,
      loads: loads({ "2026-07-20": 0, "2026-07-21": 540, "2026-07-22": 540, "2026-07-23": 540, "2026-07-24": 0 }),
    });
    expect(gaps.map((g) => [g.gapStart, g.gapEnd])).toEqual([
      ["2026-07-20", "2026-07-20"],
      ["2026-07-24", "2026-07-24"],
    ]);
  });

  it("a weekend between under-utilized workdays neither creates nor splits a gap", () => {
    // Fri 7/24 and Mon 7/27 both idle with the weekend between: one contiguous gap.
    const dates = ["2026-07-24", "2026-07-25", "2026-07-26", "2026-07-27"];
    const gaps = detectCrewGapWindows({
      config, civilDates: dates, crews, minUtilizationPct: 60, loads: [],
    });
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ gapStart: "2026-07-24", gapEnd: "2026-07-27", freeMinutes: 1080 });
  });

  it("a day at exactly the utilization floor is not a gap", () => {
    // 60% of 540 = 324.
    const gaps = detectCrewGapWindows({
      config, civilDates: ["2026-07-20"], crews, minUtilizationPct: 60,
      loads: loads({ "2026-07-20": 324 }),
    });
    expect(gaps).toEqual([]);
  });
});
