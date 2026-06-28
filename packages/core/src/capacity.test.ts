import { describe, expect, it } from "vitest";
import { parseSchedulingConfig } from "./scheduling";
import { officeMinutesForWindow, overlapMinutes, buildCapacityView } from "./capacity";

describe("officeMinutesForWindow", () => {
  const cfg = parseSchedulingConfig(undefined); // Mon–Fri 8–17 (540 min/day), weekends closed

  it("sums weekday office minutes and ignores weekends", () => {
    // 2026-06-29 is a Monday → Mon..Sun = 5 weekdays
    const dates = ["2026-06-29", "2026-06-30", "2026-07-01", "2026-07-02", "2026-07-03", "2026-07-04", "2026-07-05"];
    expect(officeMinutesForWindow(cfg, dates)).toBe(5 * 540);
  });

  it("any 7-day window has exactly 5 weekdays (Wed start)", () => {
    const dates = ["2026-07-01", "2026-07-02", "2026-07-03", "2026-07-04", "2026-07-05", "2026-07-06", "2026-07-07"];
    expect(officeMinutesForWindow(cfg, dates)).toBe(5 * 540);
  });

  it("respects custom hours", () => {
    const c = parseSchedulingConfig({ hours: { mon: [9, 12], tue: [], wed: [9, 12], thu: [], fri: [], sat: [], sun: [] } });
    expect(officeMinutesForWindow(c, ["2026-06-29", "2026-06-30", "2026-07-01"])).toBe(2 * 180); // Mon+Wed only
  });
});

describe("overlapMinutes", () => {
  const w0 = new Date("2026-06-29T00:00:00Z");
  const w1 = new Date("2026-07-06T00:00:00Z");
  it("clamps the interval to the window", () => {
    expect(overlapMinutes(new Date("2026-06-30T10:00:00Z"), new Date("2026-06-30T14:00:00Z"), w0, w1)).toBe(240);
  });
  it("is 0 for a non-overlapping interval", () => {
    expect(overlapMinutes(new Date("2026-07-10T00:00:00Z"), new Date("2026-07-11T00:00:00Z"), w0, w1)).toBe(0);
  });
  it("clamps a partially-outside interval", () => {
    expect(overlapMinutes(new Date("2026-06-28T22:00:00Z"), new Date("2026-06-29T02:00:00Z"), w0, w1)).toBe(120);
  });
});

describe("buildCapacityView", () => {
  const office = 2700; // 5 × 540
  it("computes utilization and status per rep, sorted most-loaded first", () => {
    const v = buildCapacityView({
      officeMinutesInWindow: office,
      windowDays: 7,
      reps: [
        { userId: "free", name: "Free", scheduledMin: 0, blockedMin: 0, apptCount: 0 },
        { userId: "over", name: "Over", scheduledMin: 3000, blockedMin: 0, apptCount: 6 },
        { userId: "ok", name: "Ok", scheduledMin: 540, blockedMin: 0, apptCount: 1 },
      ],
    });
    expect(v.reps.map((r) => r.userId)).toEqual(["over", "ok", "free"]);
    expect(v.reps.find((r) => r.userId === "over")!).toMatchObject({ utilizationPct: 111, status: "over", availableMin: 2700 });
    expect(v.reps.find((r) => r.userId === "ok")!).toMatchObject({ utilizationPct: 20, status: "ok" });
    expect(v.reps.find((r) => r.userId === "free")!).toMatchObject({ utilizationPct: 0, status: "free" });
    expect(v.overCount).toBe(1);
  });

  it("reduces available capacity by blocked minutes", () => {
    const v = buildCapacityView({ officeMinutesInWindow: office, windowDays: 7, reps: [{ userId: "u", name: "U", scheduledMin: 1080, blockedMin: 540, apptCount: 2 }] });
    // available = 2700 − 540 = 2160; 1080/2160 = 50%
    expect(v.reps[0]!).toMatchObject({ availableMin: 2160, utilizationPct: 50, status: "ok" });
  });

  it("flags over when available is 0 but booked > 0", () => {
    const v = buildCapacityView({ officeMinutesInWindow: 0, windowDays: 7, reps: [{ userId: "u", name: "U", scheduledMin: 60, blockedMin: 0, apptCount: 1 }] });
    expect(v.reps[0]!).toMatchObject({ availableMin: 0, utilizationPct: 100, status: "over" });
  });

  it("computes team utilization across reps and is empty-safe", () => {
    expect(buildCapacityView({ officeMinutesInWindow: office, windowDays: 7, reps: [] })).toEqual({ reps: [], teamUtilizationPct: 0, overCount: 0, windowDays: 7 });
  });

  it("marks 80% as high", () => {
    const v = buildCapacityView({ officeMinutesInWindow: office, windowDays: 7, reps: [{ userId: "u", name: "U", scheduledMin: 2160, blockedMin: 0, apptCount: 4 }] });
    expect(v.reps[0]!).toMatchObject({ utilizationPct: 80, status: "high" });
  });
});
